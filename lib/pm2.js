'use strict';

// PM2 access. Allowed verbs ONLY: jlist, start, stop, restart.
// Never save/delete/kill/startup/update/flush/reload or --update-env:
// a stopped app saved to the dump would stay down after a reboot.
// jlist output is parsed from the first '[' (PM2 may print warnings first).
// Process environments are NEVER collected or served (they hold secrets).
const config = require('./config');
const { runBin } = require('./run');
const { redactText } = require('./redact');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTION_VERBS = new Set(['start', 'stop', 'restart']);

function parseJlist(stdout) {
  const i = String(stdout).indexOf('[');
  if (i === -1) throw new Error('pm2 jlist returned no JSON array');
  const arr = JSON.parse(String(stdout).slice(i));
  if (!Array.isArray(arr)) throw new Error('pm2 jlist returned no JSON array');
  return arr.map((p) => {
    const e = p.pm2_env || {};
    return {
      name: p.name,
      pm_id: typeof p.pm_id !== 'undefined' ? p.pm_id : null,
      status: e.status || 'unknown',
      pid: p.pid || 0,
      cpu_pct: typeof e.cpu === 'number' ? e.cpu : (p.monit && p.monit.cpu) || 0,
      memory_b: (p.monit && p.monit.memory) || 0,
      uptime_ms: e.pm_uptime ? Date.now() - e.pm_uptime : 0,
      restarts: e.restart_time || 0,
      unstable_restarts: e.unstable_restarts || 0,
      exec_path: e.pm_exec_path || null,
      cwd: e.pm_cwd || null,
      exec_mode: e.exec_mode || null,
      out_log: e.pm_out_log_path || null,
      err_log: e.pm_err_log_path || null
    };
  });
}

// 5 s single-flight cache: every jlist spawns a Node process, never call per request.
let cache = { at: 0, data: null, pending: null };
function clearCache() { cache = { at: 0, data: null, pending: null }; }

async function jlist() {
  const now = Date.now();
  if (cache.data && now - cache.at < config.pm2CacheMs) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = runBin(config.binPm2, ['jlist'], 15000)
    .then((out) => {
      const data = parseJlist(out);
      cache = { at: Date.now(), data, pending: null };
      return data;
    })
    .catch((err) => {
      cache.pending = null;
      throw err;
    });
  return cache.pending;
}

// verb ∈ start|stop|restart; name must be a live pm2 name from the last jlist.
async function action(verb, name) {
  if (!ACTION_VERBS.has(verb)) throw new Error(`action not allowed: ${verb}`);
  if (!NAME_RE.test(name)) throw new Error(`bad process name: ${name}`);
  const live = await jlist().catch(() => []);
  if (!live.some((p) => p.name === name)) throw new Error(`unknown pm2 process: ${name}`);
  const out = await runBin(config.binPm2, [verb, name], config.actionTimeoutMs);
  clearCache();
  return redactText(out.slice(0, 2000));
}

module.exports = { jlist, action, parseJlist, clearCache, NAME_RE, ACTION_VERBS };
