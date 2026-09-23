import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsdown';

let uploads, config, parameters, appConfig, outputDirectory;
before(async () => {
  outputDirectory = await mkdtemp(fileURLToPath(new URL('../.upload-tests-', import.meta.url)));
  await build({
    entry: {
      fileUploads: 'server/fileUploads.ts',
      uploadConfig: 'shared/uploadConfig.ts',
      runParameters: 'server/runParameters.ts',
      appConfig: 'client/src/appConfig.ts',
    },
    config: false,
    tsconfig: 'tsconfig.server.json',
    outDir: outputDirectory,
    outExtensions: () => ({ js: '.mjs' }),
    logLevel: 'silent',
  });
  uploads = await import(pathToFileURL(join(outputDirectory, 'fileUploads.mjs')).href);
  config = await import(pathToFileURL(join(outputDirectory, 'uploadConfig.mjs')).href);
  parameters = await import(pathToFileURL(join(outputDirectory, 'runParameters.mjs')).href);
  appConfig = await import(pathToFileURL(join(outputDirectory, 'appConfig.mjs')).href);
});
after(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true });
});

const storage = {
  volume: 'main.default.uploads',
  path: '/Volumes/main/default/uploads/designer_uploads/app1',
  maxFileSizeBytes: 5 * 1024 * 1024 * 1024,
};
const fileParameter = { name: 'path', type: 'file', label: 'Data', defaultValue: '/Volumes/private/author.csv' };
const manifest = {
  version: 4,
  appName: 'Uploads',
  uploads: storage,
  parameters: [fileParameter],
  blocks: [{ type: 'output', id: 'data', nodeId: 'source', port: 'data', label: 'Data' }],
};

// In-memory UC boundary preserves actual bytes and overwrite behavior; tests exercise the real upload service.
function memoryStore() {
  const files = new Map();
  return {
    files,
    mkdir: async () => {},
    put: async (path, bytes) => {
      assert.equal(files.has(path), false);
      files.set(path, Buffer.from(bytes));
    },
    putStream: async (path, stream) => {
      assert.equal(files.has(path), false);
      files.set(path, Buffer.from(await new Response(stream).arrayBuffer()));
    },
    read: async (path) => {
      if (!files.has(path)) throw new uploads.UploadError(404, 'missing');
      return JSON.parse(files.get(path).toString());
    },
    size: async (path) => files.get(path)?.length,
    delete: async (path) => {
      files.delete(path);
    },
  };
}

test('saves immutable bytes, resolves an upload after service restart, and isolates viewer/parameter/app', async () => {
  const store = memoryStore();
  const alice = uploads.viewerKey('alice', '100');
  const saved = await uploads.saveUpload(store, storage, alice, 'path', 'sales.csv', Buffer.from('a,b\n1,2\n'));
  const resolved = await uploads.resolveUpload({ ...store }, storage, alice, 'path', saved.reference);
  assert.equal(store.files.get(resolved.path).toString(), 'a,b\n1,2\n');
  for (const [owner, name, root] of [
    [uploads.viewerKey('bob', '100'), 'path', storage],
    [alice, 'other', storage],
    [uploads.viewerKey('alice', '200'), 'path', storage],
    [alice, 'path', { ...storage, path: storage.path + '2' }],
  ]) {
    await assert.rejects(uploads.resolveUpload(store, root, owner, name, saved.reference), /missing/);
  }
});

test('substitutes only completed owned uploads and stamps ownership for run parameters', async () => {
  const store = memoryStore();
  const owner = uploads.viewerKey('alice', '100');
  const saved = await uploads.saveUpload(store, storage, owner, 'path', 'data.csv', Buffer.from('a\n1\n'));
  const resolved = await parameters.resolveRunParameters(
    manifest,
    {
      path: saved.reference,
      ld_display_outputs_for: 'evil',
      _lb_collect_row_counts: 'false',
      _lb_app_viewer: 'bob',
      target_node: 'evil',
      ignored: 'value',
    },
    owner,
    store,
  );
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.params, {
    path: (await uploads.resolveUpload(store, storage, owner, 'path', saved.reference)).path,
    ld_display_outputs_for: 'source',
    _lb_collect_row_counts: 'true',
    _lb_app_viewer: owner,
  });
  for (const value of ['', '/Volumes/main/default/uploads/author.csv', '../../file', 'upload:bad-id']) {
    assert.equal((await parameters.resolveRunParameters(manifest, { path: value }, owner, store)).ok, false);
  }
  assert.equal(
    (await parameters.resolveRunParameters(manifest, { path: saved.reference }, undefined, store)).ok,
    false,
  );
  assert.equal(
    (await parameters.resolveRunParameters(manifest, { path: saved.reference }, uploads.viewerKey('bob', '100'), store))
      .ok,
    false,
  );
  assert.equal(
    (
      await parameters.resolveRunParameters(
        { ...manifest, uploads: undefined },
        { path: saved.reference },
        owner,
        store,
      )
    ).ok,
    false,
  );
});

