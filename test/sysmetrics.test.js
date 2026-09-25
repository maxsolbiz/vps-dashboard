'use strict';
// Whole-system metric parsers (/proc) + the in-memory history ring buffer.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sysm = require('../lib/sysmetrics');
const history = require('../lib/history');

test('parseProcStat reads aggregate, per-core, ctxt and procs-created', () => {
  const p = sysm.parseProcStat(
    'cpu  100 10 50 800 20 5 6 7 0 0 0\n' +
    'cpu0 50 5 25 400 10 2 3 3 0 0 0\n' +
    'cpu1 50 5 25 400 10 3 3 4 0 0 0\n' +
    'intr 12345 0 0\n' +
    'ctxt 987654\n' +
    'processes 4242\n' +
    'procs_running 3\n'
  );
  assert.equal(p.total.user, 100);
  assert.equal(p.total.idle, 800);
  assert.equal(p.total.iowait, 20);
  assert.equal(p.total.ctxt, 987654);
  assert.equal(p.total.procsCreated, 4242);
  assert.equal(p.cores.length, 2);
  assert.deepEqual(p.cores.map((c) => c.id), ['cpu0', 'cpu1']);
});

test('busyPct treats iowait as idle and returns null without a baseline', () => {
  const before = { total: 1000, idle: 600, iowait: 100 };
  // 200 ticks pass, 100 of them iowait -> those count as idle, so 50% busy.
  const after = { total: 1200, idle: 600, iowait: 200 };
  assert.equal(sysm.busyPct(before, after), 50);
  assert.equal(sysm.busyPct(null, after), null, 'no baseline -> null, never a guess');
  assert.equal(sysm.busyPct(after, after), null, 'zero elapsed -> null');
  // iowait must not read as busy
  assert.equal(sysm.busyPct({ total: 1000, idle: 100, iowait: 0 },
    { total: 1200, idle: 100, iowait: 200 }), 0);
});

test('perCorePct reports each logical core independently', () => {
  const before = [{ id: 'cpu0', total: 1000, idle: 500 }, { id: 'cpu1', total: 1000, idle: 500 }];
  // Both cores gain 200 ticks; cpu0 gives 150 back to idle, cpu1 only 50.
  const after = [{ id: 'cpu0', total: 1200, idle: 650 }, { id: 'cpu1', total: 1200, idle: 550 }];
  const out = sysm.perCorePct(before, after);
  assert.equal(out.length, 2);
  assert.equal(out.find((c) => c.id === 'cpu0').pct, 25, 'cpu0: 50 busy of 200');
  assert.equal(out.find((c) => c.id === 'cpu1').pct, 75, 'cpu1: 150 busy of 200');
  assert.deepEqual(sysm.perCorePct([], after), []);
  // A core whose counter went backwards is skipped, never reported as 0%.
  const wrapped = sysm.perCorePct(before, [{ id: 'cpu0', total: 10, idle: 5 }]);
  assert.equal(wrapped.length, 0, 'wrapped counter produces no reading');
});

test('parseLoadavg extracts load averages and process counts', () => {
  const l = sysm.parseLoadavg('0.30 0.11 0.04 3/336 3745754\n');
  assert.equal(l.load1, 0.30);
  assert.equal(l.load5, 0.11);
  assert.equal(l.load15, 0.04);
  assert.equal(l.running, 3);
  assert.equal(l.procs, 336);
  assert.equal(sysm.parseLoadavg('garbage'), null);
});

test('parseNetDev reads byte/packet counters per interface', () => {
  const t = 'Inter-|   Receive                        |  Transmit\n' +
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n' +
    '    lo: 100 10 0 0 0 0 0 0 100 10 0 0 0 0 0 0\n' +
    '  eth0: 2000 20 1 2 0 0 0 0 3000 30 0 0 0 0 0 0\n';
  const n = sysm.parseNetDev(t);
  assert.equal(n.lo.rxBytes, 100);
  assert.equal(n.eth0.rxBytes, 2000);
  assert.equal(n.eth0.txBytes, 3000);
  assert.equal(n.eth0.rxErrs, 1);
  assert.equal(n.eth0.txPackets, 30);
  assert.deepEqual(sysm.parseNetDev(''), {});
});

