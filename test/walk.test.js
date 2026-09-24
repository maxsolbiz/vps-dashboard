'use strict';
// walk.js: no-stat Dirent traversal, per-dir caps, per-root budgets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const walk = require('../lib/walk');

function mktree(root, spec) {
  // spec: { 'rel/dir': ['file1', ...] }
  for (const [d, files] of Object.entries(spec)) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(root, d, f), '{}');
  }
}

test('5000-file directory does not stall or error the walk', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-walk-'));
  const big = path.join(root, 'uploads');
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(big, `f${i}.dat`), 'x');
  mktree(root, { app: ['package.json'] });
  const t0 = Date.now();
  const { found } = walk.walk([root]);
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `walk took ${ms} ms`);
  assert.ok(found.some((f) => f.dir.endsWith('app')), 'sibling project still found');
  assert.ok(!found.some((f) => f.dir.endsWith('uploads')), 'uploads dir is not a project');
});

test('per-directory cap bounds descent into huge trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-walkcap-'));
  const parent = path.join(root, 'many');
  fs.mkdirSync(parent, { recursive: true });
  for (let i = 0; i < 2100; i++) {
    const d = path.join(parent, `d${i}`);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
  }
  const { found } = walk.walk([root]);
  assert.ok(found.length <= walk.MAX_ENTRIES_PER_DIR + 1, `capped, got ${found.length}`);
  assert.ok(found.length >= 1000, `still finds plenty, got ${found.length}`);
});

test('symlinked dirs are not descended into', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-walksym-'));
  const real = path.join(root, 'real');
  mktree(root, { 'real/inner': ['package.json'] });
  try {
    fs.symlinkSync(real, path.join(root, 'link'), 'dir');
  } catch (_) {
    return; // symlink creation needs privileges on some setups; skip
  }
  const { found } = walk.walk([root]);
  const dirs = found.map((f) => f.dir);
  assert.ok(!dirs.some((d) => d.includes('link')), 'symlink not followed');
  assert.ok(dirs.some((d) => d.endsWith('inner')), 'real dir still walked');
});

test('a huge first root cannot starve later roots (per-root budget)', () => {
  const r1 = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-walkt1-'));
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-walkc2-'));
  for (let i = 0; i < 11000; i++) fs.writeFileSync(path.join(r1, `f${i}.dat`), 'x');
  mktree(r2, { app: ['package.json'] });
  // 2 roots -> 10000 entries each; r1 exceeds it, r2 must still be scanned.
  const { found, truncated } = walk.walk([r1, r2]);
  assert.equal(truncated, true, 'truncation flagged');
  assert.ok(found.some((f) => f.dir.endsWith('app')), 'second root still scanned');
});
