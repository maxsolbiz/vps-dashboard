'use strict';

// Process tree from `ps -eo pid=,ppid=,rss=,pcpu=,etimes=,args=`.
// PM2 only reports the top PID (e.g. `npm start`), so an app like hbl-pwa
// shows ~16-28 MB while the real next-server child uses ~117 MB.
// We attribute the WHOLE descendant tree to each PM2 app and sum RSS/CPU.
const config = require('./config');
const { runBin } = require('./run');

function parsePs(text) {
  const procs = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*(.*)$/);
    if (!m) continue;
    procs.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      rss_b: parseInt(m[3], 10) * 1024,
      cpu_pct: parseFloat(m[4]) || 0,
      etimes: parseInt(m[5], 10) || 0,
      args: (m[6] || '').trim()
    });
  }
  return procs;
}

function childrenMap(procs) {
  const map = new Map();
  for (const p of procs) {
    if (!map.has(p.ppid)) map.set(p.ppid, []);
    map.get(p.ppid).push(p.pid);
  }
  return map;
}

// Whole descendant tree of rootPid (inclusive). Returns {pids, rss_b, cpu_pct}.
function treeStats(procs, rootPid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = childrenMap(procs);
  const seen = new Set();
  const stack = [rootPid];
  let rss = 0;
  let cpu = 0;
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byPid.get(pid);
    if (!p && pid !== rootPid) continue;
    if (p) { rss += p.rss_b; cpu += p.cpu_pct; }
    for (const c of kids.get(pid) || []) stack.push(c);
  }
  return { pids: [...seen].sort((a, b) => a - b), rss_b: rss, cpu_pct: Math.round(cpu * 10) / 10 };
}

async function snapshot() {
  const out = await runBin(config.binPs, ['-eo', 'pid=,ppid=,rss=,pcpu=,etimes=,args='], 15000);
  return parsePs(out);
}

function isPm2God(args) {
  return /PM2 v\d|God Daemon/.test(args || '');
}

function looksNode(args) {
  return /(^|\/)(node|npm|next-server|tsx|ts-node|bun|deno)(\s|$)/.test(args || '')
    || /next-server|next[\\/]dist/.test(args || '');
}

module.exports = { parsePs, treeStats, snapshot, isPm2God, looksNode };
