import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'tsdown';

let outputDirectory;
let viewerKey;
let parseRunSnapshot, LastRunLabel;
let instance = 0;
const harnessKey = Symbol.for('designer-upload-route-tests');
const originalJobId = process.env.DATABRICKS_JOB_ID;

before(async () => {
  outputDirectory = await mkdtemp(fileURLToPath(new URL('../.upload-route-tests-', import.meta.url)));
  await build({
    entry: { server: 'server/server.ts', fileUploads: 'server/fileUploads.ts' },
    config: false,
    tsconfig: 'tsconfig.server.json',
    outDir: outputDirectory,
    outExtensions: () => ({ js: '.mjs' }),
    logLevel: 'silent',
    noExternal: ['@databricks/appkit'],
    // Only replace HTTP registration and the remote workspace boundary, not route handlers.
    plugins: [
      {
        name: 'appkit-test-boundary',
        resolveId(id) {
          if (id === '@databricks/appkit') return '\0appkit-test-boundary';
        },
        load(id) {
          if (id !== '\0appkit-test-boundary') return;
          return `
          const harness = globalThis[Symbol.for('designer-upload-route-tests')];
          export const createWorkspaceClient = () => harness.client;
          export class ApiError extends Error {}
          export const server = () => ({ name: 'server' });
          export const files = (config) => ({ name: 'files', config });
          export const createApp = async (options) => {
            harness.apps.push(options.plugins);
            if (options.onPluginsReady) {
              await options.onPluginsReady({ server: { extend: harness.extend } });
            }
            return { files: () => harness.volume };
          };
        `;
        },
      },
    ],
  });
  ({ viewerKey } = await import(pathToFileURL(join(outputDirectory, 'fileUploads.mjs')).href));
  await build({
    entry: { payload: 'client/src/payload.ts', LastRunLabel: 'client/src/LastRunLabel.tsx' },
    config: false,
    tsconfig: 'tsconfig.client.json',
    noExternal: [/^@databricks\/appkit-ui(?:\/|$)/],
    outDir: outputDirectory,
    clean: false,
    outExtensions: () => ({ js: '.mjs' }),
    logLevel: 'silent',
  });
  ({ parseRunSnapshot } = await import(pathToFileURL(join(outputDirectory, 'payload.mjs')).href));
  ({ LastRunLabel } = await import(pathToFileURL(join(outputDirectory, 'LastRunLabel.mjs')).href));
});

after(async () => {
  delete globalThis[harnessKey];
  if (originalJobId === undefined) delete process.env.DATABRICKS_JOB_ID;
  else process.env.DATABRICKS_JOB_ID = originalJobId;
  if (outputDirectory) await rm(outputDirectory, { recursive: true });
});

const manifest = {
  version: 5,
  appName: 'Uploads',
  storage: {
    volume: 'main.default.designer_app1',
    path: '/Volumes/main/default/designer_app1/designer_apps/app1',
    maxUploadFileSizeBytes: 5 * 1024 * 1024 * 1024,
  },
  parameters: [{ name: 'path', label: 'CSV', type: 'file', defaultValue: '/private/author.csv' }],
  blocks: [{ type: 'output', id: 'data', label: 'Data', nodeId: 'source', port: 'data' }],
};

