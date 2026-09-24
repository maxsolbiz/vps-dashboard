'use strict';
// Scan + overview + meminfo + jlist-warning tests. No VPS contact (fixtures only).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { buildFixtures, boot, loginAs, authed } = require('./helpers');

let fx; let srv; let sess;

before(async () => {
  fx = buildFixtures();
  fx.resetState();
  srv = await boot(fx.env());
  sess = await loginAs(srv, 'admin', 'long-test-password-1');
  assert.equal(sess.status, 200);
});

after(async () => { await srv.close(); });

test('overview sums the whole descendant tree RSS (hbl-like npm->sh->next-server)', async () => {
  const sampler = require('../lib/cpusampler');
  sampler._reset();
  const get = () => fetch(`${srv.base}/api/overview`, { headers: { Cookie: sess.cookie } }).then((r) => r.json());
  // Cold sampler: falls back to pm2 monit cpu, never advances a baseline per request.
  const ov = await get();
  const web = ov.apps.find((a) => a.name === 'web-pwa');
  assert.ok(web, 'web-pwa present');
  // tree: npm 16000 + sh 2000 + next-server 120000 KB
  assert.equal(web.rss_b, (16000 + 2000 + 120000) * 1024);
  assert.deepEqual(web.pids.sort((a, b) => a - b), [100, 101, 103]);
  assert.equal(web.cpu_pct, 0.1, 'cold sampler falls back to pm2 monit cpu');
  const port = web.ports.find((p) => p.port === 3000);
  assert.ok(port && port.public === true, 'port 3000 flagged public');
  // Shared baseline with injected stamps: prime at t=0, bump ticks, tick at
  // t=5100 (>= 2 s window) -> tree cpu registers. Real-time double ticks
  // stay below the window and keep monit fallback (see cpu.test.js).
  await sampler._tick(0);
  const fs = require('fs');
  const path = require('path');
  const statFile = path.join(fx.dir, 'proc', '103', 'stat');
  const raw = fs.readFileSync(statFile, 'utf8');
  const close = raw.lastIndexOf(')');
  const parts = raw.slice(close + 1).trim().split(/\s+/);
  parts[11] = String(parseInt(parts[11], 10) + 300);
  fs.writeFileSync(statFile, `${raw.slice(0, close + 1)} ${parts.join(' ')}\n`);
  await sampler._tick(5100);
  const ov2 = await get();
  const web2 = ov2.apps.find((a) => a.name === 'web-pwa');
  assert.equal(web2.cpu_pct, 58.8, `tree delta over 5.1 s window, got ${web2.cpu_pct}`);
  // Two rapid reads never advance the baseline: identical values.
  const ov3 = await get();
  assert.equal(ov3.apps.find((a) => a.name === 'web-pwa').cpu_pct, web2.cpu_pct);
  sampler._reset();
});

test('meminfo parser: MemAvailable-based %, never freemem', async () => {
  const r = await fetch(`${srv.base}/api/overview`, { headers: { Cookie: sess.cookie } });
  const ov = await r.json();
  assert.equal(ov.system.mem.source, 'meminfo');
  // (4024548-2765612)/4024548 = 31.28 -> 31.3
  assert.equal(ov.system.mem.use_pct, 31.3);
  assert.equal(ov.system.mem.swap_used_b, (2097148 - 1259260) * 1024);
});

test('pm2 jlist with a warning line before the JSON parses', async () => {
  const pm2 = require('../lib/pm2');
  const out = 'PM2 vFake: test double — warning line before JSON\n[{"name":"x","pid":1,"pm2_env":{"status":"online"}}]';
  const arr = pm2.parseJlist(out);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].name, 'x');
});

