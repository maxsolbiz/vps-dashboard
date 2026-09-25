'use strict';

// SCAN: full VPS discovery, read-only. Single-flight, min 5 s between scans,
// 20 s total budget, result saved to data/last-scan.json (mode 0600).
// Sources: pm2 jlist (+stopped), ps tree, /proc stat CPU deltas, ss ports,
// Apache vhosts, systemctl is-active (fixed list), fs walk of allowlisted
// roots, unmanaged node processes, PM2 dump drift (names only).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const pm2 = require('./pm2');
const proc = require('./proc');
const cpustat = require('./cpustat');
const cpusampler = require('./cpusampler');
const ports = require('./ports');
const apache = require('./apache');
const walk = require('./walk');
const policy = require('./policy');
const statuslib = require('./status');
const { ensureDir } = require('./fsutil');
const { runBin } = require('./run');

const INFRA_UNITS = ['apache2', 'postgresql', 'mariadb', 'redis-server'];

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve({ __timeout: label }), ms);
  });
  return Promise.race([promise.then((v) => ({ __value: v })), timeout]).then((r) => {
    clearTimeout(t);
    return r;
  });
}

// A wrapper/interpreter launch means PM2's pid is NOT the process holding the
// port (npm -> sh -> next-server), so stop/start can race the real listener.
const WRAPPERS = new Set(['npm', 'yarn', 'pnpm', 'npx', 'pnpx', 'sh', 'bash', 'dash', 'zsh']);
function isIndirect(execPath) {
  if (!execPath) return false;
  const base = path.basename(String(execPath)).toLowerCase();
  if (WRAPPERS.has(base)) return true;
  // A shell script runs under a shell: start-frontend.sh -> sh -> next-server.
  if (/\.(sh|bash)$/.test(base)) return true;
  // A node entrypoint is direct: node is the process holding the port.
  return false;
}

// Last known listening ports per app. A stopped app has no process tree, so
// its port cannot be attributed from ps alone; we remember what it held while
// running so "is something still holding it?" stays answerable.
const knownPorts = new Map();

function rememberPorts(name, rows) {
  if (rows && rows.length) knownPorts.set(name, rows.map((p) => p.port));
}
function recallPorts(name) {
  return knownPorts.get(name) || [];
}

function normId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function stableId(prefix, key) {
  const h = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8);
  return `${prefix}-${h}`;
}

