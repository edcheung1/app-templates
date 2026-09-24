import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import express from 'express';
import { build } from 'tsdown';

let outputDirectory, registerExportRoutes, manifestRevision, isExportRun;
before(async () => {
  outputDirectory = await mkdtemp(fileURLToPath(new URL('../.export-tests-', import.meta.url)));
  await build({
    entry: { exports: 'server/exports.ts' },
    config: false,
    tsconfig: 'tsconfig.server.json',
    outDir: outputDirectory,
    outExtensions: () => ({ js: '.mjs' }),
    logLevel: 'silent',
  });
  ({ registerExportRoutes, manifestRevision, isExportRun } = await import(
    pathToFileURL(join(outputDirectory, 'exports.mjs')).href
  ));
});
after(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true });
});

async function harness(t, persisted) {
  const viewer = 'a'.repeat(64);
  const notebookPath = `/Users/author/app/runner-${'b'.repeat(64)}.designer.py`;
  const manifest = {
    appName: 'Example app',
    provenance: { publishedAt: 1000 },
    exports: true,
    storage: { volume: 'main.apps.data', path: '/Volumes/main/apps/data/designer_apps/app1' },
    parameters: [{ name: 'value' }],
    blocks: [
      { type: 'output', id: 'out', nodeId: 'source', port: 'data', executionNodeIds: ['ancestor', 'source'] },
      { type: 'output', id: 'other', nodeId: 'other', port: 'data', executionNodeIds: ['ancestor', 'other'] },
    ],
  };
  const state = {
    manifest,
    notebookPath,
    notebookSource: ['ancestor', 'source', 'other'].map((node) =>
      `if _lb_app_runtime is None or _lb_app_runtime.should_run("${node}"):\n    _lb_app_runtime.on_output("${node}", {})`,
    ).join('\n'),
    sourceReads: [],
    starts: [],
    cancelled: [],
    reports: [],
    streams: undefined,
  };
  const files = persisted?.files ?? new Map();
  const runs = persisted?.runs ?? new Map([
    [
      1,
      {
        job_id: 10,
        state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' },
        tasks: [{ notebook_task: { notebook_path: notebookPath, base_parameters: { hidden: 'original default' } } }],
        overriding_parameters: {
          notebook_params: { _lb_app_viewer: viewer, _lb_app_revision: manifestRevision(manifest), value: 'recorded' },
        },
      },
    ],
  ]);
  const store = {
    create: async (path, value) => {
      if (files.has(path)) return false;
      files.set(path, Buffer.from(JSON.stringify(value)));
      return true;
    },
    write: async (path, value) => { files.set(path, Buffer.from(JSON.stringify(value))); },
    read: async (path) => (files.has(path) ? JSON.parse(files.get(path).toString()) : undefined),
    size: async (path) => files.get(path)?.length,
    download: async (path) =>
      state.streams
        ? state.streams()
        : new ReadableStream({
            start(controller) {
              controller.enqueue(files.get(path));
              controller.close();
            },
          }),
  };
  const app = express();
  app.use(express.json());
  registerExportRoutes(app, {
    jobId: '10',
    manifest: async () => state.manifest,
    viewer: (req) => req.get('x-viewer'),
    notebookPath: async () => state.notebookPath,
    notebookSource: async (path) => { state.sourceReads.push(path); return state.notebookSource; },
    getRun: async (id) => runs.get(id),
    start: async (params, token) => {
      state.starts.push({ params, token });
      const runId = Math.max(...runs.keys()) + 1;
      runs.set(runId, {
        job_id: 10,
        state: { life_cycle_state: 'RUNNING' },
        overriding_parameters: { notebook_params: params },
      });
      return runId;
    },
    cancel: async (id) => {
      state.cancelled.push(id);
      runs.get(id).state = { life_cycle_state: 'TERMINATED', result_state: 'CANCELED' };
    },
    store: () => store,
    report: (error) => state.reports.push(error),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/designer/exports`;
  const call = (path = '', options = {}) =>
    fetch(base + path, {
      ...options,
      headers: { 'x-viewer': viewer, 'Content-Type': 'application/json', ...options.headers },
    });
  const body = { sourceRunId: '1', outputId: 'out', format: 'csv', requestId: '11111111-1111-4111-8111-111111111111' };
  const start = async (overrides = {}) => call('', { method: 'POST', body: JSON.stringify({ ...body, ...overrides }) });
  const ready = async () => {
    const response = await start();
    assert.equal(response.status, 202);
    const { exportId } = await response.json();
    const root = `${manifest.storage.path}/exports/${viewer}/${exportId}`;
    runs.get(2).state = { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' };
    files.set(`${root}/result.csv`, Buffer.from('value\n1\n2\n'));
    await store.create(`${root}/completion.json`, { id: exportId, format: 'csv', size: 10, rowCount: 2 });
    return { exportId, root };
  };
  return { state, runs, files, store, start, call, ready, viewer };
}

test('replays recorded parameters idempotently and separates export runs from previews', async (t) => {
  const h = await harness(t);
  const first = await (await h.start({ params: { value: 'client override' } })).json();
  const second = await (await h.start()).json();
  assert.equal(first.exportId, second.exportId);
  assert.equal(h.state.starts.length, 1);
  const { params, token } = h.state.starts[0];
  assert.equal(params.value, 'recorded');
  assert.equal(params.hidden, 'original default');
  assert.equal(params.ld_display_outputs_for, '');
  assert.equal(params._lb_collect_row_counts, 'false');
  assert.equal(token, first.exportId);
  assert.equal(isExportRun(h.runs.get(2)), true);
  assert.equal(isExportRun(h.runs.get(1)), false);
  assert.equal((await (await h.call(`/${first.exportId}`)).json()).phase, 'running');
});

test('includes the export job link while queued, running and after failure', async (t) => {
  const h = await harness(t);
  const { exportId } = await (await h.start()).json();
  const run = h.runs.get(2);
  run.run_page_url = 'https://workspace.databricks.com/jobs/10/runs/2';
  for (const [state, phase] of [
    [{ life_cycle_state: 'PENDING' }, 'queued'],
    [{ life_cycle_state: 'RUNNING' }, 'running'],
    [{ life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: 'Reader failed' }, 'failed'],
    [{ life_cycle_state: 'TERMINATED', result_state: 'CANCELED' }, 'cancelled'],
    [{ life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' }, 'failed'],
  ]) {
    run.state = state;
    const status = await (await h.call(`/${exportId}`)).json();
    assert.equal(status.phase, phase);
    assert.equal(status.runPageUrl, run.run_page_url);
  }
  for (const url of [undefined, '', 'javascript:alert(1)']) {
    run.run_page_url = url;
    assert.equal((await (await h.call(`/${exportId}`)).json()).runPageUrl, undefined);
  }
});

test('passes only the selected output plan from the publication, ignoring browser overrides', async (t) => {
  const h = await harness(t);
  const response = await h.start({ outputId: 'other', executionNodeIds: ['source', 'injected'] });
  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(h.state.starts[0].params._lb_export_request).executionNodeIds, ['ancestor', 'other']);
  assert.equal(h.state.starts[0].params.ld_display_outputs_for, '');
});

test('keeps repeated exports of every output valid across presentation-only manifest changes', async (t) => {
  const h = await harness(t);
  const sourceRevision = h.runs.get(1).overriding_parameters.notebook_params._lb_app_revision;
  const before = structuredClone(h.state.manifest);
  assert.equal((await h.start()).status, 202);
  assert.deepEqual(h.state.manifest, before);

  h.state.manifest = {
    ...h.state.manifest,
    appName: 'Renamed app',
    subtitle: 'New description',
    provenance: { publishedAt: 2000 },
    parameters: [{ name: 'value', label: 'New label', help: 'New help', defaultValue: 'new default' }],
    blocks: [
      { type: 'markdown', text: 'New introduction' },
      ...h.state.manifest.blocks.toReversed().map((block) => ({ ...block, label: 'New output label' })),
    ],
  };
  // Parsing and projecting the same declaration need not preserve object key order.
  h.state.manifest = JSON.parse(JSON.stringify(h.state.manifest), (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  assert.equal(manifestRevision(h.state.manifest), sourceRevision);
  for (const [outputId, requestId] of [
    ['out', '22222222-2222-4222-8222-222222222222'],
    ['other', '33333333-3333-4333-8333-333333333333'],
  ]) {
    const response = await h.start({ outputId, requestId });
    assert.equal(response.status, 202, JSON.stringify(await response.json()));
  }
  assert.equal(h.state.starts.length, 2);
  for (const { params } of h.state.starts) {
    assert.equal(params.value, 'recorded');
    assert.equal(params.hidden, 'original default');
    assert.equal(params._lb_app_revision, sourceRevision);
  }
});

test('asks legacy runs to refresh once without claiming the app was republished', async (t) => {
  const h = await harness(t);
  h.runs.get(1).overriding_parameters.notebook_params._lb_app_revision = 'c'.repeat(64);
  const response = await h.start();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /older export configuration/);
  assert.deepEqual(h.state.starts, []);
});

for (const plan of [undefined, null, [], ['ancestor'], ['source', 'source'], ['source', ''], ['source', 2], 'source']) {
  test(`refuses invalid published execution plan ${JSON.stringify(plan)} before submitting a Job`, async (t) => {
    const h = await harness(t);
    h.state.manifest.blocks[0].executionNodeIds = plan;
    const response = await h.start();
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Republish/);
    assert.deepEqual(h.state.starts, []);
    assert.equal(h.files.size, 0);
  });
}

test('requires a new source run after the published execution plan changes', async (t) => {
  const h = await harness(t);
  h.state.manifest.blocks[0].executionNodeIds = ['other', 'source'];
  const response = await h.start();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /execution plans/);
  assert.deepEqual(h.state.starts, []);
});

test('rejects a mixed legacy runner missing the selected output hook before starting compute', async (t) => {
  const h = await harness(t);
  h.state.notebookSource = 'out = run(config, inputs, spark)\nctx["source.data"] = out["data"]\n_lb_app_runtime.on_output("other", {})';
  const response = await h.start();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Republish/);
  assert.deepEqual(h.state.sourceReads, [h.state.notebookPath]);
  assert.deepEqual(h.state.starts, []);
  assert.equal(h.files.size, 0);
});

test('rejects a runner whose ancestor no longer has the execution gate', async (t) => {
  const h = await harness(t);
  h.state.notebookSource = h.state.notebookSource.replace('.should_run("ancestor")', '.old_gate("ancestor")');
  assert.equal((await h.start()).status, 409);
  assert.deepEqual(h.state.starts, []);
});

test('rejects plans that exceed the Jobs parameter budget before creating request files', async (t) => {
  const h = await harness(t);
  h.state.manifest.blocks[0].executionNodeIds = ['n'.repeat(10_000), 'source'];
  h.runs.get(1).overriding_parameters.notebook_params._lb_app_revision = manifestRevision(h.state.manifest);
  assert.equal((await h.start()).status, 400);
  assert.deepEqual(h.state.starts, []);
  assert.equal(h.files.size, 0);
});

for (const [name, mutate, status] of [
  [
    'wrong owner',
    (h) => {
      h.runs.get(1).overriding_parameters.notebook_params._lb_app_viewer = 'other';
    },
    404,
  ],
  [
    'wrong job',
    (h) => {
      h.runs.get(1).job_id = 99;
    },
    404,
  ],
  [
    'failed source',
    (h) => {
      h.runs.get(1).state.result_state = 'FAILED';
    },
    409,
  ],
  [
    'republished manifest',
    (h) => {
      h.state.manifest.parameters.push({ name: 'new' });
    },
    409,
  ],
  [
    'republished notebook',
    (h) => {
      h.state.notebookPath = `/Users/author/app/runner-${'d'.repeat(64)}.designer.py`;
    },
    409,
  ],
  [
    'changed output port',
    (h) => {
      h.state.manifest.blocks[0].port = 'other_data';
    },
    409,
  ],
  [
    'changed output node',
    (h) => {
      h.state.manifest.blocks[0].nodeId = 'other';
      h.state.manifest.blocks[0].executionNodeIds = ['ancestor', 'other'];
    },
    409,
  ],
  [
    'changed storage',
    (h) => {
      h.state.manifest.storage = { ...h.state.manifest.storage, path: '/Volumes/main/apps/data/designer_apps/app2' };
    },
    409,
  ],
  [
    'not enabled',
    (h) => {
      h.state.manifest.exports = false;
    },
    409,
  ],
])
  test(`rejects ${name} without launching compute`, async (t) => {
    const h = await harness(t);
    mutate(h);
    assert.equal((await h.start()).status, status);
    assert.equal(h.state.starts.length, 0);
  });

test('rejects undeclared output, invalid format, and missing identity', async (t) => {
  const h = await harness(t);
  assert.equal((await h.start({ outputId: 'private' })).status, 400);
  assert.equal((await h.start({ format: 'parquet' })).status, 400);
  assert.equal((await h.call('', { method: 'POST', headers: { 'x-viewer': '' }, body: '{}' })).status, 401);
  assert.equal(h.state.starts.length, 0);
});

test('retains the artifact for repeated downloads and reuses it across new requests and server restarts', async (t) => {
  const h = await harness(t);
  const { exportId, root } = await h.ready();
  assert.deepEqual(await (await h.call(`/${exportId}`)).json(), {
    exportId,
    phase: 'ready',
    format: 'csv',
    rowCount: 2,
    size: 10,
  });
  const response = await h.call(`/${exportId}/download`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="result.csv"/);
  assert.equal(await response.text(), 'value\n1\n2\n');
  assert.equal(h.files.has(`${root}/result.csv`), true);
  assert.equal(h.files.has(`${root}/consumed.json`), false);
  assert.equal(h.files.has(`${root}/download.lock`), false);
  assert.equal((await (await h.call(`/${exportId}`)).json()).phase, 'ready');
  assert.equal(await (await h.call(`/${exportId}/download`)).text(), 'value\n1\n2\n');
  for (const active of [h, await harness(t, h)]) {
    const reused = await active.start({ requestId: '22222222-2222-4222-8222-222222222222' });
    assert.equal(reused.status, 200);
    assert.equal((await reused.json()).exportId, exportId);
    assert.equal(active.state.starts.length, active === h ? 1 : 0);
  }
  assert.equal(h.state.starts.length, 1);
});

test('shares pending generation across concurrent requests and after restarting the server', async (t) => {
  const h = await harness(t);
  const responses = await Promise.all([
    h.start(),
    h.start({ requestId: '22222222-2222-4222-8222-222222222222' }),
    h.start({ requestId: '33333333-3333-4333-8333-333333333333' }),
  ]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(results.map(({ exportId }) => exportId)).size, 1);
  assert.equal(h.state.starts.length, 1);
  const restarted = await harness(t, h);
  const response = await restarted.start({ requestId: '44444444-4444-4444-8444-444444444444' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).exportId, results[0].exportId);
  assert.equal(restarted.state.starts.length, 0);
});

for (const change of ['format', 'output', 'run', 'parameters', 'runner code']) {
  test(`does not reuse cached files for changed ${change}`, async (t) => {
    const h = await harness(t);
    const { exportId, root } = await h.ready();
    const options = {};
    if (change === 'format') options.format = 'xlsx';
    if (change === 'output') options.outputId = 'other';
    if (change === 'run') {
      h.runs.set(10, structuredClone(h.runs.get(1)));
      options.sourceRunId = '10';
    }
    if (change === 'parameters') h.runs.get(1).overriding_parameters.notebook_params.value = 'changed';
    if (change === 'runner code') h.state.notebookSource += '\nprint("Changed code")';
    const response = await h.start(options);
    assert.equal(response.status, 202);
    assert.notEqual((await response.json()).exportId, exportId);
    assert.equal(h.state.starts.length, 2);
    assert.equal(h.files.has(`${root}/result.csv`), true);
  });
}

for (const phase of ['failed', 'cancelled', 'missing', 'incomplete']) {
  test(`replaces a ${phase} generation without reusing its job or overwriting its files`, async (t) => {
    const h = await harness(t);
    const { exportId, root } = await h.ready();
    if (phase === 'failed') h.runs.get(2).state.result_state = 'FAILED';
    if (phase === 'cancelled') h.runs.get(2).state.result_state = 'CANCELED';
    if (phase === 'missing') h.files.delete(`${root}/result.csv`);
    if (phase === 'incomplete') h.files.set(`${root}/result.csv`, Buffer.from('partial'));
    const before = new Map(h.files);
    const regenerated = await h.start({ requestId: '22222222-2222-4222-8222-222222222222' });
    assert.equal(regenerated.status, 202);
    const next = await regenerated.json();
    assert.notEqual(next.exportId, exportId);
    assert.equal(h.state.starts.length, 2);
    for (const [path, bytes] of before) {
      if (!path.includes('/cache/')) assert.deepEqual(h.files.get(path), bytes);
    }
    const reused = await (await h.start({ requestId: '33333333-3333-4333-8333-333333333333' })).json();
    assert.equal(reused.exportId, next.exportId);
    assert.equal(h.state.starts.length, 2);
  });
}

test('checks ownership and execution revision before looking up cached files', async (t) => {
  const h = await harness(t);
  await h.ready();
  h.runs.get(1).overriding_parameters.notebook_params._lb_app_viewer = 'other';
  assert.equal((await h.start()).status, 404);
  h.runs.get(1).overriding_parameters.notebook_params._lb_app_viewer = h.viewer;
  h.state.manifest.blocks[0].port = 'different';
  assert.equal((await h.start()).status, 409);
  assert.equal(h.state.starts.length, 1);
});

test('does not reuse a cache pointer that belongs to a different output', async (t) => {
  const h = await harness(t);
  const { exportId } = await h.ready();
  const cachePath = [...h.files.keys()].find((path) => path.includes('/cache/'));
  const other = await (await h.start({ outputId: 'other' })).json();
  await h.store.write(cachePath, { exportId: other.exportId });
  const response = await h.start({ requestId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(response.status, 202);
  const next = await response.json();
  assert.notEqual(next.exportId, exportId);
  assert.notEqual(next.exportId, other.exportId);
  assert.equal(h.state.starts.length, 3);
  assert.equal(JSON.parse(h.state.starts[2].params._lb_export_request).nodeId, 'source');
});

for (const record of ['cache', 'completion']) {
  test(`does not start duplicate compute when the ${record} store is unavailable`, async (t) => {
    const h = await harness(t);
    const { exportId } = await h.ready();
    const read = h.store.read;
    h.store.read = async (path) => {
      if (record === 'cache' ? path.includes('/cache/') : path.endsWith('/completion.json'))
        throw new Error('Storage unavailable');
      return read(path);
    };
    assert.equal((await h.start()).status, 502);
    assert.equal(h.state.starts.length, 1);
    h.store.read = read;
    const reused = await h.start();
    assert.equal(reused.status, 200);
    assert.equal((await reused.json()).exportId, exportId);
    assert.equal(h.state.starts.length, 1);
  });
}

test('recovers a failed cache-pointer write without resubmitting the running job', async (t) => {
  const h = await harness(t);
  const write = h.store.write;
  h.store.write = async () => { throw new Error('Storage unavailable'); };
  assert.equal((await h.start()).status, 502);
  assert.equal(h.state.starts.length, 1);
  h.store.write = write;
  const retried = await h.start({ requestId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(retried.status, 202);
  const { exportId } = await retried.json();
  assert.equal(exportId, h.state.starts[0].token);
  assert.equal(h.state.starts.length, 1);
  const restarted = await harness(t, h);
  assert.equal((await (await restarted.start()).json()).exportId, exportId);
  assert.equal(restarted.state.starts.length, 0);
});

test('rejects cross-viewer download/status/cancel without exposing the artifact', async (t) => {
  const h = await harness(t);
  const { exportId, root } = await h.ready();
  for (const [suffix, method] of [
    ['', 'GET'],
    ['/download', 'GET'],
    ['/cancel', 'POST'],
  ]) {
    assert.equal((await h.call(`/${exportId}${suffix}`, { method, headers: { 'x-viewer': 'other' } })).status, 404);
  }
  assert.equal(h.files.has(`${root}/result.csv`), true);
});

test('rejects partial downloads and treats missing or changed artifacts as failed', async (t) => {
  const h = await harness(t);
  const { exportId, root } = await h.ready();
  assert.equal((await h.call(`/${exportId}/download`, { headers: { range: 'bytes=0-2' } })).status, 416);
  assert.equal((await h.call(`/${exportId}/download`, { method: 'HEAD' })).status, 405);
  h.files.set(`${root}/result.csv`, Buffer.from('changed'));
  assert.equal((await (await h.call(`/${exportId}`)).json()).phase, 'failed');
});

test('cancels only the owned export job', async (t) => {
  const h = await harness(t);
  const { exportId } = await (await h.start()).json();
  assert.equal((await h.call(`/${exportId}/cancel`, { method: 'POST' })).status, 200);
  assert.deepEqual(h.state.cancelled, [2]);
  assert.equal((await (await h.call(`/${exportId}`)).json()).phase, 'cancelled');
});

test('an interrupted transfer does not block other downloads or consume the cached artifact', async (t) => {
  const h = await harness(t);
  const { exportId, root } = await h.ready();
  h.state.streams = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('v'));
      },
    });
  const controller = new AbortController();
  const response = await h.call(`/${exportId}/download`, { signal: controller.signal });
  h.state.streams = undefined;
  assert.equal(await (await h.call(`/${exportId}/download`)).text(), 'value\n1\n2\n');
  controller.abort();
  await response.body.cancel().catch(() => {});
  assert.equal(h.files.has(`${root}/result.csv`), true);
  assert.equal(h.files.has(`${root}/consumed.json`), false);
  assert.equal(await (await h.call(`/${exportId}/download`)).text(), 'value\n1\n2\n');
});

test('allows concurrent downloads without modifying files or metadata', async (t) => {
  const h = await harness(t);
  const { exportId } = await h.ready();
  const before = new Map(h.files);
  const downloads = await Promise.all(Array.from({ length: 3 }, async () =>
    (await h.call(`/${exportId}/download`)).text(),
  ));
  assert.deepEqual(downloads, Array(3).fill('value\n1\n2\n'));
  assert.deepEqual(h.files, before);
  assert.deepEqual(h.state.reports, []);
});
