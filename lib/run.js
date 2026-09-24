'use strict';

// The ONLY way the panel executes anything. execFile with a fixed argv,
// no shell, no interpolation, strict timeouts. Callers pass pre-validated
// argv elements; anything else is rejected here.
const { execFile } = require('child_process');

const MAX_BUFFER = 4 * 1024 * 1024;

function runBin(spec, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const [cmd, ...prefix] = spec;
    const argv = [...prefix, ...args];
    for (const a of argv) {
      if (typeof a !== 'string' || /[\0\n\r]/.test(a)) {
        reject(new Error('invalid argv element'));
        return;
      }
    }
    execFile(cmd, argv, { timeout: timeoutMs || 15000, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().slice(0, 500);
        const e = new Error(`command failed: ${cmd} ${args[0] || ''}: ${msg}`);
        e.code = err.code;
        reject(e);
        return;
      }
      resolve(stdout || '');
    });
  });
}

module.exports = { runBin };
