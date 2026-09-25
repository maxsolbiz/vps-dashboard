'use strict';

// Listening ports from `ss -tlnpH`. Maps port -> bind -> pids, and flags
// binds on 0.0.0.0/* (or non-loopback) as public.
const config = require('./config');
const { runBin } = require('./run');

function parseSs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('State') || l.startsWith('Netid')) continue;
    // LISTEN 0 511 0.0.0.0:3002 0.0.0.0:* users:(("next-server",pid=103,fd=19))
    const parts = l.split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[3] || '';
    const m = local.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const bind = m[1].replace(/^\[|\]$/g, '');
    const port = parseInt(m[2], 10);
    const pids = [];
    const users = l.slice(l.indexOf('users:'));
    const re = /pid=(\d+)/g;
    let pm;
    while ((pm = re.exec(users)) !== null) pids.push(parseInt(pm[1], 10));
    const publicBind = bind === '0.0.0.0' || bind === '*' || bind === '::'
      || (bind !== '127.0.0.1' && bind !== '::1' && !bind.startsWith('127.'));
    rows.push({ port, bind, public: publicBind, pids });
  }
  return rows;
}

async function snapshot() {
  const out = await runBin(config.binSs, ['-tlnpH'], 15000).catch(() =>
    runBin(config.binSs, ['-tlnp'], 15000)
  );
  return parseSs(out);
}

// Which PIDs currently hold this port? Empty array = free. Read-only.
async function holders(port) {
  const rows = await snapshot();
  return rows.filter((r) => r.port === port).flatMap((r) => r.pids);
}

// Poll until nothing holds this port, or the deadline passes. Never kills.
async function waitFree(port, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  for (;;) {
    let held = [];
    try { held = await holders(port); } catch (_) { held = []; }
    if (!held.length) return { port_released: true, waited_ms: Date.now() - started, port };
    if (Date.now() - started >= timeoutMs) {
      return { port_released: false, waited_ms: Date.now() - started, port, holder_pid: held[0] };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Poll until something holds this port, or the deadline passes. Read-only.
// Needed because pm2 reports "online" the moment the process spawns, which can
// be BEFORE the app has actually bound its listener. A single instant check
// races that gap and reports a successful restart as failed.
async function waitBound(port, timeoutMs, intervalMs = 250) {
  const started = Date.now();
  for (;;) {
    let held = [];
    try { held = await holders(port); } catch (_) { held = []; }
    if (held.length) return { port_bound: true, waited_ms: Date.now() - started, port, holder_pid: held[0] };
    if (Date.now() - started >= timeoutMs) {
      return { port_bound: false, waited_ms: Date.now() - started, port };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { parseSs, snapshot, holders, waitFree, waitBound };