test('ratePerSec returns null on a wrapped or zero-time counter', () => {
  assert.equal(sysm.ratePerSec(1000, 3000, 2), 1000);
  assert.equal(sysm.ratePerSec(3000, 1000, 2), null, 'counter wrap -> null');
  assert.equal(sysm.ratePerSec(1000, 3000, 0), null, 'no elapsed time -> null');
});

test('parseTcpStates buckets connections and ignores the header', () => {
  // st is field 4; 0A listen, 01 established, 06 timeWait
  const t = '  sl  local_address rem_address   st\n' +
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  100 0 0 100 0 0 0 10 0\n' +
    '   1: 0100007F:1F91 0200007F:C350 01 00000000:00000000 00:00000000 00000000  100 0 0 100 0 0 0 10 0\n' +
    '   2: 0100007F:1F92 0200007F:C351 06 00000000:00000000 00:00000000 00000000  100 0 0 100 0 0 0 10 0\n' +
    '   3: 0100007F:1F93 0200007F:C352 02 00000000:00000000 00:00000000 00000000  100 0 0 100 0 0 0 10 0\n';
  const c = sysm.parseTcpStates(t);
  assert.equal(c.total, 4);
  assert.equal(c.listen, 1);
  assert.equal(c.established, 1);
  assert.equal(c.timeWait, 1);
  assert.equal(c.other, 1, 'unmapped states are counted, not dropped');
  assert.equal(sysm.parseTcpStates('header only').total, 0);
});

test('parseVmstat reads OOM kills and major faults', () => {
  const v = sysm.parseVmstat('pgmajfault 392629\npgpgin 12345\n' + 'oom_kill 0\n');
  assert.equal(v.oomKill, 0);
  assert.equal(v.majFault, 392629);
  assert.equal(sysm.parseVmstat('nothing').oomKill, null, 'absent key -> null, not 0');
});

test('sample() degrades safely when /proc is unavailable', () => {
  const orig = process.env.PANEL_PROC_ROOT;
  process.env.PANEL_PROC_ROOT = '/definitely/not/proc';
  try {
    sysm._reset();
    const s = sysm.sample();
    assert.ok(s.at, 'still returns a timestamped sample');
    assert.equal(s.procs, null, 'no /proc -> null, never fabricated');
    assert.equal(s.cpuCores, null);
    assert.doesNotThrow(() => sysm.sample(2000), 'second call is safe too');
  } finally {
    if (orig === undefined) delete process.env.PANEL_PROC_ROOT; else process.env.PANEL_PROC_ROOT = orig;
    sysm._reset();
  }
});

test('history keeps a bounded ring and reports stats', () => {
  history.clear();
  for (let i = 0; i < history.cap() + 50; i++) {
    history.push({ at: new Date(Date.now() + i * 1000).toISOString(), cpu: i % 100, mem: 50, load: 1 });
  }
  assert.equal(history.size(), history.cap(), 'buffer never exceeds its cap');
  const s = history.stats('cpu');
  assert.ok(s.n > 0);
  assert.ok(s.min <= s.cur && s.max >= s.cur, 'min/max bracket the current value');
  history.clear();
  assert.equal(history.size(), 0);
  assert.equal(history.stats('cpu'), null, 'no data -> null, not a fake zero');
});

test('history range filter returns only recent rows', () => {
  history.clear();
  const now = Date.now();
  history.push({ at: new Date(now - 600000).toISOString(), cpu: 1 });  // 10 min old
  history.push({ at: new Date(now - 5000).toISOString(), cpu: 2 });    // 5 s old
  assert.equal(history.get(60000).length, 1, 'range trims old rows');
  assert.equal(history.get(0).length, 2, 'no range returns everything');
  history.clear();
});

test('history rejects malformed samples without growing the buffer', () => {
  history.clear();
  history.push(null);
  history.push({});
  history.push({ cpu: 50 });
  assert.equal(history.size(), 0, 'samples without a timestamp are ignored');
  history.clear();
});
