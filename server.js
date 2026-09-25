'use strict';

// VPS Control Panel — Fastify backend.
//   - Binds loopback only (refuses anything else). SSH tunnel for access.
//   - No generic shell: execFile with fixed argv; only pm2 jlist/start/stop/restart,
//     ps, ss, systemctl is-active, df. See docs/SCAN.md for the exact set.
//   - No /api/setup: the admin is created with node scripts/create-admin.js.
//   - Mutating actions are gated: ACTIONS_ENABLED + login + Origin + CSRF +
//     confirm (+ typed name for stop) + per-app + global locks, all audited.
const path = require('path');
const crypto = require('crypto');
// trustProxy limited to loopback: req.ip is the rightmost untrusted address
// from X-Forwarded-For (proxy-addr semantics), so client-supplied values
// further left are ignored. Rate limiting and audit logging use req.ip.
const fastify = require('fastify')({ logger: false, trustProxy: require('./lib/config').trustProxies });

const config = require('./lib/config');
const store = require('./lib/store');
const pm2 = require('./lib/pm2');
const policy = require('./lib/policy');
const scanlib = require('./lib/scan');
const overviewlib = require('./lib/overview');
const statuslib = require('./lib/status');
const cpusampler = require('./lib/cpusampler');
const ports = require('./lib/ports');
const { redactText } = require('./lib/redact');