test('scan finds and labels every fixture category', async () => {
  const r = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' });
  assert.equal(r.status, 200);
  const sc = await r.json();
  const byId = Object.fromEntries(sc.items.map((i) => [i.id, i]));

  const web = byId['web-pwa'];
  assert.equal(web.kind, 'pm2');
  assert.equal(web.status, 'running');
  assert.equal(web.rss_b, (16000 + 2000 + 120000) * 1024);
  assert.deepEqual(web.domains, ['web.example.com']);
  assert.deepEqual(web.actions, ['start', 'stop', 'restart']);
  assert.equal(web.category, 'unclassified');
  assert.equal(web.in_dump, true);

  const shop = byId['shop-api'];
  assert.deepEqual(shop.domains, ['api.example.com']);
  assert.equal(shop.ports.find((p) => p.port === 3103).public, false);

  const bank = byId['bank-api'];
  assert.equal(bank.logs_enabled, false, 'bank-* logs disabled by policy');

  const purge = byId['nightly-purge'];
  assert.equal(purge.status, 'stopped');
  assert.deepEqual(purge.actions, ['start', 'stop', 'restart']);

  const panel = byId['vps-control-panel'];
  assert.equal(panel.kind, 'panel');
  assert.deepEqual(panel.actions, []);

  const site = sc.items.find((i) => i.kind === 'website');
  assert.ok(site, 'website row exists');
  assert.deepEqual(site.domains, ['static.example.com']);
  assert.equal(site.status, 'running', 'apache is active in fixtures');
  assert.deepEqual(site.actions, []);

  const un = sc.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('rogue'));
  assert.ok(un, 'rogue unmanaged-running row found by cwd');
  assert.equal(un.status, 'unmanaged-running');
  assert.ok(/^unmanaged-[0-9a-f]{8}$/.test(un.id), `stable hash id, got ${un.id}`);
  assert.deepEqual(un.actions, []);

  const old = sc.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('old-app'));
  assert.ok(old, 'unmanaged stopped project found');
  assert.equal(old.status, 'unmanaged-stopped');

  const mono = sc.items.filter((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('mono'));
  assert.equal(mono.length, 1, 'monorepo children collapse under .git top');

  const skipped = sc.items.find((i) => (i.cwd || '').includes('node_modules'));
  assert.equal(skipped, undefined, 'node_modules skipped');

  const infra = byId['infra-apache2'];
  assert.equal(infra.kind, 'infra');
  assert.equal(infra.status, 'running');
  assert.equal(byId['infra-mariadb'].status, 'stopped');

  assert.deepEqual(sc.drift.running_not_in_dump, ['new-app', 'telegram-bot']);
  assert.deepEqual(sc.drift.in_dump_not_running, ['ghost-app']);
  assert.equal(sc.counts.public_binds, 4, 'web-pwa:3000 + bank-api:5000 + 2 website *:80 rows');
});

test('event-invoice-like app (cwd is a scan root) matches via exec_path', async () => {
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const fe = sc.items.find((i) => i.id === 'invoice-fe');
  assert.ok(fe, 'invoice-fe discovered');
  assert.equal(fe.kind, 'pm2');
  assert.equal(fe.status, 'running');
  assert.ok(fe.ports.some((p) => p.port === 3002 && p.public === false), 'local port 3002 attributed');
  const dup = sc.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('event-invoice'));
  assert.equal(dup, undefined, 'event-invoice dir must not appear as unmanaged');
  const mono = sc.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('mono'));
  assert.ok(mono, 'other root projects still surface as unmanaged-stopped');
  assert.equal(mono.status, 'unmanaged-stopped');
});

test('docroot equal to a scan root hides nothing beneath it', async () => {
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const srvSite = sc.items.find((i) => i.kind === 'website' && (i.cwd || '').endsWith('srv'));
  assert.ok(srvSite, 'srv website row exists');
  assert.deepEqual(srvSite.domains, ['srv.example.com']);
  const old = sc.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('old-app'));
  assert.ok(old, 'project under a scan-root docroot still surfaces');
  assert.equal(old.status, 'unmanaged-stopped');
});

test('taskbloom is one website row (ports merged), redirect conf creates none', async () => {
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const sites = sc.items.filter((i) => i.kind === 'website' && (i.cwd || '').includes('taskbloom'));
  assert.equal(sites.length, 1, 'plain + le-ssl confs merge into exactly one row');
  assert.deepEqual(sites[0].ports.map((p) => p.port), [80, 443]);
  assert.ok((sites[0].cwd || '').endsWith('public'), 'fixture docroot is <project>/public');
  const redirect = sc.items.find((i) => (i.domains || []).includes('redirect.example.com'));
  assert.equal(redirect, undefined, 'redirect-only vhost creates no row');
  const dup = sc.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').includes('taskbloom'));
  assert.equal(dup, undefined, 'no duplicate unmanaged row for the website docroot');
});