test('never makes incomplete or changed uploads available', async () => {
  const store = memoryStore();
  const owner = uploads.viewerKey('alice', '100');
  const failing = {
    ...store,
    put: async (path, bytes) => {
      if (path.endsWith('.json')) throw new Error('metadata unavailable');
      await store.put(path, bytes);
    },
  };
  await assert.rejects(
    uploads.saveUpload(failing, storage, owner, 'path', 'data.csv', Buffer.from('a\n1\n')),
    /metadata unavailable/,
  );
  assert.equal(store.files.size, 0);
  const saved = await uploads.saveUpload(store, storage, owner, 'path', 'data.csv', Buffer.from('a\n1\n'));
  const { path } = await uploads.resolveUpload(store, storage, owner, 'path', saved.reference);
  store.files.set(path, Buffer.from('changed'));
  await assert.rejects(uploads.resolveUpload(store, storage, owner, 'path', saved.reference), /has changed/);
});

test('streams uploads while enforcing actual byte limits, empty files and interrupted requests', async () => {
  const store = memoryStore();
  const stream = (...chunks) =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      },
    });
  const saved = await uploads.saveUploadStream(
    store,
    { ...storage, maxFileSizeBytes: 4 },
    'viewer',
    'path',
    'data.csv',
    stream('ab', 'cd'),
    4,
  );
  assert.equal((await uploads.resolveUpload(store, { ...storage, maxFileSizeBytes: 4 }, 'viewer', 'path', saved.reference)).upload.size, 4);

  await assert.rejects(
    uploads.saveUploadStream(
      store,
      { ...storage, maxFileSizeBytes: 4 },
      'viewer',
      'path',
      'large.csv',
      stream('ab', 'cde'),
    ),
    /5 GB/,
  );
  await assert.rejects(
    uploads.saveUploadStream(store, storage, 'viewer', 'path', 'empty.csv', stream()),
    /non-empty/,
  );
  await assert.rejects(
    uploads.saveUploadStream(
      store,
      storage,
      'viewer',
      'path',
      'interrupted.csv',
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('a'));
          controller.error(new Error('disconnected'));
        },
      }),
    ),
    /disconnected/,
  );
  assert.equal([...store.files.keys()].filter((path) => /large|empty|interrupted/.test(path)).length, 0);
});

test('rejects unsafe filenames and declared sizes', async () => {
  const store = memoryStore();
  for (const filename of ['', ' ', '.', '..', '../data.csv', 'a\\b.csv', 'a\n.csv', 'é'.repeat(128)]) {
    await assert.rejects(uploads.saveUpload(store, storage, 'viewer', 'path', filename, Buffer.from('a')), /valid filename/);
  }
  await assert.rejects(
    uploads.saveUpload(store, { ...storage, maxFileSizeBytes: 1 }, 'viewer', 'path', 'data.csv', Buffer.from('aa')),
    /at most/,
  );
  assert.equal(store.files.size, 0);
});

for (const filename of ['data.csv', 'workbook.xlsx', 'workbook.xls', 'data.json', 'data.parquet', 'data.csv.gz', 'データ.xlsx', 'data']) {
  test(`preserves ${filename}, its bytes and its reference through job parameter resolution`, async () => {
    const store = memoryStore();
    const viewer = uploads.viewerKey('alice', '100');
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const saved = await uploads.saveUpload(store, storage, viewer, 'path', filename, bytes);
    const resolved = await uploads.resolveUpload({ ...store }, storage, viewer, 'path', saved.reference);
    assert.ok(resolved.path.endsWith(`/${saved.reference.slice('upload:'.length)}/${filename}`));
    assert.deepEqual(store.files.get(resolved.path), bytes);
    assert.deepEqual(await parameters.resolveRunParameters(manifest, { path: saved.reference }, viewer, store), {
      ok: true,
      params: {
        path: resolved.path,
        ld_display_outputs_for: 'source',
        _lb_collect_row_counts: 'true',
        _lb_app_viewer: viewer,
      },
    });
    assert.equal(store.files.size, 2);
  });
}

