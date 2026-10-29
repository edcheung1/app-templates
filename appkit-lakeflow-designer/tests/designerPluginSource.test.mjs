import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkDesignerPlugin } from '../scripts/check-designer-plugin.mjs';

test('source check accepts installed bytes and detects changed, missing, and additional files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'designer-source-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = 'server/plugins/designer/index.ts';
  const content = "export { designer } from './designer';\n";
  await mkdir(join(root, 'server/plugins/designer'), { recursive: true });
  const lock = {
    source: { commit: 'a'.repeat(40), path: 'public/r/designer.json', sha256: 'b'.repeat(64) },
    files: { [file]: createHash('sha256').update(content).digest('hex') },
  };
  await writeFile(join(root, 'designer-plugin.lock.json'), JSON.stringify(lock));
  await writeFile(join(root, file), content);
  assert.deepEqual(await checkDesignerPlugin(root), lock);

  await writeFile(join(root, file), 'export const designer = undefined;\n');
  await assert.rejects(checkDesignerPlugin(root), /Changed: server\/plugins\/designer\/index.ts/);
  await rm(join(root, file));
  await assert.rejects(checkDesignerPlugin(root), /Missing: server\/plugins\/designer\/index.ts/);
  await writeFile(join(root, file), content);
  await writeFile(join(root, 'server/plugins/designer/extra.ts'), 'export {};\n');
  await assert.rejects(checkDesignerPlugin(root), /Unexpected: server\/plugins\/designer\/extra.ts/);
});
