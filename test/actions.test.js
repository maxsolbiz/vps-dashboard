'use strict';
// Action tests: happy paths return the REAL post-action status; rejections audited.
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
  // baseline scan so actions can resolve items
  const r = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' });
  assert.equal(r.status, 200);
});

after(async () => { await srv.close(); });

async function act(id, body) {
  const r = await fetch(`${srv.base}/api/apps/${encodeURIComponent(id)}/actions`, {
    method: 'POST', headers: authed(sess), body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

test('start happy path returns real post-action status', async () => {
  const r = await act('nightly-purge', { action: 'start', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'running'); // mapped PM2 status, not raw 'online'
  assert.equal(r.body.app, 'nightly-purge');
});

test('stop without typed name is rejected', async () => {
  const r = await act('shop-api', { action: 'stop', confirm: true });
  assert.equal(r.status, 400);
});

test('stop with typed name works and reports stopped', async () => {
  const r = await act('shop-api', { action: 'stop', confirm: true, confirmName: 'shop-api' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'stopped');
});

test('restart returns online with bumped restarts in jlist', async () => {
  const r = await act('web-pwa', { action: 'restart', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'running');
  const pm2 = require('../lib/pm2');
  pm2.clearCache();
  const live = await pm2.jlist();
  assert.equal(live.find((x) => x.name === 'web-pwa').restarts, 13);
});

test('overview cache is cleared after an action', async () => {
  const config = require('../lib/config');
  config.pm2CacheMs = 60000;
  try {
    const get = () => fetch(`${srv.base}/api/overview`, { headers: { Cookie: sess.cookie } }).then((r) => r.json());
    await get(); // prime
    const cached = await get();
    assert.equal(cached.cached, true);
    const r = await act('bank-api', { action: 'restart', confirm: true });
    assert.equal(r.status, 200);
    const fresh = await get();
    assert.equal(fresh.cached, undefined, 'overview re-read real state after action');
  } finally {
    config.pm2CacheMs = 0;
  }
});

test('policy deny takes effect at action time without rescanning', async () => {
  const fs = require('fs');
  const policyFile = require('../lib/config').policyPath;
  const backup = fs.readFileSync(policyFile, 'utf8');
  const pol = JSON.parse(backup);
  pol.deny = { 'bank-api': ['restart'] };
  fs.writeFileSync(policyFile, JSON.stringify(pol));
  try {
    // No rescan between policy change and action.
    const r = await act('bank-api', { action: 'restart', confirm: true });
    assert.equal(r.status, 403);
  } finally {
    fs.writeFileSync(policyFile, backup);
  }
  // And the action works again once deny is lifted.
  const r2 = await act('bank-api', { action: 'restart', confirm: true });
  assert.equal(r2.status, 200);
});

test('policy actions_enabled toggles actions without restart', async () => {
  const fs = require('fs');
  const policyFile = require('../lib/config').policyPath;
  const backup = fs.readFileSync(policyFile, 'utf8');
  try {
    const off = JSON.parse(backup);
    off.actions_enabled = false;
    fs.writeFileSync(policyFile, JSON.stringify(off));
    const blocked = await act('bank-api', { action: 'restart', confirm: true });
    assert.equal(blocked.status, 403);
    const on = JSON.parse(backup);
    on.actions_enabled = true;
    fs.writeFileSync(policyFile, JSON.stringify(on));
    const allowed = await act('bank-api', { action: 'restart', confirm: true });
    assert.equal(allowed.status, 200);
  } finally {
    fs.writeFileSync(policyFile, backup);
  }
});

test('unknown app, panel itself, and injected names are rejected', async () => {
  const nope = await act('no-such-app', { action: 'restart', confirm: true });
  assert.equal(nope.status, 404);
  const panel = await act('vps-control-panel', { action: 'restart', confirm: true });
  assert.equal(panel.status, 403);
  const inj = await act('x; rm -rf /', { action: 'restart', confirm: true });
  assert.ok([403, 404].includes(inj.status), `injection rejected, got ${inj.status}`);
  const pm2 = require('../lib/pm2');
  await assert.rejects(() => pm2.action('restart', 'x; rm -rf /'), /bad process name/);
  await assert.rejects(() => pm2.action('save', 'web-pwa'), /not allowed/);
});

test('restart + immediate scan: no ghost row for the old pid, correct tree RSS', async () => {
  const fs = require('fs');
  const path = require('path');
  const sampler = require('../lib/cpusampler');
  const psFile = path.join(fx.dir, 'ps.txt');
  const origPs = fs.readFileSync(psFile, 'utf8');
  sampler._reset();
  await sampler._tick(); // prime with old pids (bank-api = 300)
  // Restart moves bank-api 300 -> 5300 in the fake pm2; the server _ticks
  // after the action. Rewrite ps the way reality would: old pid gone.
  const r = await act('bank-api', { action: 'restart', confirm: true });
  assert.equal(r.status, 200);
  const bankCwd = path.join(fx.roots.root, 'bank');
  const psNew = origPs
    .split('\n')
    .filter((l) => !/^\s*300\s+1\s/.test(l))
    .join('\n')
    .replace(/\n$/, '\n') + ` 5300     1   45000  0.5  5000 node ${bankCwd}/dist/server.js\n`;
  fs.writeFileSync(psFile, psNew);
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((x) => x.json());
  const bank = sc.items.find((i) => i.id === 'bank-api');
  assert.deepEqual(bank.pids, [5300]);
  assert.equal(bank.rss_b, 45000 * 1024, 'tree RSS from the fresh ps, not the stale sampler list');
  const ghost = sc.items.some((i) => i.kind === 'unmanaged' && (i.pids || []).includes(300));
  assert.equal(ghost, false, 'no ghost unmanaged row for the dead pid');
  fs.writeFileSync(psFile, origPs);
  sampler._reset();
});

test('overview uses a fresh ps when the sampler snapshot misses jlist pids', async () => {
  const fs = require('fs');
  const path = require('path');
  const sampler = require('../lib/cpusampler');
  const psFile = path.join(fx.dir, 'ps.txt');
  const origPs = fs.readFileSync(psFile, 'utf8');
  const bankCwd = path.join(fx.roots.root, 'bank');
  try {
    sampler._reset();
    await sampler._tick(); // snapshot has pid 300 (bank-api pre-restart pid)
    // bank-api is already at pid 5300 from the previous test; rewrite ps so
    // ONLY the new pid exists, with a distinctive RSS.
    const psNew = origPs
      .split('\n')
      .filter((l) => !/^\s*300\s+1\s/.test(l))
      .join('\n')
      .replace(/\n$/, '\n') + ` 5300     1   99000  0.9  5000 node ${bankCwd}/dist/server.js\n`;
    fs.writeFileSync(psFile, psNew);
    // No _tick: the sampler snapshot is stale (has 300, lacks 5300).
    const ov = await fetch(`${srv.base}/api/overview`, { headers: { Cookie: sess.cookie } }).then((x) => x.json());
    const bank = ov.apps.find((a) => a.name === 'bank-api');
    assert.deepEqual(bank.pids, [5300]);
    assert.equal(bank.rss_b, 99000 * 1024, 'tree from fresh ps, not the stale snapshot');
  } finally {
    fs.writeFileSync(psFile, origPs);
    sampler._reset();
  }
});

test('allow list: unlisted app has no actions and is blocked', async () => {
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const item = sc.items.find((i) => i.id === 'telegram-bot');
  assert.ok(item, 'telegram-bot is discovered');
  assert.deepEqual(item.actions, [], 'unlisted app gets no buttons');
  const r = await act('telegram-bot', { action: 'restart', confirm: true });
  assert.equal(r.status, 403);
});

test('allow list: partial entry limits that app (bank-api restart only)', async () => {
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
  const item = sc.items.find((i) => i.id === 'bank-api');
  assert.deepEqual(item.actions, ['restart']);
  const stop = await act('bank-api', { action: 'stop', confirm: true, confirmName: 'bank-api' });
  assert.equal(stop.status, 403, 'stop not in its allow entry');
  const restart = await act('bank-api', { action: 'restart', confirm: true });
  assert.equal(restart.status, 200);
});

test('deny still overrides allow', async () => {
  const fs = require('fs');
  const policyFile = require('../lib/config').policyPath;
  const backup = fs.readFileSync(policyFile, 'utf8');
  const pol = JSON.parse(backup);
  pol.deny = { 'shop-api': ['stop', 'restart'] };
  fs.writeFileSync(policyFile, JSON.stringify(pol));
  try {
    const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((r) => r.json());
    assert.deepEqual(sc.items.find((i) => i.id === 'shop-api').actions, ['start']);
    const r = await act('shop-api', { action: 'restart', confirm: true });
    assert.equal(r.status, 403);
  } finally {
    fs.writeFileSync(policyFile, backup);
  }
});

test('allow list: missing or malformed allow blocks everything', async () => {
  const fs = require('fs');
  const policyFile = require('../lib/config').policyPath;
  const backup = fs.readFileSync(policyFile, 'utf8');
  const cases = [
    ['missing allow', (p) => { delete p.allow; }],
    ['allow is an array', (p) => { p.allow = ['web-pwa']; }],
    ['allow is a string', (p) => { p.allow = 'web-pwa'; }],
    ['entry is not an array', (p) => { p.allow = { 'web-pwa': 'restart' }; }]
  ];
  for (const [label, mutate] of cases) {
    const pol = JSON.parse(backup);
    mutate(pol);
    fs.writeFileSync(policyFile, JSON.stringify(pol));
    try {
      const r = await act('web-pwa', { action: 'restart', confirm: true });
      assert.equal(r.status, 403, label);
    } finally {
      fs.writeFileSync(policyFile, backup);
    }
  }
});

test('allow list: invalid action names in an entry are ignored', () => {
  const policy = require('../lib/policy');
  const clean = policy.normalizeAllow({
    'good-app': ['restart', 'delete', 'save', 'restart'],
    'bad name!': ['restart'],
    'also-bad': 'restart',
    'empty-app': []
  });
  assert.deepEqual(clean, { 'good-app': ['restart'] });
  assert.deepEqual(policy.normalizeAllow(undefined), {});
  assert.deepEqual(policy.actionsFor({ allow: clean, deny: {}, default_actions: ['start', 'stop', 'restart'] }, 'nope'), []);
});

test('ACTIONS_ENABLED=false env kill-switch -> 403 + audit entry', async () => {
  const prev = process.env.ACTIONS_ENABLED;
  process.env.ACTIONS_ENABLED = 'false';
  try {
    const r = await act('web-pwa', { action: 'restart', confirm: true });
    assert.equal(r.status, 403);
    const store = require('../lib/store');
    const blocked = store.recentAudit(5).find((e) => e.action === 'restart' && e.result === 'blocked');
    assert.ok(blocked, 'blocked attempt audited');
  } finally {
    if (prev === undefined) delete process.env.ACTIONS_ENABLED;
    else process.env.ACTIONS_ENABLED = prev;
  }
});

test('policy true + env unset -> allowed (env only kills when explicit false)', async () => {
  const prev = process.env.ACTIONS_ENABLED;
  delete process.env.ACTIONS_ENABLED;
  try {
    const r = await act('bank-api', { action: 'restart', confirm: true });
    assert.equal(r.status, 200);
  } finally {
    if (prev === undefined) delete process.env.ACTIONS_ENABLED;
    else process.env.ACTIONS_ENABLED = prev;
  }
});
