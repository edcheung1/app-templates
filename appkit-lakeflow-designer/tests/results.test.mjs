import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'tsdown';

let exportedModelToRunPayload;
let parseRunOutcome;
let ResultFooter;
let ResultGrid;
let outputDirectory;
const ROW_COUNTS_MIME_TYPE = 'application/vnd.databricks.lakeflow-designer.row-counts+json';

before(async () => {
  // Keep React and AppKit resolvable from the generated modules without copying dependencies.
  outputDirectory = await mkdtemp(fileURLToPath(new URL('../.result-tests-', import.meta.url)));
  await build({
    entry: {
      exportedRunOutput: 'server/exportedRunOutput.ts',
      payload: 'client/src/payload.ts',
      ResultFooter: 'client/src/ResultFooter.tsx',
      ResultGrid: 'client/src/ResultGrid.tsx',
    },
    config: false,
    tsconfig: 'tsconfig.client.json',
    // Match the client bundler's tree-shaking instead of loading AppKit's browser-only barrel in Node.
    noExternal: [/^@databricks\/appkit-ui(?:\/|$)/],
    outDir: outputDirectory,
    outExtensions: () => ({ js: '.mjs' }),
    logLevel: 'silent',
  });
  ({ exportedModelToRunPayload } = await import(pathToFileURL(join(outputDirectory, 'exportedRunOutput.mjs')).href));
  ({ parseRunOutcome } = await import(pathToFileURL(join(outputDirectory, 'payload.mjs')).href));
  ({ ResultFooter } = await import(pathToFileURL(join(outputDirectory, 'ResultFooter.mjs')).href));
  ({ ResultGrid } = await import(pathToFileURL(join(outputDirectory, 'ResultGrid.mjs')).href));
});

after(async () => {
  if (outputDirectory !== undefined) await rm(outputDirectory, { recursive: true });
});

function displayTable(rowCount, overflow) {
  return {
    type: 'table',
    schema: [{ name: 'value', type: '"long"', nullable: true }],
    data: Array.from({ length: rowCount }, (_, i) => [i]),
    ...(overflow === undefined ? {} : { overflow }),
  };
}

function rowCounts(node, counts) {
  return { type: 'mimeBundle', data: { [ROW_COUNTS_MIME_TYPE]: { node, counts } } };
}

function notebookHtml(commands) {
  const model = Buffer.from(encodeURIComponent(JSON.stringify({ commands }))).toString('base64');
  return `<script>__DATABRICKS_NOTEBOOK_MODEL = '${model}'</script>`;
}

function outputFromTable(table) {
  const html = notebookHtml([
    { command: 'display(ctx["source_0.data"])', results: { type: 'listResults', data: [table] } },
  ]);
  return JSON.parse(exportedModelToRunPayload(html)).outputs[0];
}

function parsePayload(payload) {
  const result = parseRunOutcome({
    outcome: 'outputs',
    outputs: [{ id: 'output', title: 'Output', outcome: { outcome: 'result', payload } }],
  });
  assert.equal(result.outcome, 'outputs');
  assert.equal(result.outputs[0].outcome.outcome, 'result');
  return result.outputs[0].outcome.payload;
}

function footer(payload) {
  return renderToStaticMarkup(createElement(ResultFooter, { payload }));
}

test('preserves notebook overflow without inventing a full count or a row-limit cause', () => {
  for (const rowCount of [0, 17, 1000, 1500]) {
    const output = outputFromTable(displayTable(rowCount, true));
    assert.equal(output.rows.length, Math.min(rowCount, 1000));
    assert.equal(output.truncated, true);
    assert.equal(output.total_row_count, undefined);
    const payload = parsePayload(output);
    assert.equal(payload.truncated, true);
    assert.equal(payload.total_row_count, undefined);
    const html = footer(payload);
    assert.match(html, /rows shown/);
    assert.match(html, /Truncated/);
    assert.doesNotMatch(html, /Complete result|sample|byte budget| \/ /i);
  }
});

for (const rowCount of [0, 999, 1000, 1001, 1500]) {
  test(`caps a complete ${rowCount}-row export and retains its exact count`, () => {
    const output = outputFromTable(displayTable(rowCount, false));
    assert.equal(output.rows.length, Math.min(rowCount, 1000));
    assert.equal(output.truncated, rowCount > 1000);
    assert.equal(output.total_row_count, rowCount);
    const payload = parsePayload(output);
    assert.equal(payload.total_row_count, rowCount);
    assert.deepEqual(payload.rows, output.rows);
    assert.equal(payload.truncated, rowCount > 1000);
    const html = footer(payload);
    if (rowCount > 1000) {
      assert.ok(html.includes(`1,000 / ${rowCount.toLocaleString()} rows`));
      assert.match(html, /Truncated/);
    } else {
      assert.ok(html.includes(`${rowCount.toLocaleString()} rows`));
      assert.doesNotMatch(html, /Truncated|rows shown/);
    }
    assert.doesNotMatch(html, /Complete result/);
  });
}

test('missing or malformed overflow stays unknown even for an empty or exactly 1,000-row result', () => {
  for (const overflow of [undefined, null, 'false', 'true', 0, 1, {}]) {
    for (const rowCount of [0, 17, 1000]) {
      const payload = parsePayload(outputFromTable(displayTable(rowCount, overflow)));
      assert.equal(payload.truncated, null);
      assert.equal(payload.total_row_count, undefined);
      const html = footer(payload);
      assert.match(html, /rows shown/);
      assert.doesNotMatch(html, /Truncated|Complete result| \/ /);
    }
  }
});

