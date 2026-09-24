'use strict';
// Test harness: builds a deterministic fake VPS under os.tmpdir() and boots
// the real server against it (fake pm2/ps/ss/systemctl, fixture fs tree,
// apache confs, meminfo, dump). No SSH, no real server contact.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, 'bin');
const PANEL_ROOT = path.join(__dirname, '..');

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function buildFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-'));
  const roots = {
    root: path.join(dir, 'roots', 'root'),
    www: path.join(dir, 'roots', 'www'),
    opt: path.join(dir, 'roots', 'opt'),
    srv: path.join(dir, 'roots', 'srv')
  };
  const logs = path.join(dir, 'logs');

  // --- project dirs ---
  const webPwa = path.join(roots.root, 'web-pwa');
  write(path.join(webPwa, 'package.json'), JSON.stringify({ name: '@test/web-pwa' }));
  fs.mkdirSync(path.join(webPwa, '.git'));
  write(path.join(webPwa, 'node_modules', 'fake', 'package.json'), JSON.stringify({ name: 'should-be-skipped' }));
  fs.mkdirSync(path.join(webPwa, '.next'));
  const api = path.join(roots.root, 'api');
  write(path.join(api, 'package.json'), JSON.stringify({ name: 'shop-api' }));
  const nightly = path.join(roots.root, 'nightly');
  write(path.join(nightly, 'package.json'), JSON.stringify({ name: 'nightly-purge' }));
  write(path.join(nightly, 'ecosystem.config.js'), 'module.exports={apps:[]};');
  const mono = path.join(roots.root, 'mono');
  fs.mkdirSync(path.join(mono, '.git'), { recursive: true });
  write(path.join(mono, 'apps', 'a', 'package.json'), JSON.stringify({ name: 'mono-a' }));
  write(path.join(mono, 'apps', 'b', 'package.json'), JSON.stringify({ name: 'mono-b' }));
  write(path.join(roots.www, 'taskbloom', 'composer.json'), JSON.stringify({ name: 'taskbloom' }));
  const rogue = path.join(roots.opt, 'rogue');
  write(path.join(rogue, 'package.json'), JSON.stringify({ name: 'rogue' }));
  write(path.join(rogue, 'server.js'), 'console.log(1);');
  write(path.join(roots.srv, 'old-app', 'package.json'), JSON.stringify({ name: 'old-app' }));
  const newapp = path.join(roots.root, 'newapp');
  write(path.join(newapp, 'package.json'), JSON.stringify({ name: 'new-app' }));
  // event-invoice-like: PM2 cwd is the scan root itself, real code in start script
  const invoice = path.join(roots.root, 'event-invoice');
  write(path.join(invoice, 'package.json'), JSON.stringify({ name: 'event-invoice' }));
  write(path.join(invoice, 'start-frontend.sh'), '#!/bin/bash\nPORT=3002 exec node server.js\n');

  // --- logs (bank log carries sensitive samples for redaction tests) ---
  write(path.join(logs, 'web-pwa-out.log'), 'ready on port 3000\nrequest ok\n');
  write(path.join(logs, 'web-pwa-err.log'), 'minor warn\n');
  write(path.join(logs, 'bank-api-out.log'),
    'user alma@example.com token=tok_ABC123xyz transfer iban PK36SCBL0000001123456702 cnic 35202-1234567-1 phone 03001234567 card 4111111111111111\n');

  // --- ps fixture (pids stable across pm2 state changes) ---
  const psTxt = [
    '    1     0    2000  0.0 100000 /sbin/init',
    `  100     1   16000  0.1 200000 /usr/bin/npm start -p 3000`,
    '  101   100    2000  0.0 199000 sh -c next start -p 3000',
    '  103   101  120000  2.5 198000 next-server (v16)',
    `  200     1   60000  0.8 150000 node ${api}/dist/index.js`,
    `  300     1   45000  0.5 140000 node ${roots.root}/bank/dist/server.js`,
    `  400     1   30000  0.3  10000 node ${newapp}/index.js`,
    `  500     1   25000  0.2   9000 node ${PANEL_ROOT}/server.js`,
    `  501   500    9000  0.1    100 node ${PANEL_ROOT}/scripts/dev-fixtures.js`,
    `  800     1   25000  0.4  50000 node ${roots.root}/meezan-bank/backend/scripts/telegram-bot.mjs`,
    `  600     1   40000  1.1  50000 node ${rogue}/server.js`,
    `  700     1   25000  0.3  90000 /bin/bash ${invoice}/start-frontend.sh`,
    '  705     1    8000  0.0   1000 node /usr/lib/node_modules/pm2/bin/pm2 jlist',
    '  247     1   30000  0.2  80000 PM2 v7.0.1: God Daemon'
  ].join('\n') + '\n';
  write(path.join(dir, 'ps.txt'), psTxt);

  // --- /proc/<pid>/stat fixtures (utime/stime ticks for CPU deltas) ---
  const procDir = path.join(dir, 'proc');
  const statLine = (pid, ppid, comm, utime, stime) =>
    `${pid} (${comm}) R ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
  for (const [pid, ppid, comm, u, s] of [
    [100, 1, 'npm', 10, 5], [101, 100, 'sh', 2, 1], [103, 101, 'next-server (v16)', 250, 60],
    [200, 1, 'node', 80, 20], [300, 1, 'node', 50, 10], [400, 1, 'node', 30, 6],
    [500, 1, 'node', 20, 4], [600, 1, 'node', 110, 22], [700, 1, 'bash', 30, 6]
  ]) {
    write(path.join(procDir, String(pid), 'stat'), statLine(pid, ppid, comm, u, s) + '\n');
  }

  // --- ss fixture ---
  write(path.join(dir, 'ss.txt'), [
    'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("next-server",pid=103,fd=19))',
    'LISTEN 0 511 127.0.0.1:3103 0.0.0.0:* users:(("node",pid=200,fd=21))',
    'LISTEN 0 511 0.0.0.0:5000 0.0.0.0:* users:(("node",pid=300,fd=36))',
    'LISTEN 0 511 127.0.0.1:3002 0.0.0.0:* users:(("bash",pid=700,fd=10))',
    'LISTEN 0 511 127.0.0.1:4000 0.0.0.0:* users:(("node",pid=600,fd=10))'
  ].join('\n') + '\n');

  // --- apache confs ---
  const apacheDir = path.join(dir, 'apache');
  write(path.join(apacheDir, 'shop.conf'),
    `<VirtualHost *:80>\nServerName api.example.com\nProxyPass / http://127.0.0.1:3103/\nProxyPassReverse / http://127.0.0.1:3103/\n</VirtualHost>\n`);
  write(path.join(apacheDir, 'web.conf'),
    `<VirtualHost *:80>\nServerName web.example.com\nProxyPass / http://127.0.0.1:3000/\nProxyPassReverse / http://127.0.0.1:3000/\n</VirtualHost>\n`);
  const taskbloomPublic = path.join(roots.www, 'taskbloom', 'public');
  write(path.join(apacheDir, 'site.conf'),
    `<VirtualHost *:80>\nServerName static.example.com\nDocumentRoot ${taskbloomPublic}\n</VirtualHost>\n`);
  fs.mkdirSync(taskbloomPublic, { recursive: true });
  // Same site over TLS: must merge into ONE website row with ports 80+443.
  write(path.join(apacheDir, 'site-le-ssl.conf'),
    `<VirtualHost *:443>\nServerName static.example.com\nDocumentRoot ${taskbloomPublic}\n</VirtualHost>\n`);
  // Redirect-only vhost (no proxy, no docroot): must create no row at all.
  write(path.join(apacheDir, 'old-redirect.conf'),
    '<VirtualHost *:80>\nServerName redirect.example.com\nRewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]\n</VirtualHost>\n');
  // Docroot that IS a scan root: must not hide the projects beneath it.
  write(path.join(apacheDir, 'srv.conf'),
    `<VirtualHost *:80>\nServerName srv.example.com\nDocumentRoot ${roots.srv}\n</VirtualHost>\n`);

  // --- meminfo (4 GB box) ---
  write(path.join(dir, 'meminfo'),
    'MemTotal:        4024548 kB\nMemFree:          281600 kB\nMemAvailable:    2765612 kB\n' +
    'SwapTotal:       2097148 kB\nSwapFree:        1259260 kB\n');

  // --- pm2 dump (names only matter; junk fields must be ignored) ---
  write(path.join(dir, 'dump.pm2'), JSON.stringify([
    { name: 'shop-api', pm_exec_path: '/should/be/ignored' },
    { name: 'web-pwa' }, { name: 'ghost-app' }, { name: 'nightly-purge' },
    { name: 'bank-api' }, { name: 'vps-control-panel' },
    { name: 'invoice-fe' }, { name: 'flaky-worker' }
  ]));

  // --- /proc cwd map (tests only; Windows has no /proc) ---
  write(path.join(dir, 'proc-cwd.json'), JSON.stringify({ 600: rogue }));

  // --- systemctl map ---
  write(path.join(dir, 'systemctl.json'), JSON.stringify({
    apache2: 'active', postgresql: 'active', mariadb: 'inactive', 'redis-server': 'inactive'
  }));

  // --- policy + overrides ---
  write(path.join(dir, 'policy.json'), JSON.stringify({
    default_actions: ['start', 'stop', 'restart'],
    allow: {
      'web-pwa': ['start', 'stop', 'restart'],
      'shop-api': ['start', 'stop', 'restart'],
      'bank-api': ['restart'],
      'nightly-purge': ['start', 'stop', 'restart'],
      'new-app': ['restart'],
      'invoice-fe': ['start', 'stop', 'restart'],
      'flaky-worker': ['restart']
    },
    deny: {},
    actions_enabled: true,
    ignore_paths: [],
    logs_disabled: ['bank-*'],
    panel_name: 'vps-control-panel'
  }));
  write(path.join(dir, 'overrides.json'), '{}');

  // --- pm2 base state ---
  const now = Date.now();
  const base = {
    apps: {
      'web-pwa': { status: 'online', pid: 100, fixturePid: 100, cwd: webPwa, exec: '/usr/bin/npm', restarts: 12, unstable: 0, cpu: 0.1, mem: 16384000, uptimeStart: now - 200000000, out: path.join(logs, 'web-pwa-out.log'), err: path.join(logs, 'web-pwa-err.log') },
      'shop-api': { status: 'online', pid: 200, fixturePid: 200, cwd: api, exec: `${api}/dist/index.js`, restarts: 3, unstable: 0, cpu: 0.8, mem: 61440000, uptimeStart: now - 150000000, out: path.join(logs, 'web-pwa-out.log'), err: path.join(logs, 'web-pwa-err.log') },
      'bank-api': { status: 'online', pid: 300, fixturePid: 300, cwd: path.join(roots.root, 'bank'), exec: `${roots.root}/bank/dist/server.js`, restarts: 1, unstable: 0, cpu: 0.5, mem: 46080000, uptimeStart: now - 140000000, out: path.join(logs, 'bank-api-out.log'), err: null },
      'nightly-purge': { status: 'stopped', pid: 0, fixturePid: 0, cwd: nightly, exec: `${nightly}/purge.mjs`, restarts: 0, unstable: 1, cpu: 0, mem: 0, uptimeStart: 0, out: null, err: null },
      'new-app': { status: 'online', pid: 400, fixturePid: 400, cwd: newapp, exec: `${newapp}/index.js`, restarts: 0, unstable: 0, cpu: 0.3, mem: 30720000, uptimeStart: now - 10000000, out: path.join(logs, 'web-pwa-out.log'), err: null },
      'invoice-fe': { status: 'online', pid: 700, fixturePid: 700, cwd: roots.root, exec: `${invoice}/start-frontend.sh`, restarts: 2, unstable: 0, cpu: 0.3, mem: 25600000, uptimeStart: now - 8000000, out: path.join(logs, 'web-pwa-out.log'), err: null },
      'flaky-worker': { status: 'waiting restart', pid: 0, fixturePid: 0, cwd: nightly, exec: `${nightly}/worker.mjs`, restarts: 41, unstable: 3, cpu: 0, mem: 0, uptimeStart: 0, out: null, err: null },
      'telegram-bot': { status: 'online', pid: 800, fixturePid: 800, cwd: path.join(roots.root, 'meezan-bank'), exec: `${roots.root}/meezan-bank/backend/scripts/telegram-bot.mjs`, restarts: 0, unstable: 0, cpu: 0.4, mem: 25165824, uptimeStart: now - 50000000, out: null, err: null },
      'vps-control-panel': { status: 'online', pid: 500, fixturePid: 500, cwd: PANEL_ROOT, exec: `${PANEL_ROOT}/server.js`, restarts: 0, unstable: 0, cpu: 0.2, mem: 25600000, uptimeStart: now - 9000000, out: null, err: null }
    }
  };
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  return {
    dir, roots, logs,
    resetState(extra) {
      const s = JSON.parse(JSON.stringify(base));
      if (extra) for (const [k, v] of Object.entries(extra)) s.apps[k] = v;
      fs.writeFileSync(path.join(stateDir, 'pm2-state.json'), JSON.stringify(s));
    },
    env(extra = {}) {
      return {
        PORT: '0',
        HOST: '127.0.0.1',
        ACTIONS_ENABLED: 'true',
        PANEL_USERS: path.join(dir, 'users.json'),
        PANEL_AUDIT: path.join(dir, 'audit.jsonl'),
        PANEL_POLICY: path.join(dir, 'policy.json'),
        PANEL_OVERRIDES: path.join(dir, 'overrides.json'),
        PANEL_LAST_SCAN: path.join(dir, 'last-scan.json'),
        PANEL_BIN_PM2: `node ${path.join(BIN, 'pm2')}`,
        PANEL_BIN_PS: `node ${path.join(BIN, 'ps')}`,
        PANEL_BIN_SS: `node ${path.join(BIN, 'ss')}`,
        PANEL_BIN_SYSTEMCTL: `node ${path.join(BIN, 'systemctl')}`,
        PANEL_FAKE_STATE: stateDir,
        PANEL_FAKE_PS: path.join(dir, 'ps.txt'),
        PANEL_FAKE_SS: path.join(dir, 'ss.txt'),
        PANEL_FAKE_SYSTEMCTL: path.join(dir, 'systemctl.json'),
        PANEL_APACHE_DIR: apacheDir,
        PANEL_MEMINFO: path.join(dir, 'meminfo'),
        PANEL_PROC_ROOT: path.join(dir, 'proc'),
        PANEL_CLK_TCK: '100',
        PANEL_PM2_DUMP: path.join(dir, 'dump.pm2'),
        PANEL_PROC_CWD: path.join(dir, 'proc-cwd.json'),
        PANEL_SCAN_ROOTS: [roots.root, roots.www, roots.opt, roots.srv].join(','),
        PANEL_PM2_TTL_MS: '0',
        PANEL_SCAN_GAP_MS: '0',
        PANEL_SAMPLER: '0', // tests drive ticks manually; server never auto-starts it
        PANEL_PUBLIC_HOST: 'panel.example',
        PANEL_LOG_PREFIXES: logs,
        ...extra
      };
    }
  };
}

async function boot(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  const { fastify } = require('../server');
  await fastify.listen({ host: '127.0.0.1', port: 0 });
  const port = fastify.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base, port,
    async close() { await fastify.close(); },
    async me() {
      const r = await fetch(`${base}/api/me`);
      return r.json();
    }
  };
}

async function loginAs(srv, username, password) {
  const store = require('../lib/store');
  try { store.createUser(username, password); } catch (_) { /* may exist */ }
  const me = await (await fetch(`${srv.base}/api/me`)).json();
  const origin = srv.base;
  const r = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Panel-CSRF': me.csrf },
    body: JSON.stringify({ username, password })
  });
  const body = await r.json();
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, body, csrf: body.csrf || me.csrf, cookie, origin };
}

function authed(s) {
  return {
    'Content-Type': 'application/json',
    Origin: s.origin,
    'X-Panel-CSRF': s.csrf,
    Cookie: s.cookie
  };
}

module.exports = { buildFixtures, boot, loginAs, authed, PANEL_ROOT };
