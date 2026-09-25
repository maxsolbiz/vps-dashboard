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
let prevSystem = null; // {at, cur: parsed /proc/stat aggregate}

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

function _reset() { prev = null; prevSystem = null; }

// ---------- whole-system CPU (/proc/stat) ----------
// The per-pid math above cannot answer "how busy is this box", because it only
// sees processes the panel enumerates. /proc/stat's aggregate `cpu` line covers
// every process including kernel threads and anything not under PM2.
function procStatPath() {
  return path.join(procRoot(), 'stat');
}

// "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
// idle is field 4 (index 3); iowait is commonly folded into idle.
function parseSystemStat(text) {
  const line = String(text).split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/);
  if (f.length < 5) return null;
  const n = (i) => { const v = parseInt(f[i], 10); return Number.isFinite(v) ? v : 0; };
  const user = n(1); const nice = n(2); const system = n(3);
  const idle = n(4); const iowait = n(5);
  const total = f.slice(1).reduce((a, v) => a + (parseInt(v, 10) || 0), 0);
  return { user, nice, system, idle, iowait, total };
}

// Percent busy since the previous sample. Returns null on the first call (no
// baseline), on unreadable /proc/stat, or when the window is too short to be
// meaningful — never a fabricated number.
function systemCpuPct(nowMs) {
  let cur;
  try {
    cur = parseSystemStat(fs.readFileSync(procStatPath(), 'utf8'));
  } catch (_) {
    return null;
  }
  if (!cur) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const before = prevSystem;
  prevSystem = { at: now, cur };
  if (!before) return null;
  const dTotal = cur.total - before.cur.total;
  const dIdle = (cur.idle - before.cur.idle) + (cur.iowait - before.cur.iowait);
  if (!(dTotal > 0)) return null;
  const busy = ((dTotal - dIdle) / dTotal) * 100;
  if (!Number.isFinite(busy)) return null;
  return Math.max(0, Math.min(100, Math.round(busy * 10) / 10));
}

module.exports = { parseStat, readStat, sample, sumTree, _reset, clkTck, parseSystemStat, systemCpuPct };
