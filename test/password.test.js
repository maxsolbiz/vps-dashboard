'use strict';
// Self-service panel-login password change. NOT the Apache Basic Auth password,
// which stays a manual htpasswd command and is never handled by this app.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { buildFixtures, boot, loginAs, authed } = require('./helpers');

const OLD_PW = 'long-test-password-1';
const NEW_PW = 'brand-new-password-99';

let fx; let srv; let sess; let usersFile;

function changePw(s, cur, next, extraHeaders = {}) {
  return fetch(`${srv.base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authed(s), ...extraHeaders },
    body: JSON.stringify({ current_password: cur, new_password: next })
  });
}

before(async () => {
  fx = buildFixtures();
  fx.resetState();
  srv = await boot(fx.env());
  usersFile = require('../lib/config').usersPath;
});

after(async () => {
  // leave the fixture user on the original password for any later test file
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const store = require('../lib/store');
  for (const u of users) u.password_hash = store.hashPassword(OLD_PW);
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
  await srv.close();
});

test('no session -> 401 (with a valid CSRF token)', async () => {
  // Without CSRF the write guard rejects first (403, same as every other write
  // endpoint). /api/me issues a token even when logged out, so we can prove the
  // authenticated branch separately.
  const noCsrf = await fetch(`${srv.base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: OLD_PW, new_password: NEW_PW })
  });
  assert.equal(noCsrf.status, 403, 'CSRF guard runs before the auth check');

  const me = await fetch(`${srv.base}/api/me`).then((r) => r.json());
  const r = await fetch(`${srv.base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.base, 'X-Panel-CSRF': me.csrf },
    body: JSON.stringify({ current_password: OLD_PW, new_password: NEW_PW })
  });
  assert.equal(r.status, 401, 'valid CSRF but no session -> 401');
});

test('missing CSRF -> 403 (same as other writes)', async () => {
  sess = sess || await loginAs(srv, 'admin', OLD_PW);
  const r = await fetch(`${srv.base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: sess.origin, Cookie: sess.cookie },
    body: JSON.stringify({ current_password: OLD_PW, new_password: NEW_PW })
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /CSRF/i);
});

test('bad Origin -> 403', async () => {
  sess = sess || await loginAs(srv, 'admin', OLD_PW);
  const r = await changePw(sess, OLD_PW, NEW_PW, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /Origin/);
});

test('wrong current password -> 401 and is rejected as a credential guess', async () => {
  sess = sess || await loginAs(srv, 'admin', OLD_PW);
  const r = await changePw(sess, 'not-the-password-at-all', NEW_PW);
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /incorrect/i);
  // password must be unchanged
  const still = await loginAs(srv, 'admin', OLD_PW);
  assert.equal(still.status, 200, 'old password still works after a failed change');
});

test('new password under 12 chars -> 400', async () => {
  sess = sess || await loginAs(srv, 'admin', OLD_PW);
  const r = await changePw(sess, OLD_PW, 'short123');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /12/);
});

test('new password equal to current -> 400', async () => {
  sess = sess || await loginAs(srv, 'admin', OLD_PW);
  const r = await changePw(sess, OLD_PW, OLD_PW);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /different/i);
});

test('successful change: new password works on a fresh session, old one does not', async () => {
  sess = sess || await loginAs(srv, 'admin', OLD_PW);
  // a second session for the same user, to be revoked by the change
  const other = await loginAs(srv, 'admin', OLD_PW);
  assert.equal(other.status, 200);

  const r = await changePw(sess, OLD_PW, NEW_PW);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.other_sessions_revoked >= 1, `at least the other session was revoked, got ${body.other_sessions_revoked}`);

  const fresh = await loginAs(srv, 'admin', NEW_PW);
  assert.equal(fresh.status, 200, 'new password logs in');
  const stale = await loginAs(srv, 'admin', OLD_PW);
  assert.equal(stale.status, 401, 'old password no longer works');
});

// /api/me always answers 200 and reports user:null when logged out, so session
// liveness is asserted on the body, not the status code.
async function whoami(cookie) {
  const body = await fetch(`${srv.base}/api/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  return body.user;
}

test('the current session survives its own password change', async () => {
  const fresh = await loginAs(srv, 'admin', NEW_PW);
  assert.ok((await whoami(fresh.cookie)), 'session valid before');
  const r = await changePw(fresh, NEW_PW, 'another-new-password-7');
  assert.equal(r.status, 200);
  assert.ok((await whoami(fresh.cookie)), 'session still valid after changing its own password');
  await changePw(fresh, 'another-new-password-7', NEW_PW);
});

test('other sessions are invalidated, current one is not', async () => {
  const keeper = await loginAs(srv, 'admin', NEW_PW);
  const victim = await loginAs(srv, 'admin', NEW_PW);
  assert.ok((await whoami(victim.cookie)), 'victim session valid beforehand');

  const r = await changePw(keeper, NEW_PW, 'rotated-password-123');
  assert.equal(r.status, 200);
  assert.ok((await r.json()).other_sessions_revoked >= 1);

  assert.ok((await whoami(keeper.cookie)), 'changing session stays alive');
  assert.equal(await whoami(victim.cookie), null, 'other session is revoked');
});

test('audit records change-password without ever storing the password', async () => {
  const s = await loginAs(srv, 'admin', 'rotated-password-123');
  await changePw(s, 'rotated-password-123', 'audit-probe-password-5');
  const audit = await fetch(`${srv.base}/api/audit`, { headers: authed(s) }).then((r) => r.json());
  const entries = (audit.entries || audit || []).filter((e) => e.action === 'change-password');
  assert.ok(entries.length >= 1, 'change-password is audited');
  assert.ok(entries.some((e) => e.result === 'ok'), 'success recorded');
  assert.ok(entries.some((e) => e.result === 'denied'), 'failed attempt recorded');
  const raw = JSON.stringify(audit);
  for (const secret of ['audit-probe-password-5', 'rotated-password-123', NEW_PW, OLD_PW]) {
    assert.doesNotMatch(raw, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `audit must not contain ${secret}`);
  }
});

test('users.json is written through writePrivate (0600 requested)', async () => {
  // Windows does not enforce POSIX modes, so intercept chmodSync the same way
  // test/cpu.test.js does rather than trusting stat().
  const calls = [];
  const orig = fs.chmodSync;
  fs.chmodSync = (...a) => { calls.push(a[1]); try { return orig(...a); } catch (_) {} };
  try {
    const s = await loginAs(srv, 'admin', 'rotated-password-123');
    await changePw(s, 'rotated-password-123', 'perm-probe-password-3');
  } finally {
    fs.chmodSync = orig;
  }
  assert.ok(calls.includes(0o600), `0600 requested for users.json, got ${calls.join(',')}`);
});
