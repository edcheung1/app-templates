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

async function harness(t) {
  const viewer = 'a'.repeat(64);
  const notebookPath = `/Users/author/app/runner-${'b'.repeat(64)}.designer.py`;
  const manifest = {
    exports: true,
    storage: { volume: 'main.apps.data', path: '/Volumes/main/apps/data/designer_apps/app1' },
    parameters: [{ name: 'value' }],
    blocks: [{ type: 'output', id: 'out', nodeId: 'source', port: 'data' }],
  };
  const state = {
    manifest,
    notebookPath,
    starts: [],
    cancelled: [],
    reports: [],
    streams: undefined,
    removeError: false,
  };
  const files = new Map();
  const runs = new Map([
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
  let resolveUnlocked;
  const unlocked = new Promise((resolve) => {
    resolveUnlocked = resolve;
  });
  const store = {
    create: async (path, value) => {
      if (files.has(path)) return false;
      files.set(path, Buffer.from(JSON.stringify(value)));
      return true;
    },
    read: async (path) => (files.has(path) ? JSON.parse(files.get(path).toString()) : undefined),
    size: async (path) => files.get(path)?.length,
    remove: async (path) => {
      if (state.removeError && path.endsWith('.csv')) throw new Error('Storage unavailable');
      files.delete(path);
      if (path.endsWith('download.lock')) resolveUnlocked();
    },
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
    getRun: async (id) => runs.get(id),
    start: async (params, token) => {
      state.starts.push({ params, token });
      runs.set(2, {
        job_id: 10,
        state: { life_cycle_state: 'RUNNING' },
        overriding_parameters: { notebook_params: params },
      });
      return 2;
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
  return { state, runs, files, store, start, call, ready, unlocked, viewer };
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
      h.state.notebookPath = '/Users/author/app/runner-new.designer.py';
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

test('streams the full artifact and deletes it after transfer, then requires regeneration', async (t) => {
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
  await h.unlocked;
  assert.equal(h.files.has(`${root}/result.csv`), false);
  assert.equal((await (await h.call(`/${exportId}`)).json()).phase, 'consumed');
  assert.equal((await h.call(`/${exportId}/download`)).status, 409);
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

test('interrupted transfer releases its lock and retains the artifact for retry', async (t) => {
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
  assert.equal((await h.call(`/${exportId}/download`)).status, 409);
  controller.abort();
  await response.body.cancel().catch(() => {});
  await h.unlocked;
  assert.equal(h.files.has(`${root}/result.csv`), true);
  assert.equal(h.files.has(`${root}/consumed.json`), false);
  h.state.streams = undefined;
  assert.equal(await (await h.call(`/${exportId}/download`)).text(), 'value\n1\n2\n');
});

test('cleanup failure does not turn a completed download into a failed transfer', async (t) => {
  const h = await harness(t);
  const { exportId, root } = await h.ready();
  h.state.removeError = true;
  assert.equal(await (await h.call(`/${exportId}/download`)).text(), 'value\n1\n2\n');
  await h.unlocked;
  assert.equal(h.files.has(`${root}/result.csv`), true);
  assert.equal(h.state.reports.length, 1);
  assert.equal((await (await h.call(`/${exportId}`)).json()).phase, 'consumed');
});