// ---------- tiny cookie helpers (no dependency) ----------
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(value, expires, secure) {
  const parts = [`${config.sessionCookie}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  else parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return parts.join('; ');
}

// HTTPS when explicitly enabled or when the reverse proxy says so.
function isHttps(req) {
  return config.https || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

// ---------- host / origin / csrf ----------
function hostOk(req) {
  const host = String(req.headers.host || '');
  if (!host) return true; // HTTP/1.0 without Host; loopback bind still applies
  if (/^(127\.0\.0\.1|localhost|::1)(:\d+)?$/i.test(host)) return true;
  if (config.publicHost) {
    const bare = host.split(':')[0].toLowerCase();
    if (bare === config.publicHost) return true;
  }
  return false;
}

function originOk(req) {
  const o = String(req.headers.origin || '');
  if (/^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|https?:\/\/\[::1\](:\d+)?)$/i.test(o)) return true;
  // Public hostname only ever over https (Apache redirects plain http away).
  if (config.publicHost) {
    const m = o.match(/^https:\/\/([^/:]+)(:\d+)?$/i);
    if (m && m[1].toLowerCase() === config.publicHost) return true;
  }
  return false;
}

// CSRF tokens: issued with /api/me, valid 30 min, single-use-ish (kept briefly).
const csrfTokens = new Map();
function issueCsrf() {
  const t = crypto.randomBytes(24).toString('hex');
  csrfTokens.set(t, Date.now() + 30 * 60 * 1000);
  if (csrfTokens.size > 500) {
    const now = Date.now();
    for (const [k, exp] of csrfTokens) if (exp < now) csrfTokens.delete(k);
  }
  return t;
}
function checkCsrf(req) {
  const t = String(req.headers['x-panel-csrf'] || '');
  const exp = csrfTokens.get(t);
  if (!t || !exp || exp < Date.now()) return false;
  return true;
}

// ---------- login rate limit + lockout (in-memory, per IP) ----------
const attempts = new Map(); // ip -> {fails:[ts], lockedUntil}
function loginBlocked(ip) {
  const a = attempts.get(ip);
  return !!(a && a.lockedUntil && a.lockedUntil > Date.now());
}
function loginFail(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a) { a = { fails: [], lockedUntil: 0 }; attempts.set(ip, a); }
  a.fails = a.fails.filter((t) => now - t < config.loginWindowS * 1000);
  a.fails.push(now);
  if (a.fails.length >= config.loginMaxAttempts) {
    a.lockedUntil = now + config.loginLockoutS * 1000;
    return true;
  }
  return false;
}
function loginOk(ip) { attempts.delete(ip); }

// ---------- action locks: ONE action server-wide (no queueing) ----------
let globalAction = null;
const appLocks = new Map();
async function withActionLock(id, fn) {
  if (globalAction) {
    throw Object.assign(new Error(`another action is already running (${globalAction}); try again when it finishes`), { status: 409 });
  }
  globalAction = id;
  appLocks.set(id, true);
  try {
    return await fn();
  } finally {
    appLocks.delete(id);
    globalAction = null;
  }
}

// ---------- helpers ----------
function ipOf(req) { return String(req.ip || '').slice(0, 64); }

function actionsEnabled() {
  // Master switch: policy.json actions_enabled, read live (one edit, no
  // restart). ACTIONS_ENABLED env is only an emergency kill-switch: when it
  // is explicitly 'false', actions stay off. Unset or 'true' defers to policy.
  // Missing/corrupt policy fails closed (policy.loadPolicy blocks everything).
  try {
    if (String(process.env.ACTIONS_ENABLED || '').toLowerCase() === 'false') return false;
    return policy.loadPolicy().actions_enabled === true;
  } catch (_) {
    return false;
  }
}

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return store.getSession(cookies[config.sessionCookie]);
}

function deny(reply, code, error) {
  reply.code(code).send({ error });
}

function expectedPort(item) {
  const p = (item.ports || [])[0];
  return p ? p.port : '?';
}

function guardHost(req, reply) {
  if (!hostOk(req)) { deny(reply, 403, 'bad Host'); return false; }
  return true;
}

function guardWrite(req, reply) {
  if (!guardHost(req, reply)) return false;
  if (!originOk(req)) { deny(reply, 403, 'bad Origin'); return false; }
  if (!checkCsrf(req)) { deny(reply, 403, 'missing or invalid CSRF token'); return false; }
  return true;
}

// ---------- security headers ----------
fastify.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'self'");
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  // No-store everywhere, including static UI files: dashboard HTML/JS must
  // never be heuristically cached, or a stale app.js can silently mix with
  // a fresh index.html (empty tables, no errors).
  reply.header('Cache-Control', 'no-store');
  return payload;
});

fastify.addHook('onRequest', async (req, reply) => {
  if (!hostOk(req)) { deny(reply, 403, 'bad Host'); return reply; }
});

// ---------- minimal static server (no dependency) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fs = require('fs');
fastify.get('/*', async (req, reply) => {
  let p = decodeURIComponent(req.params['*'] || '');
  if (!p || p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(__dirname, 'public', p));
  if (!file.startsWith(path.join(__dirname, 'public') + path.sep)) { deny(reply, 403, 'bad path'); return; }
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('no');
    reply.header('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    return fs.readFileSync(file);
  } catch (_) {
    deny(reply, 404, 'not found');
  }
});

// ---------- public (read) ----------
fastify.get('/robots.txt', async (req, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  return 'User-agent: *\nDisallow: /\n';
});

fastify.get('/api/health', async () => ({ ok: true, time: new Date().toISOString(), actions_enabled: actionsEnabled() }));

fastify.get('/api/me', async (req) => ({
  user: currentUser(req),
  csrf: issueCsrf(),
  actions_enabled: actionsEnabled()
}));

// NOTE: there is intentionally no /api/setup. Use node scripts/create-admin.js.

// ---------- auth ----------
fastify.post('/api/auth/login', async (req, reply) => {
  if (!originOk(req)) { deny(reply, 403, 'bad Origin'); return; }
  if (!checkCsrf(req)) { deny(reply, 403, 'missing or invalid CSRF token'); return; }
  const ip = ipOf(req);
  if (loginBlocked(ip)) {
    store.audit({ username: '?', action: 'login', result: 'locked', ip });
    deny(reply, 429, 'too many attempts, try later');
    return;
  }
  const { username, password } = req.body || {};
  const found = store.findUser(String(username || ''));
  const ok = found && store.verifyPassword(String(password || ''), found.password_hash);
  if (!ok) {
    const locked = loginFail(ip);
    store.audit({ username: String(username || '').slice(0, 64), action: 'login', result: locked ? 'locked' : 'denied', ip });
    deny(reply, locked ? 429 : 401, locked ? 'too many attempts, try later' : 'invalid credentials');
    return;
  }
  loginOk(ip);
  const token = store.createSession({ id: found.id, username: found.username, role: found.role }, ip, req.headers['user-agent']);
  reply.header('Set-Cookie', sessionCookie(token, Date.now() + config.sessionMaxS * 1000, isHttps(req)));
  store.audit({ userId: found.id, username: found.username, action: 'login', result: 'ok', ip });
  return { ok: true, username: found.username, role: found.role, csrf: issueCsrf() };
});

fastify.post('/api/auth/logout', async (req, reply) => {
  if (!guardWrite(req, reply)) return;
  const user = currentUser(req);
  const cookies = parseCookies(req.headers.cookie);
  store.destroySession(cookies[config.sessionCookie]);
  reply.header('Set-Cookie', sessionCookie('', 0, isHttps(req)));
  if (user) store.audit({ userId: user.id, username: user.username, action: 'logout', result: 'ok', ip: ipOf(req) });
  return { ok: true };
});

// ---------- discovery ----------
fastify.post('/api/scan', async (req, reply) => {
  if (!guardWrite(req, reply)) return;
  const user = currentUser(req);
  if (!user) { deny(reply, 401, 'login required'); return; }
  try {
    const result = await scanlib.scan();
    store.audit({ userId: user.id, username: user.username, action: 'scan', result: 'ok', ip: ipOf(req) });
    return result;
  } catch (err) {
    store.audit({ userId: user.id, username: user.username, action: 'scan', result: 'failed', error: err.message, ip: ipOf(req) });
    deny(reply, 500, 'scan failed');
  }
});

fastify.get('/api/scan', async (req, reply) => {
  const user = currentUser(req);
  if (!user) { deny(reply, 401, 'login required'); return; }
  return scanlib.loadLastScan() || { scanned_at: null, items: [] };
});

fastify.get('/api/overview', async (req, reply) => {
  const user = currentUser(req);
  if (!user) { deny(reply, 401, 'login required'); return; }
  return overviewlib.overview();
});

// ---------- per-app meta (display fields only) ----------
fastify.patch('/api/apps/:id/meta', async (req, reply) => {
  if (!guardWrite(req, reply)) return;
  const user = currentUser(req);
  if (!user) { deny(reply, 401, 'login required'); return; }
  const last = scanlib.loadLastScan();
  const item = last && last.items ? last.items.find((i) => i.id === req.params.id) : null;
  if (!item) { deny(reply, 404, 'unknown app — run a scan first'); return; }
  const body = req.body || {};
  const patch = {};
  for (const f of policy.META_FIELDS) {
    if (typeof body[f] === 'string') patch[f] = body[f].slice(0, f === 'notes' ? 500 : 80);
  }
  if (patch.category && !policy.CATEGORIES.has(patch.category)) { deny(reply, 400, 'bad category'); return; }
  const ov = policy.loadOverrides();
  ov[req.params.id] = { ...(ov[req.params.id] || {}), ...patch };
  policy.saveOverrides(ov);
  store.audit({ userId: user.id, username: user.username, appId: req.params.id, action: 'meta', result: 'ok', ip: ipOf(req) });
  return { ok: true, meta: ov[req.params.id] };
});

// ---------- logs ----------
fastify.get('/api/apps/:id/logs', async (req, reply) => {
  const user = currentUser(req);
  if (!user) { deny(reply, 401, 'login required'); return; }
  const last = scanlib.loadLastScan();
  const item = last && last.items ? last.items.find((i) => i.id === req.params.id) : null;
  if (!item || item.kind !== 'pm2') { deny(reply, 404, 'no logs for this item'); return; }
  if (!item.logs_enabled) { deny(reply, 403, 'logs disabled for this app'); return; }
  const which = req.query.which === 'err' ? 'err' : 'out';
  try {
    const out = await pm2.jlist();
    const p = out.find((x) => x.name === item.name);
    const file = which === 'err' ? p && p.err_log : p && p.out_log;
    if (!p || !file) { deny(reply, 404, 'no log path'); return; }
    const norm = path.normalize(file);
    const allowed = config.logAllowPrefixes.some((pre) => norm === pre || norm.startsWith(pre + path.sep));
    if (!allowed) { deny(reply, 403, 'log path not allowed'); return; }
    const st = fs.statSync(norm);
    const start = Math.max(0, st.size - config.maxLogBytes);
    const fh = await fs.promises.open(norm, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      const nl = text.indexOf('\n');
      if (start > 0 && nl !== -1) text = text.slice(nl + 1);
      return { path: norm, size_b: st.size, text: redactText(text) };
    } finally {
      await fh.close();
    }
  } catch (err) {
    deny(reply, 400, redactText(err.message).slice(0, 200));
  }
});

// ---------- actions ----------
fastify.post('/api/apps/:id/actions', async (req, reply) => {
  if (!guardWrite(req, reply)) return;
  const user = currentUser(req);
  if (!user) { deny(reply, 401, 'login required'); return; }
  const id = req.params.id;
  const attempt = { userId: user.id, username: user.username, appId: id, ip: ipOf(req) };
  const { action, confirm, confirmName } = req.body || {};

  if (!actionsEnabled()) {
    store.audit({ ...attempt, action: String(action), result: 'blocked', error: 'actions disabled' });
    deny(reply, 403, 'actions are disabled on this panel (read-only mode)');
    return;
  }
  const last = scanlib.loadLastScan();
  const item = last && last.items ? last.items.find((i) => i.id === id) : null;
  if (!item) {
    store.audit({ ...attempt, action: String(action), result: 'blocked', error: 'unknown app' });
    deny(reply, 404, 'unknown app — run a scan first');
    return;
  }
  if (item.kind === 'panel' || item.kind !== 'pm2') {
    store.audit({ ...attempt, action: String(action), result: 'blocked', error: 'not a managed app' });
    deny(reply, 403, `action "${action}" is not allowed for ${id}`);
    return;
  }
  // Permissions come from the CURRENT policy on disk, not the saved scan:
  // an allow/deny edit takes effect without rescanning.
  const pol = policy.loadPolicy();
  const allowed = policy.actionsFor(pol, item.name);
  if (!allowed.includes(action)) {
    store.audit({ ...attempt, action: String(action), result: 'blocked', error: 'action not allowed for app' });
    deny(reply, 403, `action "${action}" is not allowed for ${id}`);
    return;
  }
  if (confirm !== true) { deny(reply, 400, 'confirmation required'); return; }
  if (action === 'stop' && confirmName !== item.name && confirmName !== item.id) {
    deny(reply, 400, 'stop requires typing the app name');
    return;
  }
  // Start guard: a wrapper-launched app whose port is still held by a pid PM2
  // doesn't own would race and fail. Refuse instead of firing a doomed start.
  if (action === 'start' && item.start_blocked) {
    store.audit({ ...attempt, action, result: 'blocked', error: `port held by pid ${item.holder_pid}`, ip: ipOf(req) });
    deny(reply, 409, `start blocked: port ${expectedPort(item)} is still held by pid ${item.holder_pid} (not a known PM2 process)`);
    return;
  }
  try {
    const outcome = await withActionLock(id, async () => {
      await pm2.action(action, item.name); // name re-validated against live jlist
      await cpusampler._tick(); // refresh sampler baseline so the next scan/overview sees new pids
      const fresh = await pm2.jlist();
      const live = fresh.find((x) => x.name === item.name);
      const base = { status: live ? statuslib.mapStatus(live.status) : 'missing', pid: live ? live.pid : 0 };
      const knownPort = (item.ports || []).map((p) => p.port).filter(Boolean);

      if (action === 'stop' && item.indirect && knownPort.length) {
        // Observe only: never kill anything, just wait for the listener to go.
        const freed = await ports.waitFree(knownPort[0], 10000);
        return { ...base, port_released: freed.port_released, waited_ms: freed.waited_ms, port: freed.port, holder_pid: freed.holder_pid || null };
      }
      if (action === 'start' || action === 'restart') {
        // The pm2 action already succeeded; verification is best-effort and a
        // timeout must not turn a real success into a failure.
        const on = await pm2.waitOnline(item.name, 15000);
        let portBound = null;
        if (knownPort.length) {
          const held = await ports.holders(knownPort[0]).catch(() => []);
          portBound = held.length > 0;
        }
        const verified = on.verified && (portBound === null ? true : portBound);
        return { ...base, verified, waited_ms: on.waited_ms, port_bound: portBound };
      }
      return base;
    });
    overviewlib.clearOverview(); // rows must re-read real state on next poll
    store.audit({ ...attempt, action, result: 'ok', ip: ipOf(req) });
    return { ok: true, action, app: id, ...outcome };
  } catch (err) {
    const code = err.status === 409 || err.status === 429 ? 409 : 500;
    store.audit({ ...attempt, action, result: code === 409 ? 'blocked' : 'failed', error: err.message, ip: ipOf(req) });
    deny(reply, code, redactText(err.message).slice(0, 200));
  }
});

// ---------- audit ----------
fastify.get('/api/audit', async (req, reply) => {
  const user = currentUser(req);
  if (!user) { deny(reply, 401, 'login required'); return; }
  return { entries: store.recentAudit(parseInt(req.query.limit || '100', 10)) };
});

// ---------- start ----------
fastify.addHook('onClose', async () => { cpusampler.stop(); });

async function start() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    // eslint-disable-next-line no-console
    console.error(`refusing to bind non-loopback host: ${config.host}`);
    process.exit(1);
  }
  if (config.samplerOn) cpusampler.start();
  await fastify.listen({ host: config.host, port: config.port });
  // eslint-disable-next-line no-console
  console.log(`panel on http://${config.host}:${config.port} (actions ${actionsEnabled() ? 'ENABLED' : 'disabled'})`);
}

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { fastify, start };
