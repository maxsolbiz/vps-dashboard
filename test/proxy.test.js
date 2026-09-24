'use strict';
// Proxy-safety tests: trustProxy loopback-only, real-IP rate limiting/audit,
// public Host allowlist, https Origin + Secure cookies, robots.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
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

function rawRequest(host, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(srv.port, '127.0.0.1', () => {
      sock.write(`${method} ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString(); });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('spoofed X-Forwarded-For is ignored: audit uses rightmost untrusted IP', async () => {
  const r = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Origin: sess.origin,
      'X-Panel-CSRF': sess.csrf, 'X-Forwarded-For': '9.9.9.9, 1.2.3.4'
    },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password-here' })
  });
  assert.equal(r.status, 401);
  const store = require('../lib/store');
  const last = store.recentAudit(1)[0];
  assert.equal(last.ip, '1.2.3.4', `rightmost untrusted recorded, got ${last.ip}`);
});

test('lockout buckets are per real client IP', async () => {
  const bad = () => fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Origin: sess.origin,
      'X-Panel-CSRF': sess.csrf, 'X-Forwarded-For': '5.6.7.8'
    },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password-here' })
  }).then((r) => r.status);
  for (let i = 0; i < 9; i++) assert.equal(await bad(), 401);
  // Direct IP bucket is untouched: correct login still works.
  const me = await (await fetch(`${srv.base}/api/me`)).json();
  const ok = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: sess.origin, 'X-Panel-CSRF': me.csrf },
    body: JSON.stringify({ username: 'admin', password: 'long-test-password-1' })
  });
  assert.equal(ok.status, 200);
});

test('public Host allowlisted, others rejected', async () => {
  const good = await rawRequest('panel.example', '/api/health');
  assert.match(good, /^HTTP\/1\.1 200/m);
  const bad = await rawRequest('evil.example', '/api/health');
  assert.match(bad, /^HTTP\/1\.1 403/m);
});

test('https Origin for public host passes; http does not', async () => {
  const httpsOk = await fetch(`${srv.base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://panel.example', Cookie: sess.cookie },
    body: '{}'
  });
  // CSRF missing -> 403 with CSRF message proves Origin passed.
  assert.equal(httpsOk.status, 403);
  assert.match((await httpsOk.json()).error, /CSRF/);
  const httpBad = await fetch(`${srv.base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://panel.example', 'X-Panel-CSRF': sess.csrf, Cookie: sess.cookie },
    body: '{}'
  });
  assert.equal(httpBad.status, 403);
  assert.match((await httpBad.json()).error, /Origin/);
});

test('Secure cookie only behind https', async () => {
  const login = (extra) => fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: sess.origin, 'X-Panel-CSRF': sess.csrf, ...extra },
    body: JSON.stringify({ username: 'admin', password: 'long-test-password-1' })
  }).then((r) => r.headers.get('set-cookie') || '');
  const plain = await login({});
  assert.ok(plain.includes('HttpOnly') && plain.includes('SameSite=Strict'), 'base flags present');
  assert.ok(!plain.includes('Secure'), 'no Secure over plain http');
  const tls = await login({ 'X-Forwarded-Proto': 'https' });
  assert.ok(tls.includes('Secure'), 'Secure when X-Forwarded-Proto=https');
});

test('robots.txt disallows all; X-Robots-Tag on API', async () => {
  const r = await fetch(`${srv.base}/robots.txt`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Disallow: \//);
  const h = await fetch(`${srv.base}/api/health`);
  assert.match(h.headers.get('x-robots-tag') || '', /noindex/);
});