test('pm2 CLI processes and panel children are never unmanaged', async () => {
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const unPid = (pid) => sc.items.some((i) => i.kind === 'unmanaged' && (i.pids || []).includes(pid));
  assert.equal(unPid(705), false, 'pm2 jlist CLI process excluded');
  assert.equal(unPid(501), false, 'panel child process excluded');
});

test('crash-looping app shows restarting, never stopped', async () => {
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const flaky = sc.items.find((i) => i.id === 'flaky-worker');
  assert.ok(flaky, 'flaky-worker discovered');
  assert.equal(flaky.status, 'restarting');
});

test('unmanaged ids are stable across scans', async () => {
  const a = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const b = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const ida = a.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('rogue')).id;
  const idb = b.items.find((i) => i.kind === 'unmanaged' && (i.cwd || '').endsWith('rogue')).id;
  assert.equal(ida, idb);
});

test('a failed scan clears pending so the next scan runs', async () => {
  const scanlib = require('../lib/scan');
  const orig = scanlib.saveScan;
  scanlib.saveScan = () => { throw new Error('disk full (test)'); };
  try {
    const bad = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' });
    assert.equal(bad.status, 500);
  } finally {
    scanlib.saveScan = orig;
  }
  const good = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' });
  assert.equal(good.status, 200);
});

test('per-app deny_actions removes actions without touching defaults', async () => {
  const fs = require('fs');
  const path = require('path');
  const policyFile = path.join(fx.dir, 'policy.json');
  const backup = fs.readFileSync(policyFile, 'utf8');
  const pol = JSON.parse(backup);
  pol.deny = { 'nightly-purge': ['stop'] };
  fs.writeFileSync(policyFile, JSON.stringify(pol));
  try {
    const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
    const purge = sc.items.find((i) => i.id === 'nightly-purge');
    assert.deepEqual(purge.actions.sort(), ['restart', 'start']);
  } finally {
    fs.writeFileSync(policyFile, backup);
  }
});

test('ignore_paths hides matching unmanaged projects', async () => {
  const fs = require('fs');
  const path = require('path');
  const policyFile = path.join(fx.dir, 'policy.json');
  const backup = fs.readFileSync(policyFile, 'utf8');
  const pol = JSON.parse(backup);
  pol.ignore_paths = [path.join(fx.roots.srv)];
  fs.writeFileSync(policyFile, JSON.stringify(pol));
  try {
    const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
    assert.equal(sc.items.some((i) => (i.cwd || '').endsWith('old-app')), false, 'ignored path hidden');
    assert.ok(sc.items.some((i) => (i.cwd || '').endsWith('mono')), 'other projects unaffected');
  } finally {
    fs.writeFileSync(policyFile, backup);
  }
});

test('scan diff reports new and gone items', async () => {
  const post = () => fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  await post(); // baseline
  fx.resetState({ 'extra-app': { status: 'online', pid: 0, fixturePid: 0, cwd: fx.roots.root, exec: 'node', restarts: 0, unstable: 0, cpu: 0, mem: 1000, uptimeStart: Date.now(), out: null, err: null } });
  const added = await post();
  assert.ok(added.diff.new.includes('extra-app'), `diff.new has extra-app: ${JSON.stringify(added.diff)}`);
  fx.resetState();
  const removed = await post();
  assert.ok(removed.diff.gone.includes('extra-app'), `diff.gone has extra-app: ${JSON.stringify(removed.diff)}`);
});

test('second scan inside the gap is served cached', async () => {
  const config = require('../lib/config');
  config.scanMinGapMs = 60000;
  try {
    const r = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((x) => x.json());
    assert.equal(r.cached, true);
  } finally {
    config.scanMinGapMs = 0;
  }
});
