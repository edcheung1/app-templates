import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginDirectory = 'server/plugins/designer';
const lockPath = 'designer-plugin.lock.json';
const itemPath = 'public/r/designer.json';
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

async function installedHashes(root) {
  async function visit(directory) {
    const files = await Promise.all(
      (await readdir(join(root, directory), { withFileTypes: true })).map(async (entry) => {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return visit(path);
        assert(entry.isFile(), `Expected a regular plugin file: ${path}`);
        return [[path, sha256(await readFile(join(root, path)))]];
      })
    );
    return files.flat();
  }
  return Object.fromEntries((await visit(pluginDirectory)).sort(([a], [b]) => a.localeCompare(b)));
}

function assertFilesMatch(actual, expected) {
  const differences = [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .filter((path) => actual[path] !== expected[path])
    .map((path) => `${!actual[path] ? 'Missing' : !expected[path] ? 'Unexpected' : 'Changed'}: ${path}`);
  assert.equal(
    differences.length,
    0,
    `Installed Designer plugin differs from its source pin:\n${differences.join('\n')}`
  );
}

export async function checkDesignerPlugin(root = templateRoot) {
  const lock = JSON.parse(await readFile(join(root, lockPath), 'utf8'));
  assert.match(lock.source.commit, /^[0-9a-f]{40}$/);
  assert.match(lock.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(lock.source.path, itemPath);
  assertFilesMatch(await installedHashes(root), lock.files);
  return lock;
}

async function recordDesignerPlugin(registryRoot) {
  const git = (...args) => execFileSync('git', ['-C', registryRoot, ...args], { encoding: 'utf8' });
  const commit = git('rev-parse', 'HEAD').trim();
  // Read committed bytes, so an uncommitted registry build cannot be attributed to HEAD.
  const content = git('show', `${commit}:${itemPath}`);
  const item = JSON.parse(content);
  assert.equal(item.name, 'designer');
  const files = Object.fromEntries(
    item.files.map((file) => {
      assert(file.target.startsWith('plugins/designer/') && !file.target.split('/').includes('..'));
      return [`server/${file.target}`, sha256(file.content)];
    })
  );
  assertFilesMatch(await installedHashes(templateRoot), files);
  const lock = {
    source: {
      repository: 'https://github.com/databricks/appkit-registry',
      commit,
      path: itemPath,
      sha256: sha256(content),
    },
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(join(templateRoot, lockPath), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(
      args.length === 0 || (args.length === 2 && args[0] === '--record'),
      'Usage: node scripts/check-designer-plugin.mjs [--record /path/to/appkit-registry]'
    );
    const lock = args.length ? await recordDesignerPlugin(args[1]) : await checkDesignerPlugin();
    console.log(
      `Designer plugin: ${Object.keys(lock.files).length} files match registry commit ${lock.source.commit}.`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