test('refuses an upload whose completion record contains an invalid filename', async () => {
  const store = memoryStore();
  const viewer = uploads.viewerKey('alice', '100');
  const saved = await uploads.saveUpload(store, storage, viewer, 'path', 'data.json', Buffer.from('{}'));
  const id = saved.reference.slice('upload:'.length);
  const sidecar = [...store.files.keys()].find((path) => path.endsWith(`/${id}.json`));
  store.files.set(sidecar, Buffer.from(JSON.stringify({ ...saved, filename: '../other.json' })));
  await assert.rejects(uploads.resolveUpload(store, storage, viewer, 'path', saved.reference), /incomplete or unreadable/);
});

test('run ownership protects history, results and cancellation even after upload inputs are removed', () => {
  const alice = uploads.viewerKey('alice', '100');
  const bob = uploads.viewerKey('bob', '100');
  const privateRun = { overriding_parameters: { notebook_params: { _lb_app_viewer: alice } } };
  for (const privateApp of [true, false]) {
    assert.equal(uploads.canAccessRun(privateRun, alice, privateApp), true);
    assert.equal(uploads.canAccessRun(privateRun, bob, privateApp), false);
    assert.equal(uploads.canAccessRun(privateRun, undefined, privateApp), false);
  }
  assert.equal(uploads.canAccessRun({}, alice, true), false);
  assert.equal(uploads.canAccessRun({}, alice, false), true);
  assert.equal(uploads.viewerKey(undefined, '100'), undefined);
  assert.equal(uploads.viewerKey(' ', '100'), undefined);
});

test('validates versioned storage and never initializes a file input with the author path', () => {
  assert.deepEqual(config.parseUploads(storage), storage);
  for (const invalid of [
    undefined,
    { ...storage, volume: 'a.b' },
    { ...storage, path: '/Volumes/other/default/uploads/designer_uploads/app1' },
    { ...storage, path: storage.path + '/../escape' },
    { ...storage, maxFileSizeBytes: 5 * 1024 * 1024 * 1024 + 1 },
  ]) {
    assert.equal(config.parseUploads(invalid), undefined);
  }
  const parsed = appConfig.parseAppManifest(manifest);
  assert.equal(parsed.version, 4);
  assert.equal(parsed.parameters[0].defaultValue, '');
  assert.deepEqual(appConfig.initialValuesFor(parsed, { path: '/Volumes/private/file.csv' }), { path: '' });
  assert.deepEqual(appConfig.initialValuesFor(parsed, { path: 'upload:829dcaa7-e505-49c1-b6d0-73d1841e990a' }), {
    path: '',
  });
  assert.equal(appConfig.parseAppManifest({ ...manifest, version: 3 }), undefined);
  assert.equal(appConfig.parseAppManifest({ ...manifest, uploads: undefined }), undefined);
  assert.equal(appConfig.parseAppManifest({ ...manifest, version: 3, uploads: undefined }), undefined);
  const regular = appConfig.parseAppManifest({
    ...manifest,
    version: 3,
    uploads: undefined,
    parameters: [{ ...fileParameter, type: 'text' }],
  });
  assert.equal(regular.parameters[0].defaultValue, fileParameter.defaultValue);
});

test('ordinary parameters retain defaults and dropdown validation without ownership metadata', async () => {
  const regular = {
    parameters: [{ name: 'choice', label: 'Choice', type: 'dropdown', defaultValue: 'A', choices: ['A', 'B'] }],
  };
  assert.deepEqual(await parameters.resolveRunParameters(regular, {}, undefined, memoryStore()), {
    ok: true,
    params: { choice: 'A' },
  });
  assert.equal((await parameters.resolveRunParameters(regular, { choice: 'C' }, undefined, memoryStore())).ok, false);
});
