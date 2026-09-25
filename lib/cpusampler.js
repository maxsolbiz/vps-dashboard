'use strict';

// Shared background CPU sampler. ONE baseline, advanced on a fixed interval
// (default 5 s) — never per request. scan and overview only READ the latest
// values, so two calls tens of milliseconds apart can't turn a single 10 ms
// tick into 20–200% CPU. Started with the server, stopped on close.
const config = require('./config');
const proc = require('./proc');
const cpustat = require('./cpustat');

let timer = null;
let prev = null; // {at, ticks: Map}
let curr = null; // {at, procs, ticks: Map}
let ticking = null;
let lastValid = new Map(); // last pct from a window >= MIN_WINDOW_MS
let systemPct = null;       // whole-box CPU %, same cadence as the process map

const MIN_WINDOW_MS = 2000;

function readTicks(pids) {
  const ticks = new Map();
  for (const pid of pids) {
    const st = cpustat.readStat(pid);
    if (st) ticks.set(pid, st.total);
  }
  return ticks;
}

async function doTick(nowMs) {
  let procs = null;
  try {
    procs = await proc.snapshot();
  } catch (_) {
    return; // keep previous snapshot on failure
  }
  const ticks = readTicks(procs.map((p) => p.pid));
  const at = typeof nowMs === 'number' ? nowMs : Date.now();
  prev = curr;
  curr = { at, procs, ticks };
  // Commit a new valid pct only on windows >= 2 s. A tick landing tens of
  // milliseconds after the previous one (e.g. the post-action _tick racing
  // the scheduled tick) must not turn one 10 ms tick into 200% CPU.
  if (prev && curr.at - prev.at >= MIN_WINDOW_MS) {
    lastValid = diffPct(prev.ticks, curr.ticks, curr.at - prev.at);
    // Whole-box CPU uses the same window so the two numbers are comparable.
    systemPct = cpustat.systemCpuPct(curr.at);
  } else {
    cpustat.systemCpuPct(curr.at); // advance the /proc/stat baseline only
  }
}

async function _tick(nowMs) {
  if (ticking) return ticking;
  ticking = doTick(nowMs).finally(() => { ticking = null; });
  return ticking;
}

function start(intervalMs) {
  if (timer) return;
  const ms = intervalMs || config.samplerMs;
  _tick();
  timer = setInterval(() => { _tick(); }, ms);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  prev = null;
  curr = null;
  ticking = null;
  lastValid = new Map();
  systemPct = null;
}

function diffPct(before, after, dMs) {
  // Pure delta math (ticks at PANEL_CLK_TCK). Exported for tests.
  const out = new Map();
  const dsec = dMs / 1000;
  if (!(dsec > 0)) return out;
  const tck = cpustat.clkTck();
  for (const [pid, total] of after) {
    const b = before.get(pid);
    if (b === undefined) continue;
    const d = total - b;
    if (d < 0) continue; // pid reused
    out.set(pid, Math.round((d / tck / dsec) * 1000) / 10);
  }
  return out;
}

// Latest values WITHOUT advancing the baseline. Callers get:
// {procs: [...]+null when cold, pct: last valid Map, fresh: bool, system: whole-box CPU % or null}
function latest() {
  if (!curr) return { procs: null, pct: new Map(), fresh: false, system: null };
  return { procs: curr.procs, pct: lastValid, fresh: lastValid.size > 0, system: systemPct };
}

function _reset() { stop(); }

module.exports = { start, stop, latest, _tick, diffPct, _reset };