async function serverHarness() {
  const routes = new Map();
  const middleware = [];
  const state = { manifest, runs: [], listed: [], reads: [], cancelled: [], outputReads: [], submissions: [], apps: [] };
  const stored = new Map();
  globalThis[harnessKey] = {
    apps: state.apps,
    volume: {
      createDirectory: async () => {},
      upload: async (path, bytes, options) => {
        assert.equal(options.overwrite, false);
        assert.equal(stored.has(path), false);
        stored.set(
          path,
          bytes instanceof ReadableStream
            ? Buffer.from(await new Response(bytes).arrayBuffer())
            : Buffer.from(bytes),
        );
      },
      read: async (path, options) => {
        assert.equal(options.maxSize, 16 * 1024);
        return stored.get(path).toString();
      },
      metadata: async (path) => ({ contentLength: stored.get(path)?.length }),
      list: async (folder) => [...stored.keys()]
        .filter((path) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/'))
        .map((path) => ({ name: path.slice(folder.length + 1), is_directory: false })),
      delete: async (path) => { stored.delete(path); },
    },
    extend(apply) {
      apply({
        use: (_path, handler) => middleware.push(handler),
        ...Object.fromEntries(
          ['get', 'post', 'delete', 'all'].map((method) => [
            method,
            (path, handler) => routes.set(`${method}:${path}`, handler),
          ]),
        ),
      });
    },
    client: {
      jobs: {
        get: async () => ({ settings: { tasks: [{ notebook_task: { notebook_path: '/Users/author/app/runner' } }] } }),
        getRun: async ({ run_id }) => {
          state.reads.push(run_id);
          return state.runs.find((run) => run.run_id === run_id);
        },
        listRuns: async function* ({ active_only }) {
          if (!active_only) yield* state.listed;
        },
        exportRun: async ({ run_id }) => {
          state.outputReads.push(run_id);
          const model = Buffer.from(
            encodeURIComponent(
              JSON.stringify({
                commands: [
                  {
                    command: 'display(ctx["source.data"])',
                    results: { type: 'table', schema: [], data: [], overflow: false },
                  },
                ],
              }),
            ),
          ).toString('base64');
          return { views: [{ content: `<script>__DATABRICKS_NOTEBOOK_MODEL = '${model}'</script>` }] };
        },
        cancelRun: async ({ run_id }) => {
          state.cancelled.push(run_id);
        },
        runNow: async (request) => {
          state.submissions.push(request);
          return { run_id: 1000 };
        },
      },
      toLegacyWorkspaceClient: () => ({
        workspace: {
          export: async () => ({ content: Buffer.from(JSON.stringify(state.manifest)).toString('base64') }),
        },
      }),
    },
  };
  process.env.DATABRICKS_JOB_ID = '100';
  await import(`${pathToFileURL(join(outputDirectory, 'server.mjs')).href}?instance=${++instance}`);
  const request = async (method, path, { viewer = 'alice', params = {}, body, headers = {}, bytes } = {}) => {
    const req = Object.assign(Readable.from(bytes ? [bytes] : []), {
      method: method.toUpperCase(),
      params,
      body,
      query: {},
      get: (name) => (name === 'x-forwarded-user' ? viewer : headers[name]),
    });
    const response = { status: 200, body: undefined, headers: {} };
    const res = {
      status(code) {
        response.status = code;
        return res;
      },
      json(value) {
        response.body = value;
        return res;
      },
      setHeader(name, value) {
        response.headers[name] = value;
      },
    };
    for (const handler of middleware) handler(req, res, () => {});
    const handler = routes.get(`${method}:${path}`) ?? routes.get(`all:${path}`);
    assert.ok(handler, `registered ${method} ${path}`);
    await handler(req, res);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    return response;
  };
  return { state, request };
}

function run(id, owner, params = {}) {
  return {
    run_id: id,
    job_id: 100,
    start_time: id,
    end_time: id + 1,
    state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' },
    tasks: [{ run_id: id + 1000 }],
    overriding_parameters: { notebook_params: { _lb_app_viewer: viewerKey(owner, '100'), ...params } },
  };
}

for (const filename of ['sales.csv', 'sales.xlsx', 'data.json', 'data.csv.gz', 'carmax_car_prices copy (1).xlsx', 'データ.xlsx']) {
  test(`shows ${filename} on completion without refreshing and preserves it in history`, async () => {
    const { state, request } = await serverHarness();
    state.runs = [
      run(20, 'bob'),
      run(10, 'alice', { path: `/Volumes/data/829dcaa7-e505-49c1-b6d0-73d1841e990a/${filename}` }),
    ];
    state.listed = state.runs.map(({ run_id, job_id }) => ({ run_id, job_id }));
    const status = await request('get', '/api/designer/run/:jobRunId', { params: { jobRunId: '10' } });
    assert.equal(status.status, 200);
    const snapshot = parseRunSnapshot(status.body);
    assert.equal(snapshot.terminal, true);
    assert.deepEqual(snapshot.parameters, { path: 'upload:829dcaa7-e505-49c1-b6d0-73d1841e990a' });
    assert.deepEqual(snapshot.parameterDisplayValues, { path: filename });
    const html = renderToStaticMarkup(createElement(LastRunLabel, {
      run: snapshot,
      parameters: snapshot.parameters,
      parameterDisplayValues: snapshot.parameterDisplayValues,
      declared: manifest.parameters,
      variant: 'justFinished',
    }));
    assert.match(html, /Just finished/);
    assert.ok(html.includes(filename));
    assert.doesNotMatch(html, /upload:|\/Volumes\//);

    const history = await request('get', '/api/designer/runs');
    assert.deepEqual(
      history.body.runs.map(({ jobRunId }) => jobRunId),
      ['10'],
    );
    assert.deepEqual(history.body.runs[0].parameters, { path: 'upload:829dcaa7-e505-49c1-b6d0-73d1841e990a' });
    assert.deepEqual(history.body.runs[0].parameterDisplayValues, { path: filename });
    const last = await request('get', '/api/designer/last-run');
    assert.equal(last.body.status, 'found');
    assert.equal(last.body.run.jobRunId, '10');
    assert.equal(last.body.run.taskRunId, '1010');
    assert.deepEqual(last.body.parameters, { path: 'upload:829dcaa7-e505-49c1-b6d0-73d1841e990a' });
    assert.deepEqual(last.body.parameterDisplayValues, { path: filename });
    assert.deepEqual(state.outputReads, [1010, 1010]);
  });
}

test('live status preserves ordinary parameters and leaves missing recorded values absent', async () => {
  const { state, request } = await serverHarness();
  state.manifest = {
    ...manifest,
    version: 5,
    storage: undefined,
    parameters: [{ name: 'year', label: 'Year', type: 'text', defaultValue: '2015' }],
  };
  state.runs = [run(10, 'alice', { year: '2016', ld_display_outputs_for: 'source', _lb_collect_row_counts: 'true' })];
  let response = await request('get', '/api/designer/run/:jobRunId', { params: { jobRunId: '10' } });
  let snapshot = parseRunSnapshot(response.body);
  assert.deepEqual(snapshot.parameters, { year: '2016' });
  assert.equal(snapshot.parameterDisplayValues, undefined);

  delete state.runs[0].overriding_parameters;
  response = await request('get', '/api/designer/run/:jobRunId', { params: { jobRunId: '10' } });
  snapshot = parseRunSnapshot(response.body);
  assert.equal(snapshot.parameters, undefined);
  assert.equal(snapshot.parameterDisplayValues, undefined);
});

test('rejects unsupported manifest versions and malformed optional storage', async () => {
  const { state, request } = await serverHarness();
  for (const invalid of [
    { ...manifest, version: 3 },
    { ...manifest, version: 4 },
    { ...manifest, storage: null, parameters: [] },
    { ...manifest, storage: { ...manifest.storage, path: '/Volumes/main/default/other' }, parameters: [] },
  ]) {
    state.manifest = invalid;
    assert.equal((await request('post', '/api/designer/run')).status, 409);
  }
  assert.deepEqual(state.submissions, []);
});

test('enables plugin storage on republish and binds a completed upload to a run', async () => {
  const { state, request } = await serverHarness();
  state.manifest = { ...manifest, version: 5, storage: undefined, parameters: [] };
  assert.equal((await request('post', '/api/designer/run')).status, 200);
  assert.deepEqual(state.apps.map((plugins) => plugins.map(({ name }) => name)), [['server']]);

  state.manifest = manifest;
  const response = await request('post', '/api/designer/uploads/:parameterName', {
    params: { parameterName: 'path' },
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'data.json' },
    bytes: Buffer.from('{"value":42}'),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(state.apps.map((plugins) => plugins.map(({ name }) => name)), [['server'], ['files']]);
  assert.equal((await request('post', '/api/designer/run', { body: { params: { path: response.body.upload.reference } } })).status, 200);
  const submitted = state.submissions.at(-1).notebook_params;
  assert.ok(submitted.path.startsWith(`${manifest.storage.path}/uploads/${viewerKey('alice', '100')}/`));
  assert.ok(submitted.path.endsWith(`/${response.body.upload.reference.slice('upload:'.length)}/data.json`));
  assert.equal(submitted.ld_display_outputs_for, 'source');
  assert.equal(submitted._lb_collect_row_counts, 'true');
  assert.equal(submitted._lb_app_viewer, viewerKey('alice', '100'));
  // Only the backend-only instance receives the files plugin: no generic file routes on the HTTP server.
  assert.equal(state.apps.length, 2);
});

test('denies cross-viewer results and cancellation at the server routes', async () => {
  const { state, request } = await serverHarness();
  state.runs = [run(10, 'bob')];
  for (const [method, path] of [
    ['get', '/api/designer/run/:jobRunId'],
    ['delete', '/api/designer/run/:jobRunId'],
  ]) {
    const response = await request(method, path, { params: { jobRunId: '10' } });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(state.outputReads, []);
  assert.deepEqual(state.cancelled, []);
  const cancel = await request('delete', '/api/designer/run/:jobRunId', { viewer: 'bob', params: { jobRunId: '10' } });
  assert.equal(cancel.status, 200);
  assert.deepEqual(state.cancelled, [10]);
});

test('requires ingress identity and uploaded references, and fails closed on invalid published configuration', async () => {
  const { state, request } = await serverHarness();
  const configured = await request('get', '/api/designer/config');
  assert.equal(configured.body.manifest.version, 5);
  assert.deepEqual(configured.body.manifest.storage, manifest.storage);
  assert.equal(configured.body.manifest.parameters[0].defaultValue, '');
  const missingIdentity = await request('post', '/api/designer/uploads/:parameterName', {
    viewer: '',
    params: { parameterName: 'path' },
  });
  assert.equal(missingIdentity.status, 401);
  const oversized = await request('post', '/api/designer/uploads/:parameterName', {
    params: { parameterName: 'path' },
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(5 * 1024 * 1024 * 1024 + 1),
    },
  });
  assert.equal(oversized.status, 413);
  for (const params of [{}, { path: '/private/author.csv' }]) {
    const response = await request('post', '/api/designer/run', { body: { params } });
    assert.equal(response.status, 400);
  }
  state.manifest = { ...manifest, storage: undefined };
  const invalid = await request('post', '/api/designer/run');
  assert.equal(invalid.status, 409);
  assert.deepEqual(state.submissions, []);
});
