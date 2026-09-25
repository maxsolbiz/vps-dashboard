'use strict';
// Master switch toggle (POST /api/policy/actions-enabled).
// Turning OFF is frictionless; turning ON requires typing ENABLE.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { buildFixtures, boot, loginAs, authed } = require('./helpers');

let fx; let srv; let sess; let policyFile;

function readPolicy() { return JSON.parse(fs.readFileSync(policyFile, 'utf8')); }

function toggle(s, body, extra = {}) {
  return fetch(`${srv.base}/api/policy/actions-enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authed(s), ...extra },
    body: JSON.stringify(body)
  });
}

before(async () => {
  fx = buildFixtures();
  fx.resetState();
  srv = await boot(fx.env());
  policyFile = require('../lib/config').policyPath;
  sess = await loginAs(srv, 'admin', 'long-test-password-1');
  assert.equal(sess.status, 200);
});

// Leave the switch OFF for any later file.
after(async () => {
  const p = readPolicy();
  p.actions_enabled = false;
  fs.writeFileSync(policyFile, JSON.stringify(p, null, 2));
  await srv.close();
});

beforeEach(async () => {
  const p = readPolicy();
  p.actions_enabled = false;
  fs.writeFileSync(policyFile, JSON.stringify(p, null, 2));
  await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' });
});

test('no session -> 401 (after CSRF passes)', async () => {
  const me = await fetch(`${srv.base}/api/me`).then((r) => r.json());
  const r = await fetch(`${srv.base}/api/policy/actions-enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.base, 'X-Panel-CSRF': me.csrf },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(r.status, 401);
});

test('missing CSRF -> 403', async () => {
  const r = await fetch(`${srv.base}/api/policy/actions-enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: sess.origin, Cookie: sess.cookie },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /CSRF/i);
});

test('bad Origin -> 403', async () => {
  const r = await toggle(sess, { enabled: false }, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /Origin/);
});

test('turning OFF always works with no confirm word', async () => {
  const p = readPolicy();
  p.actions_enabled = true;
  fs.writeFileSync(policyFile, JSON.stringify(p, null, 2));
  const r = await toggle(sess, { enabled: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).actions_enabled, false);
  assert.equal(readPolicy().actions_enabled, false);
});

test('turning ON without a confirm word is rejected and changes nothing', async () => {
  const r = await toggle(sess, { enabled: true });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ENABLE/);
  assert.equal(readPolicy().actions_enabled, false, 'file untouched');
});

test('turning ON with the wrong confirm word is rejected and changes nothing', async () => {
  for (const bad of ['enable', 'ENABLE ', 'ENABLED', 'yes', '']) {
    const r = await toggle(sess, { enabled: true, confirm_word: bad });
    assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`);
    assert.equal(readPolicy().actions_enabled, false, `file untouched for ${JSON.stringify(bad)}`);
  }
});

test('turning ON with ENABLE succeeds and is reflected by the next scan without a manual click', async () => {
  const r = await toggle(sess, { enabled: true, confirm_word: 'ENABLE' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).actions_enabled, true);
  assert.equal(readPolicy().actions_enabled, true);

  // A scan issued right after the toggle must already show live actions.
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((x) => x.json());
  const app = sc.items.find((i) => i.id === 'shop-api');
  assert.ok(app.actions.length > 0, 'actions are live in the very next scan, no rescan needed');
});

test('turning OFF is reflected in the next scan too', async () => {
  await toggle(sess, { enabled: true, confirm_word: 'ENABLE' });
  await toggle(sess, { enabled: false });
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((x) => x.json());
  assert.deepEqual(sc.items.find((i) => i.id === 'shop-api').actions, []);
});

test('every other policy key is byte-identical across a toggle', async () => {
  const strip = (o) => { const c = { ...o }; delete c.actions_enabled; return JSON.stringify(c); };
  const before = strip(readPolicy());
  await toggle(sess, { enabled: true, confirm_word: 'ENABLE' });
  assert.equal(strip(readPolicy()), before, 'enabling changed nothing else');
  await toggle(sess, { enabled: false });
  assert.equal(strip(readPolicy()), before, 'disabling changed nothing else');
});

test('the toggle cannot widen the allow list', async () => {
  // telegram-bot has no allow entry; arming the switch must not grant it.
  const before = JSON.stringify(readPolicy().allow);
  await toggle(sess, { enabled: true, confirm_word: 'ENABLE' });
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((x) => x.json());
  assert.deepEqual(sc.items.find((i) => i.id === 'telegram-bot').actions, [], 'still no actions');
  assert.equal(JSON.stringify(readPolicy().allow), before, 'allow unchanged');
  // And the API still refuses it.
  const denied = await fetch(`${srv.base}/api/apps/telegram-bot/actions`, {
    method: 'POST', headers: authed(sess), body: JSON.stringify({ action: 'restart', confirm: true })
  });
  assert.equal(denied.status, 403);
});

test('non-boolean enabled is rejected', async () => {
  for (const bad of ['true', 1, null, undefined]) {
    const r = await toggle(sess, { enabled: bad });
    assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(readPolicy().actions_enabled, false);
});

test('audit records every toggle attempt with the intended state', async () => {
  await toggle(sess, { enabled: true });                        // denied
  await toggle(sess, { enabled: true, confirm_word: 'nope' });  // denied
  await toggle(sess, { enabled: true, confirm_word: 'ENABLE' }); // ok
  await toggle(sess, { enabled: false });                       // ok
  const audit = await fetch(`${srv.base}/api/audit`, { headers: authed(sess) }).then((r) => r.json());
  const e = (audit.entries || []).filter((x) => x.action === 'policy-toggle');
  assert.ok(e.some((x) => x.result === 'denied'), 'denied recorded');
  assert.ok(e.some((x) => x.result === 'ok' && /actions_enabled=true/.test(x.error || '')), 'enable recorded with state');
  assert.ok(e.some((x) => x.result === 'ok' && /actions_enabled=false/.test(x.error || '')), 'disable recorded with state');
  const raw = JSON.stringify(audit);
  assert.doesNotMatch(raw, /"confirm_word"/, 'confirm word never logged');
  assert.doesNotMatch(raw, /nope/, 'the typed word never appears in the log');
});

test('policy file is written through writePrivate (0600 requested)', async () => {
  const calls = [];
  const orig = fs.chmodSync;
  fs.chmodSync = (...a) => { calls.push(a[1]); try { return orig(...a); } catch (_) {} };
  try { await toggle(sess, { enabled: true, confirm_word: 'ENABLE' }); } finally { fs.chmodSync = orig; }
  assert.ok(calls.includes(0o600), `0600 requested, got ${calls.join(',')}`);
});
