'use strict';

// Cheap whole-system metrics for the monitoring dashboard.
//
// Everything here comes from small /proc files that the kernel already
// maintains, so sampling costs a few file reads and no extra processes. Every
// rate is computed from a previous sample held in memory; the first call after
// a restart has no baseline and reports null rather than a guess.
//
// Parsers are pure and exported so they can be tested without a real /proc.

const fs = require('fs');
const path = require('path');

function procRoot() {
  return process.env.PANEL_PROC_ROOT || '/proc';
}
function read(name) {
  try {
    return fs.readFileSync(path.join(procRoot(), name), 'utf8');
  } catch (_) {
    return null;
  }
}

const num = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

// ---------- /proc/stat ----------
// Returns the aggregate line plus one entry per logical core.
function parseProcStat(text) {
  const lines = String(text).split('\n');
  let total = null;
  const cores = [];
  for (const line of lines) {
    if (/^cpu\s/.test(line)) {
      const f = line.trim().split(/\s+/);
      const n = (i) => num(f[i]);
      total = {
        user: n(1), nice: n(2), system: n(3), idle: n(4), iowait: n(5),
        irq: n(6), softirq: n(7), steal: n(8), guest: n(9), guestNice: n(10),
        total: f.slice(1).reduce((a, v) => a + num(v), 0)
      };
    } else if (/^cpu\d+\s/.test(line)) {
      const f = line.trim().split(/\s+/);
      const n = (i) => num(f[i]);
      cores.push({ id: f[0], total: f.slice(1).reduce((a, v) => a + num(v), 0), idle: n(4) + n(5) });
    } else if (/^ctxt\s/.test(line)) {
      total = total || {};
      total.ctxt = num(line.trim().split(/\s+/)[1]);
    } else if (/^processes\s/.test(line)) {
      total = total || {};
      total.procsCreated = num(line.trim().split(/\s+/)[1]);
    }
  }
  return { total, cores };
}

// Busy percent between two stat snapshots. iowait counts as idle, matching
// the whole-system figure the CPU card already shows.
function busyPct(before, after) {
  if (!before || !after) return null;
  const dTotal = after.total - before.total;
  const dIdle = (after.idle - before.idle) + (after.iowait - before.iowait);
  if (!(dTotal > 0)) return null;
  const pct = ((dTotal - dIdle) / dTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}
function perCorePct(beforeCores, afterCores) {
  if (!beforeCores || !beforeCores.length || !afterCores) return [];
  const byId = new Map(beforeCores.map((c) => [c.id, c]));
  const out = [];
  for (const c of afterCores) {
    const b = byId.get(c.id);
    if (!b) continue;
    const dTotal = c.total - b.total;
    const dIdle = c.idle - b.idle;
    if (!(dTotal > 0)) continue;
    out.push({ id: c.id, pct: Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10)) });
  }
  return out;
}

// ---------- /proc/loadavg ----------
// "0.30 0.11 0.04 1/336 3745754" -> running/total processes, last pid.
function parseLoadavg(text) {
  const f = String(text).trim().split(/\s+/);
  if (f.length < 4) return null;
  const [running, total] = f[3].split('/');
  return {
    load1: parseFloat(f[0]), load5: parseFloat(f[1]), load15: parseFloat(f[2]),
    running: num(running), procs: num(total), lastPid: num(f[4])
  };
}

// ---------- /proc/net/dev ----------
// Byte counters per interface; totals are absolute, rates need a baseline.
function parseNetDev(text) {
  const out = {};
  for (const line of String(text).split('\n').slice(2)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const f = line.slice(idx + 1).trim().split(/\s+/);
    if (f.length < 9) continue;
    out[name] = { rxBytes: num(f[0]), rxPackets: num(f[1]), rxErrs: num(f[2]), rxDrop: num(f[3]),
      txBytes: num(f[8]), txPackets: num(f[9]), txErrs: num(f[10]), txDrop: num(f[11]) };
  }
  return out;
}
function ratePerSec(before, after, seconds) {
  if (!before || !after || !(seconds > 0)) return null;
  const d = after - before;
  if (d < 0) return null; // counter wrapped
  return Math.round(d / seconds);
}