test('the app cap proves truncation but not a total when source completeness is unknown', () => {
  const payload = parsePayload(outputFromTable(displayTable(1001)));
  assert.equal(payload.rows.length, 1000);
  assert.equal(payload.truncated, true);
  assert.equal(payload.total_row_count, undefined);
});

test('keeps overflow and counts isolated per displayed port, including encoded exports', () => {
  const html = notebookHtml([
    {
      command: 'display(ctx["filter.filtered_data"])\ndisplay(ctx["filter.excluded_data"])',
      results: { data: [displayTable(990, false), displayTable(1000, true)] },
    },
    { command: 'display(ctx["viz.data"])', results: { data: [displayTable(12, false)] } },
  ]);
  const plain = exportedModelToRunPayload(html);
  assert.equal(exportedModelToRunPayload(Buffer.from(html).toString('base64')), plain);
  assert.deepEqual(
    JSON.parse(plain).outputs.map(({ target_node, target_port, rows, truncated, total_row_count }) => ({
      target_node, target_port, rows: rows.length, truncated, total_row_count,
    })),
    [
      { target_node: 'filter', target_port: 'filtered_data', rows: 990, truncated: false, total_row_count: 990 },
      { target_node: 'filter', target_port: 'excluded_data', rows: 1000, truncated: true, total_row_count: undefined },
      { target_node: 'viz', target_port: 'data', rows: 12, truncated: false, total_row_count: 12 },
    ],
  );
});

test('invalid notebook exports remain unreadable instead of fabricating an empty complete result', () => {
  for (const html of [undefined, null, '', '<html>not a notebook</html>', "__DATABRICKS_NOTEBOOK_MODEL = 'invalid'"]) {
    assert.equal(exportedModelToRunPayload(html), undefined);
  }
});

test('client also caps oversized payloads before rendering a table or feeding a chart', () => {
  const raw = outputFromTable(displayTable(1, false));
  raw.rows = Array.from({ length: 1500 }, (_, value) => ({ value }));
  delete raw.total_row_count;
  const payload = parsePayload(raw);
  assert.equal(raw.rows.length, 1500, 'parsing must not mutate the response');
  assert.equal(payload.rows.length, 1000);
  assert.equal(payload.truncated, true);
  assert.equal(payload.total_row_count, 1500);
  assert.deepEqual(payload.rows.at(-1), { value: 999 });
  const grid = renderToStaticMarkup(createElement(ResultGrid, { payload }));
  assert.equal((grid.match(/<tr[ >]/g) ?? []).length, 1001, 'one header and at most 1,000 data rows');
});

test('renders a separately supplied exact total without downloading those rows', () => {
  const payload = parsePayload({ ...outputFromTable(displayTable(1000, true)), total_row_count: 558837 });
  assert.equal(payload.rows.length, 1000);
  assert.equal(payload.total_row_count, 558837);
  assert.match(footer(payload), /1,000 \/ 558,837 rows/);
});

test('reads exact per-port totals from the runner count metadata without shifting table results', () => {
  const html = notebookHtml([
    {
      command: 'display(ctx["filter.filtered_data"])\ndisplay(ctx["filter.excluded_data"])',
      results: {
        data: [
          rowCounts('filter', { filtered_data: 558837, excluded_data: 12 }),
          displayTable(1000, true),
          displayTable(12, false),
        ],
      },
    },
  ]);

  const outputs = JSON.parse(exportedModelToRunPayload(html)).outputs;
  assert.deepEqual(
    outputs.map(({ target_port, rows, total_row_count }) => ({
      target_port,
      rows: rows.length,
      total_row_count,
    })),
    [
      { target_port: 'filtered_data', rows: 1000, total_row_count: 558837 },
      { target_port: 'excluded_data', rows: 12, total_row_count: 12 },
    ],
  );
  assert.match(footer(parsePayload(outputs[0])), /1,000 \/ 558,837 rows/);
});

test('ignores malformed count metadata and preserves the preview completeness signal', () => {
  for (const marker of [
    rowCounts('', { data: 50 }),
    rowCounts('source_0', {}),
    rowCounts('source_0', { data: -1 }),
    rowCounts('source_0', { data: 1.5 }),
    rowCounts('source_0', { data: '50' }),
  ]) {
    const html = notebookHtml([
      {
        command: 'display(ctx["source_0.data"])',
        results: { data: [displayTable(10, true), marker] },
      },
    ]);
    const output = JSON.parse(exportedModelToRunPayload(html)).outputs[0];
    assert.equal(output.total_row_count, undefined);
    assert.equal(output.truncated, true);
  }
});

test('rejects impossible or unsafe totals instead of labeling a truncated preview as complete', () => {
  for (const total of [-1, 0, 999, 1000, 1000.5, '558837', null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const payload = parsePayload({ ...outputFromTable(displayTable(1000, true)), total_row_count: total });
    assert.equal(payload.total_row_count, undefined);
    assert.equal(payload.truncated, true);
    assert.match(footer(payload), /1,000 rows shown/);
  }
});

test('an exact total larger than the returned rows proves truncation despite an inconsistent flag', () => {
  const payload = parsePayload({ ...outputFromTable(displayTable(10, false)), total_row_count: 20 });
  assert.equal(payload.truncated, true);
  assert.equal(payload.total_row_count, 20);
  assert.match(footer(payload), /10 \/ 20 rows/);
});

test('missing client metadata does not imply completeness or break rendering', () => {
  const raw = outputFromTable(displayTable(10, false));
  delete raw.truncated;
  delete raw.total_row_count;
  const payload = parsePayload(raw);
  assert.equal(payload.truncated, null);
  assert.equal(payload.total_row_count, undefined);
  assert.match(footer(payload), /10 rows shown/);
});
