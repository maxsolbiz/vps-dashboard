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

test('private files/dirs request 0600/0700 modes', () => {
  const fs = require('fs');
  const fsutil = require('../lib/fsutil');
  const calls = [];
  const orig = fs.chmodSync;
  fs.chmodSync = (...a) => { calls.push(a); try { return orig(...a); } catch (_) {} };
  try {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-perm-')), 'data');
    fsutil.writePrivate(path.join(dir, 'f.json'), '{}');
    fsutil.ensureDir(path.join(dir, 'sub'));
    assert.ok(fs.existsSync(path.join(dir, 'f.json')), 'file written');
  } finally {
    fs.chmodSync = orig;
  }
  const modes = calls.map(([, m]) => m);
  assert.ok(modes.includes(0o700), `dir 0700 requested, got ${modes.join(',')}`);
  assert.ok(modes.includes(0o600), `file 0600 requested, got ${modes.join(',')}`);
});

test('parseSystemStat reads the aggregate cpu line and ignores cpuN', () => {
  const p = cpustat.parseSystemStat(
    'cpu  1000 20 300 8000 100 0 50 0 0 0\n' +
    'cpu0 500 10 150 4000 50 0 25 0 0 0\n' +
    'intr 12345'
  );
  assert.equal(p.user, 1000);
  assert.equal(p.nice, 20);
  assert.equal(p.system, 300);
  assert.equal(p.idle, 8000);
  assert.equal(p.iowait, 100);
  assert.equal(p.total, 1000 + 20 + 300 + 8000 + 100 + 0 + 50);
  // A file with no aggregate line is unusable, not zero.
  assert.equal(cpustat.parseSystemStat('intr 1\nctxt 2'), null);
  assert.equal(cpustat.parseSystemStat(''), null);
  assert.equal(cpustat.parseSystemStat(null), null);
});

test('systemCpuPct measures true whole-box busy time, not a per-process sum', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-procstat-'));
  const statFile = path.join(root, 'stat');
  process.env.PANEL_PROC_ROOT = root;
  const write = (u, n, s, idle) => fs.writeFileSync(statFile, `cpu  ${u} 0 ${s} ${idle} 0 0 0 0 0 0\n`);
  try {
    cpustat._reset();
    // First call establishes the baseline and must NOT invent a number.
    write(100, 100, 800, 0);
    assert.equal(cpustat.systemCpuPct(1000), null, 'no baseline yet -> null');

    // Advance 100 user, 0 system, 900 idle out of 1000 total ticks => 10% busy.
    write(200, 100, 800, 900);
    assert.equal(cpustat.systemCpuPct(2000), 10);

    // Fully idle window => 0%.
    write(200, 100, 800, 1900);
    assert.equal(cpustat.systemCpuPct(3000), 0);

    // Half busy => 50%.
    write(700, 100, 800, 2400);
    assert.equal(cpustat.systemCpuPct(4000), 50);
  } finally {
    delete process.env.PANEL_PROC_ROOT;
    cpustat._reset();
  }
});

test('systemCpuPct folds iowait into idle and clamps to 0..100', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-procstat2-'));
  const statFile = path.join(root, 'stat');
  process.env.PANEL_PROC_ROOT = root;
  //            user nice system idle iowait irq softirq steal
  const line = (u, i, w) => `cpu  ${u} 0 0 ${i} ${w} 0 0 0 0 0\n`;
  try {
    cpustat._reset();
    // baseline: 100 idle, no user time
    fs.writeFileSync(statFile, line(0, 100, 0));
    assert.equal(cpustat.systemCpuPct(1000), null);

    // 50 user + 50 idle over 100 ticks => 50% busy.
    fs.writeFileSync(statFile, line(50, 150, 0));
    assert.equal(cpustat.systemCpuPct(2000), 50);

    // 100 ticks that are ALL iowait: iowait is not busy, so this must be 0%.
    // Without the iowait fold this would incorrectly read as 50% busy.
    fs.writeFileSync(statFile, line(50, 150, 100));
    assert.equal(cpustat.systemCpuPct(3000), 0, 'iowait must not count as busy');

    // Busy can never exceed 100 even with odd counters.
    fs.writeFileSync(statFile, line(1000, 0, 0));
    const v = cpustat.systemCpuPct(4000);
    assert.ok(v === null || (v >= 0 && v <= 100), `clamped or null, got ${v}`);
  } finally {
    delete process.env.PANEL_PROC_ROOT;
    cpustat._reset();
  }
});

test('systemCpuPct returns null when /proc/stat is unreadable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-procstat3-'));
  process.env.PANEL_PROC_ROOT = root; // exists, but has no `stat` file
  try {
    cpustat._reset();
    assert.equal(cpustat.systemCpuPct(1000), null);
    assert.equal(cpustat.systemCpuPct(2000), null);
  } finally {
    delete process.env.PANEL_PROC_ROOT;
    cpustat._reset();
  }
});

test('sampler exposes whole-box CPU and clears it on reset', async () => {
  sampler._reset();
  const cold = sampler.latest();
  assert.equal(cold.system, null, 'cold sampler has no system reading');
  assert.equal(Object.prototype.hasOwnProperty.call(cold, 'system'), true, 'key always present');
  sampler.stop();
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