// ---------- /proc/net/tcp + tcp6 ----------
const TCP_STATES = { '01': 'established', '02': 'synSent', '03': 'synRecv', '04': 'finWait1',
  '05': 'finWait2', '06': 'timeWait', '07': 'close', '08': 'closeWait', '09': 'lastAck', '0A': 'listen', '0B': 'closing' };
function parseTcpStates(text) {
  const counts = { total: 0, listen: 0, established: 0, timeWait: 0, other: 0 };
  const lines = String(text).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 4) continue;
    const st = TCP_STATES[f[3]] || 'other';
    counts.total++;
    if (st === 'listen') counts.listen++;
    else if (st === 'established') counts.established++;
    else if (st === 'timeWait') counts.timeWait++;
    else counts.other++;
  }
  return counts;
}
function parseTcpStates6(text) { return parseTcpStates(text); }

// ---------- /proc/vmstat ----------
function parseVmstat(text) {
  const out = { oomKill: null, majFault: null };
  for (const line of String(text).split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k === 'oom_kill') out.oomKill = num(v);
    if (k === 'pgmajfault') out.majFault = num(v);
  }
  return out;
}

// ---------- combined sample ----------
let prev = null;

function sample(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const stat = parseProcStat(read('stat') || '');
  const load = parseLoadavg(read('loadavg') || '');
  const net = parseNetDev(read('net/dev') || '');
  const tcp = parseTcpStates(read('net/tcp') || '');
  const tcp6 = parseTcpStates6(read('net/tcp6') || '');
  const vm = parseVmstat(read('vmstat') || '');

  const out = {
    at: new Date(now).toISOString(),
    cores: [],
    procs: load ? load.procs : null,
    running: load ? load.running : null,
    conns: {
      total: tcp.total + tcp6.total,
      established: tcp.established + tcp6.established,
      timeWait: tcp.timeWait + tcp6.timeWait,
      listen: tcp.listen + tcp6.listen
    },
    oomKill: vm.oomKill,
    net: {},
    cpuCores: null
  };
  if (stat && stat.total) {
    out.ctxt = stat.total.ctxt == null ? null : stat.total.ctxt;
    out.procsCreated = stat.total.procsCreated == null ? null : stat.total.procsCreated;
  }

  const before = prev;
  prev = { at: now, stat, net };
  if (!before) return out;
  const seconds = (now - before.at) / 1000;
  if (!(seconds > 0)) return out;

  if (stat && before.stat) {
    out.cpuCores = perCorePct(before.stat.cores, stat.cores);
    out.cores = out.cpuCores.length;
    const c0 = stat.total && stat.total.ctxt;
    const c1 = before.stat && before.stat.total && before.stat.total.ctxt;
    if (typeof c0 === 'number' && typeof c1 === 'number') {
      out.ctxtRate = ratePerSec(c1, c0, seconds);
    }
  }
  // Rates are reported for the primary interface only (first non-loopback),
  // so one busy lo/eth0 pair cannot double-count the machine.
  for (const name of Object.keys(net)) {
    if (name === 'lo') continue;
    const b = before.net && before.net[name];
    if (!b) continue;
    out.net[name] = {
      rxBps: ratePerSec(b.rxBytes, net[name].rxBytes, seconds),
      txBps: ratePerSec(b.txBytes, net[name].txBytes, seconds)
    };
    break; // highest-volume first is good enough; one interface is the KPI
  }
  return out;
}

function latest() { return prev ? prev.stat : null; }
function _reset() { prev = null; }

module.exports = {
  parseProcStat, busyPct, perCorePct, parseLoadavg, parseNetDev, ratePerSec,
  parseTcpStates, parseTcpStates6, parseVmstat, sample, latest, _reset
};
