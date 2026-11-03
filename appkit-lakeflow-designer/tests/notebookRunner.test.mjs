import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsdown';

let exportedModelToRunPayload;
let matchRunOutputs;
let parseRunOutcome;
let parseAppManifest;
let isPublishedRunner;
let outputDirectory;

before(async () => {
  outputDirectory = await mkdtemp(fileURLToPath(new URL('../.notebook-runner-tests-', import.meta.url)));
  await build({
    entry: {
      exportedRunOutput: 'server/exportedRunOutput.ts',
      runOutputs: 'server/runOutputs.ts',
      payload: 'client/src/payload.ts',
      appConfig: 'client/src/appConfig.ts',
      publishedRunner: 'shared/publishedRunner.ts',
    },
    config: false,
    tsconfig: 'tsconfig.client.json',
    outDir: outputDirectory,
    outExtensions: () => ({ js: '.mjs' }),
    logLevel: 'silent',
  });
  const load = (name) => import(pathToFileURL(join(outputDirectory, `${name}.mjs`)).href);
  ({ exportedModelToRunPayload } = await load('exportedRunOutput'));
  ({ matchRunOutputs } = await load('runOutputs'));
  ({ parseRunOutcome } = await load('payload'));
  ({ parseAppManifest } = await load('appConfig'));
  ({ isPublishedRunner } = await load('publishedRunner'));
});

after(async () => {
  if (outputDirectory !== undefined) await rm(outputDirectory, { recursive: true });
});

function notebookHtml(commands) {
  const model = Buffer.from(encodeURIComponent(JSON.stringify({ commands }))).toString('base64');
  return `<script>__DATABRICKS_NOTEBOOK_MODEL = '${model}'</script>`;
}

const listResults = (...data) => ({ type: 'listResults', data });
const table = (rows) => ({
  type: 'table',
  schema: [
    { name: 'month', type: '"string"', nullable: true },
    { name: 'revenue', type: '"double"', nullable: true },
  ],
  data: rows,
  overflow: false,
});
const cell = (nuid, command, results, extra = {}) => ({ nuid, command, results, state: 'finished', ...extra });

// Mirrors a real serverless job run export of a notebook runner: guard cell, markdown, then authored cells.
const RUN_COMMANDS = [
  cell('guard', 'if dbutils.widgets.getAll().get("_lb_runner_revision") != "abc":', listResults()),
  cell('intro', '%md\n# Report', undefined),
  cell('monthly', 'display(monthly)', listResults(table([['2026-01', 10.5], ['2026-02', 20]]))),
  cell(
    'two-tables',
    'display(a)\ndisplay(b)',
    listResults(table([['2026-01', 1]]), table([['2026-02', 2], ['2026-03', 3]]))
  ),
  cell('card', 'displayHTML(card)', listResults({ type: 'mimeBundle', data: { 'text/html': '<h3>East</h3>' } })),
  cell(
    'chart',
    'plt.show()',
    listResults({ type: 'mimeBundle', data: { 'text/plain': '<Figure>', 'image/png': 'iVBORw0KGgo=' } })
  ),
  cell('log', 'print(summary)', listResults({ type: 'ansi', name: 'stdout', data: '\u001b[31m3 orders\u001b[0m <b>\n' })),
  cell('scratch', 'display(orders.limit(5))', listResults(table([['secret', 0]]))),
];

const BLOCKS = [
  { type: 'output', id: 'monthly_table-0', label: 'Monthly revenue', nodeId: 'monthly', port: 'table-0' },
  { type: 'output', id: 'second', label: 'Second table', nodeId: 'two-tables', port: 'table-1' },
  { type: 'output', id: 'card_html', label: 'Summary card', nodeId: 'card', kind: 'html' },
  { type: 'output', id: 'chart_html', label: 'Revenue chart', nodeId: 'chart', kind: 'html' },
  { type: 'output', id: 'log_html', label: 'Run log', nodeId: 'log', kind: 'html' },
];

function matchedNotebookOutputs(blocks, commands) {
  return parseRunOutcome(
    matchRunOutputs(blocks, exportedModelToRunPayload(notebookHtml(commands), [], { runnerKind: 'notebook' }))
  );
}

