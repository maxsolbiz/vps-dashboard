'use strict';
// Login rate limit + lockout (isolated server, low thresholds).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { buildFixtures, boot } = require('./helpers');

let srv;

before(async () => {
  const fx = buildFixtures();
  fx.resetState();
  srv = await boot(fx.env({ PANEL_LOGIN_MAX_ATTEMPTS: '3', PANEL_LOGIN_WINDOW_S: '60', PANEL_LOGIN_LOCKOUT_S: '60' }));
});

after(async () => { await srv.close(); });

test('repeated bad logins trigger 429 lockout', async () => {
  const me = await (await fetch(`${srv.base}/api/me`)).json();
  const attempt = () => fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.base, 'X-Panel-CSRF': me.csrf },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password-here' })
  }).then((r) => r.status);
  const codes = [await attempt(), await attempt(), await attempt(), await attempt()];
  assert.deepEqual(codes.slice(0, 2), [401, 401]);
  assert.ok(codes.includes(429), `lockout reached: ${codes}`);
});
