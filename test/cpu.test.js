'use strict';
// CPU delta math + stat parser + status map + shared sampler unit tests.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sampler fixture binaries must be wired before lib/config is first required.
const SAMPLER_FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sampler-'));
fs.writeFileSync(path.join(SAMPLER_FIX, 'ps.txt'),
  '    1     0    2000  0.0 100000 /sbin/init\n' +
  '   10     1    5000  0.0 50000 node /srv/a/index.js\n');
process.env.PANEL_BIN_PS = `node ${path.join(__dirname, 'bin', 'ps')}`;
process.env.PANEL_FAKE_PS = path.join(SAMPLER_FIX, 'ps.txt');
process.env.PANEL_SAMPLER = '0';

const cpustat = require('../lib/cpustat');
const sampler = require('../lib/cpusampler');
const statuslib = require('../lib/status');

function writeProcStat(root, pid, utime, stime, comm = 'node') {
  const pdir = path.join(root, String(pid));
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'stat'),
    `${pid} (${comm}) R 1 ${pid} ${pid} 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-cpu-'));
  process.env.PANEL_PROC_ROOT = dir;
  process.env.PANEL_CLK_TCK = '100';
  cpustat._reset();
});

function writeStat(pid, utime, stime, comm = 'node') {
  writeProcStat(dir, pid, utime, stime, comm);
}

test('parseStat handles comm with spaces and parens', () => {
  const s = cpustat.parseStat('103 (next-server (v16)) R 101 103 103 0 -1 0 0 0 0 0 250 60 0 0 20 0 1 0 0\n');
  assert.equal(s.utime, 250);
  assert.equal(s.stime, 60);
  assert.equal(s.total, 310);
});

test('parseStat rejects garbage', () => {
  assert.throws(() => cpustat.parseStat('nope'), /bad stat/);
});

test('delta over 1 s: +5 ticks at 100 ticks/s = 5%', () => {
  writeStat(1, 100, 20);
  const first = cpustat.sample([1], 0);
  assert.equal(first.fresh, false, 'no baseline on first call');
  writeStat(1, 104, 21); // +5 ticks
  const second = cpustat.sample([1], 1000);
  assert.equal(second.fresh, true);
  assert.equal(second.pct.get(1), 5);
  assert.equal(cpustat.sumTree(second.pct, [1]), 5);
});

test('missing pid contributes nothing; reused pid (ticks go back) skipped', () => {
  writeStat(1, 100, 0);
  cpustat.sample([1, 999], 0);
  writeStat(1, 90, 0); // ticks decreased: pid reuse
  const second = cpustat.sample([1, 999], 1000);
  assert.equal(second.pct.has(1), false);
  assert.equal(second.pct.has(999), false);
});

test('shared sampler: rapid reads are identical, tick delta computes', async () => {
  const root = path.join(SAMPLER_FIX, 'proc');
  process.env.PANEL_PROC_ROOT = root;
  sampler._reset();
  writeProcStat(root, 10, 100, 20);
  await sampler._tick(0); // baseline
  writeProcStat(root, 10, 130, 26); // +36 ticks
  await sampler._tick(5100); // 5.1 s window: 36/100/5.1*100 = 7.1
  const a = sampler.latest();
  const b = sampler.latest();
  assert.equal(a.fresh, true);
  assert.deepEqual([...b.pct.entries()], [...a.pct.entries()], 'reads never advance the baseline');
  assert.equal(a.pct.get(10), 7.1);
  sampler._reset();
  assert.equal(sampler.latest().fresh, false);
});

test('shared sampler: sub-2 s windows keep the previous value', async () => {
  const root = path.join(SAMPLER_FIX, 'proc');
  process.env.PANEL_PROC_ROOT = root;
  sampler._reset();
  writeProcStat(root, 10, 100, 20);
  await sampler._tick(0);
  writeProcStat(root, 10, 1000, 200); // huge jump, but only 100 ms later
  await sampler._tick(100);
  const snap = sampler.latest();
  assert.equal(snap.fresh, false, 'no valid window yet');
  assert.equal(snap.pct.size, 0, 'short window does not commit a pct');
  writeProcStat(root, 10, 1100, 220);
  await sampler._tick(5100); // 5100-100 = 5000 ms window vs tick@100: (100+20)/100/5 = 24
  const snap2 = sampler.latest();
  assert.equal(snap2.fresh, true);
  assert.equal(snap2.pct.get(10), 24);
  sampler._reset();
});

test('shared sampler: start/stop lifecycle', async () => {
  const root = path.join(SAMPLER_FIX, 'proc');
  process.env.PANEL_PROC_ROOT = root;
  writeProcStat(root, 10, 200, 40);
  sampler._reset();
  sampler.start(30);
  try {
    let snap = null;
    for (let i = 0; i < 100 && !snap; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const l = sampler.latest();
      if (l.procs) snap = l;
    }
    assert.ok(snap, 'background tick populated the snapshot');
    assert.ok(snap.procs.some((p) => p.pid === 10), 'snapshot lists the node proc');
  } finally {
    sampler.stop();
  }
  assert.equal(sampler.latest().procs, null);
});

test('status map never reports crash loops as stopped', () => {
  assert.equal(statuslib.mapStatus('online'), 'running');
  assert.equal(statuslib.mapStatus('stopped'), 'stopped');
  assert.equal(statuslib.mapStatus('errored'), 'errored');
  assert.equal(statuslib.mapStatus('launching'), 'launching');
  assert.equal(statuslib.mapStatus('waiting restart'), 'restarting');
  assert.equal(statuslib.mapStatus('stopping'), 'restarting');
  assert.equal(statuslib.mapStatus('one-launch-status'), 'restarting');
  assert.equal(statuslib.isLive('restarting'), true);
  assert.equal(statuslib.isLive('stopped'), false);
  assert.equal(statuslib.isLive('errored'), false);
});
