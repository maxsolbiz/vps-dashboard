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

module.exports = { parseSs, snapshot };