test('notebook runners bind tables, HTML, images and printed text to cells by nuid', () => {
  const result = matchedNotebookOutputs(BLOCKS, RUN_COMMANDS);
  assert.equal(result.outcome, 'outputs');
  const [monthly, second, card, chart, log] = result.outputs;
  assert.deepEqual(
    monthly.outcome.payload.rows,
    [
      { month: '2026-01', revenue: 10.5 },
      { month: '2026-02', revenue: 20 },
    ]
  );
  assert.equal(monthly.outcome.payload.total_row_count, 2);
  assert.deepEqual(second.outcome.payload.rows, [
    { month: '2026-02', revenue: 2 },
    { month: '2026-03', revenue: 3 },
  ]);
  assert.deepEqual(card.outcome, { outcome: 'html', html: '<h3>East</h3>' });
  assert.match(chart.outcome.html, /^<img alt="" style="max-width: 100%" src="data:image\/png;base64,iVBORw0KGgo=">$/);
  assert.equal(log.outcome.outcome, 'html');
  assert.match(log.outcome.html, /3 orders &lt;b&gt;/);
  assert.doesNotMatch(log.outcome.html, /\u001b|<b>/);
});

test('notebook cells outside the manifest stay private', () => {
  const payload = JSON.parse(exportedModelToRunPayload(notebookHtml(RUN_COMMANDS), [], { runnerKind: 'notebook' }));
  assert.ok(payload.outputs.some((output) => output.target_node === 'scratch'));
  const result = matchedNotebookOutputs(BLOCKS, RUN_COMMANDS);
  assert.equal(result.outputs.length, BLOCKS.length);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('failed notebook cells surface their error on every block bound to the cell', () => {
  const failed = cell('monthly', 'display(monthly)', { type: 'error', data: 'trace' }, {
    state: 'error',
    errorSummary: '<span class="ansi-red-fg">AnalysisException</span>: [TABLE_OR_VIEW_NOT_FOUND]',
  });
  const result = matchedNotebookOutputs(
    [BLOCKS[0], { type: 'output', id: 'monthly_html', label: 'Monthly page', nodeId: 'monthly', kind: 'html' }],
    [failed]
  );
  for (const output of result.outputs) {
    assert.equal(output.outcome.outcome, 'computeError');
    assert.equal(output.outcome.payload.error.message, 'AnalysisException: [TABLE_OR_VIEW_NOT_FOUND]');
  }
});

test('visualization subcommands and cells without a nuid never bind outputs', () => {
  const result = matchedNotebookOutputs(
    [BLOCKS[0]],
    [
      cell('monthly', 'viz', listResults(table([['sub', 1]])), { parentHierarchy: ['parent-guid'] }),
      cell(undefined, 'display(x)', listResults(table([['none', 1]]))),
    ]
  );
  assert.equal(result.outputs[0].outcome.outcome, 'missing');
});

test('Designer runners keep binding display(ctx[...]) lines, not nuids', () => {
  const commands = [cell('monthly', 'display(ctx["source.data"])', listResults(table([['2026-01', 1]])))];
  const designer = parseRunOutcome(
    matchRunOutputs(
      [
        { type: 'output', id: 'designer', label: 'Rows', nodeId: 'source', port: 'data' },
        BLOCKS[0],
      ],
      exportedModelToRunPayload(notebookHtml(commands))
    )
  );
  assert.equal(designer.outputs[0].outcome.payload.rows.length, 1);
  assert.equal(designer.outputs[1].outcome.outcome, 'missing');
});

test('runner identity depends on the runner kind', () => {
  const runner = { revision: 'a'.repeat(64), parameters: { _lb_runner_revision: 'a'.repeat(64) } };
  const job = (path) => ({
    settings: { tasks: [{ notebook_task: { notebook_path: path, base_parameters: runner.parameters } }] },
  });
  const notebookPath = `/Users/u/.notebook-apps/x/runner-${runner.revision}`;
  const designerPath = `${notebookPath}.designer.py`;
  assert.equal(isPublishedRunner(runner, job(notebookPath), 'notebook'), true);
  assert.equal(isPublishedRunner(runner, job(designerPath), 'notebook'), false);
  assert.equal(isPublishedRunner(runner, job(designerPath)), true);
  assert.equal(isPublishedRunner(runner, job(notebookPath)), false);
});

test('manifests keep a notebook runner kind and reject unknown kinds', () => {
  const manifest = {
    version: 8,
    appName: 'Notebook App',
    blocks: [BLOCKS[0]],
    parameters: [],
  };
  assert.equal(parseAppManifest({ ...manifest, runnerKind: 'notebook' }).runnerKind, 'notebook');
  assert.equal(parseAppManifest(manifest).runnerKind, undefined);
  assert.equal(parseAppManifest({ ...manifest, runnerKind: 'spreadsheet' }), undefined);
});
