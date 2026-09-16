#!/usr/bin/env node
// TEMP diagnostic (remove after reading /logz): report the npm registry the build sandbox
// resolves against, and whether it serves the react-markdown tree vs a control package.
// Must never fail the install, so everything is guarded and it always exits 0.
import { execSync } from 'node:child_process';

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return `FAILED(${err.code || err.signal || 'error'}): ${String(err.stderr || err.message || '').slice(0, 200)}`;
  }
};

try {
  console.log('===== PREINSTALL DIAG START =====');
  console.log('node              :', process.version);
  console.log('effective registry:', run('npm config get registry'));
  console.log('userconfig path   :', run('npm config get userconfig'));
  console.log('react (control)   :', run('npm view react version')); // sibling ships this -> should succeed
  console.log('react-markdown    :', run('npm view react-markdown version')); // the suspect
  console.log('micromark         :', run('npm view micromark version')); // deep in the react-markdown tree
  console.log('===== PREINSTALL DIAG END =====');
} catch (err) {
  console.log('preinstall diag error (ignored):', err && err.message);
}
process.exit(0);
