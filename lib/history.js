'use strict';

// Server-side metric history.
//
// The browser used to keep trends in its own memory, so every page reload threw
// the graph away — useless for a monitoring dashboard you glance at all day.
// This keeps a bounded in-memory ring buffer in the panel process instead.
//
// Deliberately NOT persisted to disk: no file growth, no rotation, no I/O on
// the sampling path, and nothing to clean up. Trade-off: history resets when
// the panel restarts (which only happens on deploy), and the buffer is
// intentionally small.

const MAX_SAMPLES = 720; // 720 x 5 s = 1 hour of history

let buf = [];
let last = null;

function push(sample) {
  if (!sample || !sample.at) return;
  const row = compact(sample);
  buf.push(row);
  if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
  last = row;
}

// Keep only what the dashboard actually plots, so 720 rows stay tiny.
function compact(s) {
  const row = {
    t: s.at,
    cpu: s.cpu == null ? null : s.cpu,
    mem: s.mem == null ? null : s.mem,
    swap: s.swap == null ? null : s.swap,
    disk: s.disk == null ? null : s.disk,
    load: s.load == null ? null : s.load,
    cores: s.cores || null,
    rxBps: s.rxBps == null ? null : s.rxBps,
    txBps: s.txBps == null ? null : s.txBps,
    conns: s.conns == null ? null : s.conns,
    connEst: s.connEst == null ? null : s.connEst,
    connTw: s.connTw == null ? null : s.connTw,
    connListen: s.connListen == null ? null : s.connListen,
    procs: s.procs == null ? null : s.procs,
    running: s.running == null ? null : s.running,
    procsCreated: s.procsCreated == null ? null : s.procsCreated,
    ctxtRate: s.ctxtRate == null ? null : s.ctxtRate,
    majFault: s.majFault == null ? null : s.majFault,
    oomKill: s.oomKill == null ? null : s.oomKill
  };
  // Per-app series are kept as flat name->value maps: cheap to render, and
  // capped by the number of managed apps rather than growing unbounded.
  if (s.apps && typeof s.apps === 'object') {
    row.apps = {};
    for (const [name, v] of Object.entries(s.apps)) row.apps[name] = v;
  }
  return row;
}

// rangeMs: how far back to return. Defaults to the whole buffer.
function get(rangeMs) {
  if (!(rangeMs > 0)) return buf.slice();
  const cutoff = Date.now() - rangeMs;
  return buf.filter((r) => Date.parse(r.t) >= cutoff);
}

function latest() { return last; }
function size() { return buf.length; }
function stats(key) {
  let min = Infinity; let max = -Infinity; let cur = null; let n = 0; let sum = 0;
  for (const r of buf) {
    const v = r[key];
    if (typeof v === 'number' && !isNaN(v)) { n++; sum += v; if (v < min) min = v; if (v > max) max = v; cur = v; }
  }
  // A real mean over the buffered samples, not a stand-in derived from min/max.
  return n ? { min, max, cur, n, avg: Math.round((sum / n) * 100) / 100 } : null;
}
function clear() { buf = []; last = null; }
function cap() { return MAX_SAMPLES; }

module.exports = { push, get, latest, size, stats, clear, cap, MAX_SAMPLES };