function readDumpNames() {
  // Names ONLY. Everything else in the dump is discarded and never logged.
  try {
    const arr = JSON.parse(fs.readFileSync(config.pm2DumpPath, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => x && x.name).filter((n) => typeof n === 'string');
  } catch (_) {
    return [];
  }
}

function readProcCwd(pid) {
  if (config.procCwdMapPath) {
    try {
      const map = JSON.parse(fs.readFileSync(config.procCwdMapPath, 'utf8'));
      if (map[String(pid)]) return map[String(pid)];
    } catch (_) {}
  }
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch (_) {
    return null;
  }
}

function under(a, b) {
  if (!a || !b) return false;
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return na === nb || na.startsWith(nb + path.sep);
}

// A `pm2 <verb>` CLI invocation (jlist spawned by the panel itself, etc.).
// These must never show up as unmanaged processes.
function isPm2Cli(args) {
  return /(^|[\/\\])pm2(\.js|\.cmd)?\s+(jlist|list|start|stop|restart|describe|logs|monit|show|save|delete|kill|reload|startup|update|flush)/.test(args || '');
}

// Match a PM2 app to project dirs. The old `under(pr.dir, it.cwd)` clause
// hid every project when cwd was a scan root (event-invoice-frontend runs
// with cwd /root), so it is dropped whenever cwd IS a scan root or holds
// more than one project. exec_path matching covers that case instead.
function matchProjects(app, projects, roots) {
  const cwd = app.cwd ? path.normalize(app.cwd) : null;
  const exec = app.exec_path ? path.normalize(app.exec_path) : null;
  const normRoots = roots.map((r) => path.normalize(r));
  const beneath = cwd ? projects.filter((pr) => under(pr.dir, cwd) && path.normalize(pr.dir) !== cwd) : [];
  const allowReverse = cwd && !normRoots.includes(cwd) && beneath.length <= 1;
  const matched = new Set();
  for (const pr of projects) {
    const dir = path.normalize(pr.dir);
    const group = path.normalize(pr.group);
    if (cwd && (cwd === dir || cwd === group)) matched.add(pr.group);
    if (cwd && under(cwd, dir)) matched.add(pr.group); // app runs inside the project
    if (exec && (under(exec, dir) || under(exec, group))) matched.add(pr.group);
    if (allowReverse && under(dir, cwd)) matched.add(pr.group);
  }
  return matched;
}

async function runScan() {
  const started = Date.now();
  const budget = config.scanBudgetMs;
  const elapsed = () => Date.now() - started;
  const left = () => Math.max(1000, budget - elapsed());
  const warnings = [];

  let apps = [];
  try {
    apps = await pm2.jlist();
  } catch (err) {
    warnings.push(`pm2 jlist failed: ${String(err.message).slice(0, 120)}`);
  }

  // Fresh ps snapshot on every scan. The sampler is shared and can be up to
  // one interval stale: after a restart the killed pids would otherwise show
  // up as "unmanaged running" and the new tree would report too little RAM.
  // The sampler supplies CPU % by pid only.
  let procs = [];
  try {
    const r = await withTimeout(proc.snapshot(), left(), 'ps');
    if (r.__timeout) warnings.push('ps timed out');
    else procs = r.__value;
  } catch (err) {
    warnings.push(`ps failed: ${String(err.message).slice(0, 120)}`);
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const snap = cpusampler.latest();

  let portRows = [];
  try {
    const r = await withTimeout(ports.snapshot(), left(), 'ss');
    if (r.__timeout) warnings.push('ss timed out');
    else portRows = r.__value;
  } catch (err) {
    warnings.push(`ss failed: ${String(err.message).slice(0, 120)}`);
  }

  const vhosts = apache.snapshot();
  const portToDomains = new Map();
  const docrootSites = [];
  for (const v of vhosts) {
    const hasProxy = v.proxies && v.proxies.length > 0;
    if (hasProxy) {
      for (const px of v.proxies) {
        if (!portToDomains.has(px.port)) portToDomains.set(px.port, new Set());
        for (const n of v.names) portToDomains.get(px.port).add(n);
      }
    } else if (v.docroot) {
      docrootSites.push(v);
    }
  }
  const websiteRoots = new Set(docrootSites.map((v) => path.normalize(v.docroot)));
  const scanRoots = config.scanRoots;

  const infraState = {};
  try {
    const r = await withTimeout(
      runBin(config.binSystemctl, ['is-active', ...INFRA_UNITS], 10000).catch(() => ''),
      left(), 'systemctl'
    );
    const lines = (r.__value || '').split('\n').map((s) => s.trim());
    INFRA_UNITS.forEach((u, i) => { infraState[u] = lines[i] || 'unknown'; });
  } catch (_) {
    INFRA_UNITS.forEach((u) => { infraState[u] = 'unknown'; });
  }

  let projects = [];
  try {
    const wsnap = walk.snapshot();
    projects = wsnap.projects;
    if (wsnap.truncated) {
      warnings.push('project walk truncated by entry budget — some directories were skipped');
    }
  } catch (err) {
    warnings.push(`walk failed: ${String(err.message).slice(0, 120)}`);
  }

  const dumpNames = new Set(readDumpNames());

  const pol = policy.loadPolicy();
  const overrides = policy.loadOverrides();
  const panelRoot = path.normalize(config.root);

  // Operator noise filter: projects under ignore_paths never surface.
  const ignored = (p) => (pol.ignore_paths || []).some((pre) => {
    const n = path.normalize(String(pre));
    const g = path.normalize(p.group);
    const d = path.normalize(p.dir);
    return g === n || g.startsWith(n + path.sep) || d === n || d.startsWith(n + path.sep);
  });
  projects = projects.filter((p) => !ignored(p));

  // A docroot that IS a scan root (e.g. /var/www) or holds more than one
  // project must never hide projects — same class of bug as a cwd of /root.
  const normRoots = new Set(scanRoots.map((r) => path.normalize(r)));
  const usableRoots = [...websiteRoots].filter((w) => {
    if (normRoots.has(w)) return false;
    const inside = projects.filter((pr) => under(path.normalize(pr.dir), w) || under(path.normalize(pr.group), w));
    return inside.length <= 1;
  });

  // Attribute trees to PM2 apps. CPU comes from the shared sampler snapshot.
  const trees = new Map();
  for (const a of apps) {
    const tree = a.pid && byPid.has(a.pid)
      ? proc.treeStats(procs, a.pid)
      : { pids: a.pid ? [a.pid] : [], rss_b: a.memory_b || 0 };
    trees.set(a.name, tree);
  }
  const cpuOf = (tree, fallback) => (snap.fresh ? cpustat.sumTree(snap.pct, tree.pids) : fallback);

  // Live PM2 pids: a port held by anything else is an orphan holding the app.
  const livePids = new Set();
  for (const a of apps) if (a.pid) livePids.add(a.pid);

  const pm2Pids = new Set();
  for (const tree of trees.values()) {
    for (const pid of tree.pids) pm2Pids.add(pid);
  }
  const items = [];
  for (const a of apps) {
    const isPanel = a.name === pol.panel_name
      || (a.cwd && path.normalize(a.cwd) === panelRoot);
    const tree = trees.get(a.name);
    const status = statuslib.mapStatus(a.status);
    const live = statuslib.isLive(status);
    const cpu = cpuOf(tree, typeof a.cpu_pct === 'number' ? a.cpu_pct : 0); // cold sampler: pm2 monit fallback
    const myPorts = portRows
      .filter((r) => r.pids.some((p) => tree.pids.includes(p)))
      .map((r) => ({ port: r.port, bind: r.bind, public: r.public }));
    if (live && myPorts.length) rememberPorts(a.name, myPorts);
    // Ports this app is expected to own: its own tree now, else what it held
    // the last time it was running.
    const expectedPorts = myPorts.length
      ? myPorts
      : recallPorts(a.name).map((port) => {
        const row = portRows.find((r) => r.port === port);
        return row ? { port, bind: row.bind, public: row.public } : { port, bind: 'unknown', public: false };
      });
    const domains = new Set();
    for (const p of myPorts) {
      for (const d of portToDomains.get(p.port) || []) domains.add(d);
    }
    const indirect = isIndirect(a.exec_path);
    // A stopped app whose expected port is still held by a pid PM2 doesn't own
    // cannot be started safely: the next start would race and fail.
    const orphanPort = !live
      ? expectedPorts.find((p) => portRows.some((r) => r.port === p.port && r.pids.some((pid) => !livePids.has(pid))))
      : null;
    const startBlocked = !!indirect && !!orphanPort;
    items.push(policy.applyOverrides({
      id: a.name,
      name: a.name,
      kind: isPanel ? 'panel' : 'pm2',
      status,
      pids: tree.pids,
      cpu_pct: live ? cpu : 0,
      rss_b: live ? tree.rss_b : 0,
      uptime_s: live && a.pid && byPid.get(a.pid) ? byPid.get(a.pid).etimes : 0,
      restarts: a.restarts,
      unstable_restarts: a.unstable_restarts,
      ports: expectedPorts,
      domains: [...domains],
      cwd: a.cwd,
      exec_path: a.exec_path,
      indirect,
      start_blocked: startBlocked,
      holder_pid: startBlocked ? portRows.find((r) => r.port === orphanPort.port).pids.find((pid) => !livePids.has(pid)) : null,
      category: 'unclassified',
      notes: '',
      in_dump: dumpNames.has(a.name),
      actions: isPanel ? [] : policy.actionsFor(pol, a.name),
      logs_enabled: policy.logsEnabled(pol, a.name)
    }, overrides));
  }

  const apacheActive = (infraState.apache2 || '') === 'active';
  // Dedupe by (name, docroot): plain + -le-ssl confs for one site merge into
  // a single row with ports 80+443. Redirect-only vhosts (no proxy, no
  // docroot) never reach docrootSites, so they create no rows.
  const siteGroups = new Map();
  for (const v of docrootSites) {
    const key = `${v.names[0] || ''}\0${v.docroot}`;
    if (!siteGroups.has(key)) siteGroups.set(key, { names: new Set(), ports: new Set(), files: [], docroot: v.docroot });
    const g = siteGroups.get(key);
    for (const n of v.names) g.names.add(n);
    g.ports.add(v.port || 80);
    g.files.push(v.file);
  }
  for (const g of siteGroups.values()) {
    const name = [...g.names][0] || path.basename(g.docroot || 'site');
    items.push(policy.applyOverrides({
      id: `site-${normId(name)}`,
      name,
      kind: 'website',
      status: apacheActive ? 'running' : 'stopped',
      pids: [],
      cpu_pct: 0,
      rss_b: 0,
      uptime_s: 0,
      restarts: 0,
      unstable_restarts: 0,
      ports: [...g.ports].sort((a, b) => a - b).map((port) => ({ port, bind: '*', public: true })),
      domains: [...g.names],
      cwd: g.docroot,
      category: 'unclassified',
      notes: `DocumentRoot ${g.docroot || ''} (${g.files.join(', ')})`,
      in_dump: false,
      actions: [],
      logs_enabled: false
    }, overrides));
  }

  for (const u of INFRA_UNITS) {
    const st = infraState[u] || 'unknown';
    items.push({
      id: `infra-${u}`,
      name: u,
      kind: 'infra',
      status: st === 'active' ? 'running' : 'stopped',
      pids: [],
      cpu_pct: 0,
      rss_b: 0,
      uptime_s: 0,
      restarts: 0,
      unstable_restarts: 0,
      ports: [],
      domains: [],
      cwd: null,
      category: 'unclassified',
      notes: `systemctl is-active: ${st}`,
      in_dump: false,
      actions: [],
      logs_enabled: false
    });
  }

  // Unmanaged running node processes: outside every PM2 tree, not the PM2
  // God daemon, not a pm2 CLI invocation. The panel excludes itself from
  // actions but its tree still claims its descendants here.
  const pm2Names = new Set(apps.map((a) => a.name));
  for (const p of procs) {
    if (pm2Pids.has(p.pid)) continue;
    if (proc.isPm2God(p.args)) continue;
    if (isPm2Cli(p.args)) continue;
    if (!proc.looksNode(p.args)) continue;
    const cwd = readProcCwd(p.pid);
    const tree = proc.treeStats(procs, p.pid);
    for (const pid of tree.pids) pm2Pids.add(pid);
    const cpu = cpuOf(tree, 0);
    items.push({
      id: stableId('unmanaged', `${cwd || ''}\n${p.args.slice(0, 120)}`),
      name: `${p.args.slice(0, 60)} (pid ${p.pid})`,
      kind: 'unmanaged',
      status: 'unmanaged-running',
      pids: tree.pids,
      cpu_pct: cpu,
      rss_b: tree.rss_b,
      uptime_s: p.etimes,
      restarts: 0,
      unstable_restarts: 0,
      ports: portRows.filter((r) => r.pids.some((x) => tree.pids.includes(x)))
        .map((r) => ({ port: r.port, bind: r.bind, public: r.public })),
      domains: [],
      cwd,
      category: 'unclassified',
      notes: 'Running outside PM2. Display-only, never killable from the panel.',
      in_dump: false,
      actions: [],
      logs_enabled: false
    });
  }

  // Unmatched projects -> unmanaged (stopped, display-only), except dirs
  // already shown as website rows (same docroot).
  const matchedGroups = new Set();
  for (const it of items) {
    if (it.kind !== 'pm2' && it.kind !== 'panel') continue;
    for (const g of matchProjects({ cwd: it.cwd, exec_path: it.exec_path }, projects, scanRoots)) {
      matchedGroups.add(g);
    }
  }
  const driftMissing = [...dumpNames].filter((n) => !pm2Names.has(n));
  const seenGroups = new Set();
  for (const pr of projects) {
    if (matchedGroups.has(pr.group) || seenGroups.has(pr.group)) continue;
    seenGroups.add(pr.group);
    // Skip dirs already shown as website rows: docroot equal to, inside, or
    // containing the project (e.g. a vhost rooted at <project>/public).
    const g = path.normalize(pr.group);
    const d = path.normalize(pr.dir);
    const inSite = usableRoots.some((w) => under(g, w) || under(w, g) || under(d, w) || under(w, d));
    if (inSite) continue;
    items.push(policy.applyOverrides({
      id: `proj-${normId(pr.group)}`,
      name: `${pr.name} (${pr.group})`,
      kind: 'unmanaged',
      status: 'unmanaged-stopped',
      pids: [],
      cpu_pct: 0,
      rss_b: 0,
      uptime_s: 0,
      restarts: 0,
      unstable_restarts: 0,
      ports: [],
      domains: [],
      cwd: pr.group,
      category: 'unclassified',
      notes: `Project dir not managed by PM2 (${pr.kind}). Display-only.`,
      in_dump: false,
      actions: [],
      logs_enabled: false
    }, overrides));
  }

  const result = {
    scanned_at: new Date().toISOString(),
    complete: warnings.length === 0,
    warnings,
    counts: {
      running: items.filter((i) => i.status === 'running').length,
      stopped: items.filter((i) => i.status === 'stopped' || i.status === 'unmanaged-stopped').length,
      errored: items.filter((i) => i.status === 'errored' || i.status === 'restarting').length,
      unmanaged: items.filter((i) => i.kind === 'unmanaged').length,
      public_binds: items.filter((i) => (i.ports || []).some((p) => p.public)).length
    },
    drift: {
      in_dump_not_running: driftMissing,
      running_not_in_dump: apps.filter((a) => a.status === 'online' && !dumpNames.has(a.name)).map((a) => a.name)
    },
    items
  };
  return result;
}

function saveScan(result) {
  ensureDir(path.dirname(config.lastScanPath));
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(config.lastScanPath, 'utf8')); } catch (_) {}
  fs.writeFileSync(config.lastScanPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  try { fs.chmodSync(config.lastScanPath, 0o600); } catch (_) {}
  let diff = { new: [], gone: [] };
  if (prev && Array.isArray(prev.items)) {
    const before = new Set(prev.items.map((i) => i.id));
    const after = new Set(result.items.map((i) => i.id));
    diff = {
      new: [...after].filter((id) => !before.has(id)),
      gone: [...before].filter((id) => !after.has(id))
    };
  }
  return diff;
}

function loadLastScan() {
  try {
    return JSON.parse(fs.readFileSync(config.lastScanPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

let scanState = { at: 0, pending: null, last: null };
function clearScanState() { scanState = { at: 0, pending: null, last: null }; }

async function scan() {
  const now = Date.now();
  if (scanState.pending) return { ...(await scanState.pending), cached: true };
  if (now - scanState.at < config.scanMinGapMs && scanState.last) {
    return { ...scanState.last, cached: true };
  }
  // try/finally: a failed scan must never wedge later scans on a stale promise.
  scanState.pending = (async () => {
    try {
      const result = await runScan();
      const diff = module.exports.saveScan(result);
      const out = { ...result, diff };
      scanState.at = Date.now();
      scanState.last = out;
      return out;
    } finally {
      scanState.pending = null;
    }
  })();
  return scanState.pending;
}

module.exports = { runScan, scan, saveScan, loadLastScan, clearScanState, matchProjects, isPm2Cli, stableId, INFRA_UNITS };
