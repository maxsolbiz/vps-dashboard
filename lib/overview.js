'use strict';

// GET /api/overview: PM2 + process tree + system, cached 5 s single-flight.
// CPU comes from /proc stat deltas (lib/cpustat), falling back to pm2 monit
// on the first call. Memory comes from meminfo, never os.freemem().
const os = require('os');
const config = require('./config');
const pm2 = require('./pm2');
const proc = require('./proc');
const cpustat = require('./cpustat');
const cpusampler = require('./cpusampler');
const ports = require('./ports');
const meminfo = require('./meminfo');
const statuslib = require('./status');
const policy = require('./policy');
const { runBin } = require('./run');

async function diskRoot() {
  if (process.platform !== 'linux') return null;
  try {
    const out = await runBin(['df', '-k', '/'], [], 8000);
    const p = out.trim().split('\n').pop().trim().split(/\s+/);
    if (p.length < 6) return null;
    return { total_kb: parseInt(p[1], 10) || null, used_kb: parseInt(p[2], 10) || null, avail_kb: parseInt(p[3], 10) || null, use_pct: p[4] || null };
  } catch (_) {
    return null;
  }
}

async function build() {
  const snap = cpusampler.latest(); // reads only; baseline never advances per request
  const apps = await pm2.jlist().catch(() => []);
  // Fresh ps when any live jlist pid is missing from the sampler snapshot
  // (stale up to one interval, e.g. right after a restart).
  const snapPids = snap.procs ? new Set(snap.procs.map((p) => p.pid)) : new Set();
  const needsFresh = !snap.procs || apps.some((a) => a.pid && !snapPids.has(a.pid));
  const [ownProcs, portRows, disk] = await Promise.all([
    needsFresh ? proc.snapshot().catch(() => snap.procs || []) : snap.procs,
    ports.snapshot().catch(() => []),
    diskRoot()
  ]);
  const procs = ownProcs;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const trees = new Map();
  for (const a of apps) {
    trees.set(a.name, a.pid && byPid.has(a.pid)
      ? proc.treeStats(procs, a.pid)
      : { pids: a.pid ? [a.pid] : [], rss_b: a.memory_b || 0 });
  }
  const cpuOf = (tree, fallback) => (snap.fresh ? cpustat.sumTree(snap.pct, tree.pids) : fallback);
  const merged = apps.map((a) => {
    const tree = trees.get(a.name);
    const status = statuslib.mapStatus(a.status);
    const cpu = cpuOf(tree, typeof a.cpu_pct === 'number' ? a.cpu_pct : 0);
    const myPorts = portRows
      .filter((r) => r.pids.some((p) => tree.pids.includes(p)))
      .map((r) => ({ port: r.port, bind: r.bind, public: r.public }));
    return {
      name: a.name,
      status,
      pid: a.pid,
      pids: tree.pids,
      cpu_pct: statuslib.isLive(status) ? cpu : 0,
      rss_b: statuslib.isLive(status) ? tree.rss_b : 0,
      uptime_s: a.pid && byPid.get(a.pid) ? byPid.get(a.pid).etimes : 0,
      restarts: a.restarts,
      unstable_restarts: a.unstable_restarts,
      ports: myPorts,
      in_tree: tree.pids.length
    };
  });
  return {
    at: new Date().toISOString(),
    pm2_available: true,
    // Reload the policy (cheap file read) so policy_error clears as soon as
    // the file is valid again; enforcement elsewhere always uses fail-closed.
    policy_error: (policy.loadPolicy(), policy.getPolicyError()),
    system: {
      uptime_s: Math.floor(os.uptime()),
      load: os.loadavg(),
      cpus: os.cpus().length,
      // Whole-box CPU from /proc/stat. null when there is no baseline yet or
      // the counter is unreadable — never a guess.
      cpu_pct: snap.system == null ? null : snap.system,
      mem: meminfo.readMemory(),
      disk
    },
    apps: merged
  };
}

let ov = { at: 0, pending: null, data: null };
function clearOverview() { ov = { at: 0, pending: null, data: null }; }
// The most recent build, WITHOUT triggering one. Used by the metrics recorder
// so its timer never spawns ps/ss/df/pm2.
function lastBuilt() { return ov.data; }

async function overview() {
  const now = Date.now();
  if (ov.data && now - ov.at < config.pm2CacheMs) return { ...ov.data, cached: true };
  if (ov.pending) return { ...(await ov.pending), cached: true };
  ov.pending = build().then((data) => {
    ov = { at: Date.now(), pending: null, data };
    return data;
  }).catch((err) => {
    ov.pending = null;
    return { at: new Date().toISOString(), pm2_available: false, error: String(err.message).slice(0, 200), system: null, apps: [] };
  });
  return ov.pending;
}

module.exports = { overview, clearOverview, lastBuilt };
