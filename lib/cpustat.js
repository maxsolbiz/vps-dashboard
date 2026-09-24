'use strict';

// CPU from /proc/<pid>/stat deltas (utime+stime), NOT ps %cpu.
// ps %cpu is a lifetime average: a busy app reads 0.4%, and one that was
// busy at startup stays high forever. Deltas show current load instead.
// Previous snapshot is kept in memory; the first call has no baseline and
// reports fresh:false so callers fall back to pm2 monit cpu.
const fs = require('fs');
const path = require('path');
const config = require('./config');

function clkTck() {
  const v = parseInt(process.env.PANEL_CLK_TCK || '100', 10);
  return Number.isFinite(v) && v > 0 ? v : 100;
}

function procRoot() {
  return process.env.PANEL_PROC_ROOT || '/proc';
}

// `pid (comm with spaces) state ppid ... utime stime ...`
// utime/stime are fields 14/15 overall = indexes 11/12 after the comm.
function parseStat(text) {
  const s = String(text);
  const close = s.lastIndexOf(')');
  if (close === -1) throw new Error('bad stat: no comm');
  const rest = s.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 13) throw new Error('bad stat: too few fields');
  const utime = parseInt(rest[11], 10);
  const stime = parseInt(rest[12], 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) throw new Error('bad stat: bad ticks');
  return { utime, stime, total: utime + stime };
}

function readStat(pid) {
  try {
    return parseStat(fs.readFileSync(path.join(procRoot(), String(pid), 'stat'), 'utf8'));
  } catch (_) {
    return null;
  }
}

let prev = null; // {at, ticks: Map(pid -> total)}

// nowMs is injectable for tests; servers pass Date.now().
function sample(pids, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const ticks = new Map();
  for (const pid of pids) {
    const st = readStat(pid);
    if (st) ticks.set(pid, st.total);
  }
  const out = { pct: new Map(), fresh: prev !== null };
  if (prev) {
    const dticks = clkTck();
    const dsec = (now - prev.at) / 1000;
    if (dsec > 0) {
      for (const [pid, total] of ticks) {
        const before = prev.ticks.get(pid);
        if (before === undefined) continue;
        const d = total - before;
        if (d < 0) continue; // pid reused; skip
        out.pct.set(pid, Math.round((d / dticks / dsec) * 1000) / 10);
      }
    }
  }
  prev = { at: now, ticks };
  return out;
}

function sumTree(pctMap, pids) {
  let sum = 0;
  for (const pid of pids) sum += pctMap.get(pid) || 0;
  return Math.round(sum * 10) / 10;
}

function _reset() { prev = null; }

module.exports = { parseStat, readStat, sample, sumTree, _reset, clkTck };
