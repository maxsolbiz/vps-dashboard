'use strict';

// Central configuration. Env-overridable for tests (PANEL_*).
// The panel binds to loopback only and must stay that way;
// remote access is via SSH tunnel, never a public bind.
const path = require('path');

const ROOT = path.join(__dirname, '..');

function num(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : def;
}

function list(name, def) {
  const v = (process.env[name] || '').trim();
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def.slice();
}

module.exports = {
  root: ROOT,
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 8787),
  // Public hostname served through the reverse proxy (empty = tunnel-only).
  publicHost: (process.env.PANEL_PUBLIC_HOST || '').trim().toLowerCase(),
  // Proxies trusted for X-Forwarded-For. Loopback only: rightmost untrusted
  // address becomes request.ip, so a client-supplied header can't spoof it.
  trustProxies: list('PANEL_TRUST_PROXY', ['127.0.0.1', '::1']),
  https: String(process.env.HTTPS || 'false') === 'true',
  // NOTE: there is intentionally no baked actionsEnabled flag. server.js
  // reads policy.json live (master switch) plus the ACTIONS_ENABLED env
  // kill-switch on every call.

  sessionCookie: 'panel_sess',
  sessionIdleS: num('PANEL_SESSION_IDLE_S', 1800), // 30 min idle
  sessionMaxS: num('PANEL_SESSION_MAX_S', 86400), // 24 h absolute

  loginMaxAttempts: num('PANEL_LOGIN_MAX_ATTEMPTS', 10),
  loginWindowS: num('PANEL_LOGIN_WINDOW_S', 60),
  loginLockoutS: num('PANEL_LOGIN_LOCKOUT_S', 900), // 15 min

  usersPath: process.env.PANEL_USERS || path.join(ROOT, 'data', 'users.json'),
  auditPath: process.env.PANEL_AUDIT || path.join(ROOT, 'data', 'audit.jsonl'),
  auditMaxBytes: num('PANEL_AUDIT_MAX_BYTES', 5 * 1024 * 1024),
  policyPath: process.env.PANEL_POLICY || path.join(ROOT, 'data', 'policy.json'),
  policyDefaultPath: process.env.PANEL_POLICY_DEFAULT || path.join(ROOT, 'data', 'policy.default.json'),
  overridesPath: process.env.PANEL_OVERRIDES || path.join(ROOT, 'data', 'overrides.json'),
  overridesDefaultPath: process.env.PANEL_OVERRIDES_DEFAULT || path.join(ROOT, 'data', 'overrides.default.json'),
  lastScanPath: process.env.PANEL_LAST_SCAN || path.join(ROOT, 'data', 'last-scan.json'),

  // Discovery sources (overridable for fixtures)
  binPm2: (process.env.PANEL_BIN_PM2 || 'pm2').split(/\s+/),
  binPs: (process.env.PANEL_BIN_PS || 'ps').split(/\s+/),
  binSs: (process.env.PANEL_BIN_SS || 'ss').split(/\s+/),
  binSystemctl: (process.env.PANEL_BIN_SYSTEMCTL || 'systemctl').split(/\s+/),
  apacheDir: process.env.PANEL_APACHE_DIR || '/etc/apache2/sites-enabled',
  meminfoPath: process.env.PANEL_MEMINFO || '/proc/meminfo',
  pm2DumpPath: process.env.PANEL_PM2_DUMP || '/root/.pm2/dump.pm2',
  scanRoots: list('PANEL_SCAN_ROOTS', ['/root', '/var/www', '/opt', '/srv']),
  procCwdMapPath: process.env.PANEL_PROC_CWD || '', // JSON {pid: cwd}, tests only

  pm2CacheMs: num('PANEL_PM2_TTL_MS', 5000), // jlist cache; each call spawns node
  samplerMs: num('PANEL_SAMPLER_MS', 5000), // background CPU sampler interval
  samplerOn: String(process.env.PANEL_SAMPLER || '1') !== '0', // tests set 0, drive ticks manually
  scanMinGapMs: num('PANEL_SCAN_GAP_MS', 5000),
  scanBudgetMs: num('PANEL_SCAN_BUDGET_MS', 20000),
  actionTimeoutMs: num('PANEL_ACTION_TIMEOUT_MS', 20000),
  maxLogBytes: num('PANEL_MAX_LOG_BYTES', 256 * 1024),
  logAllowPrefixes: list('PANEL_LOG_PREFIXES', ['/root/.pm2/logs', '/var/www']),
  panelName: process.env.PANEL_PM_NAME || 'vps-control-panel'
};
