'use strict';
// Security tests: auth gating, Host/Origin/CSRF, redaction, no /api/setup.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const { buildFixtures, boot, loginAs, authed } = require('./helpers');

let fx; let srv; let sess;

before(async () => {
  fx = buildFixtures();
  fx.resetState();
  srv = await boot(fx.env());
  sess = await loginAs(srv, 'admin', 'long-test-password-1');
  assert.equal(sess.status, 200);
  const r = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' });
  assert.equal(r.status, 200);
});

after(async () => { await srv.close(); });

function rawRequest(host, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(srv.port, '127.0.0.1', () => {
      sock.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString(); });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('no cookie -> 401 on read endpoints', async () => {
  for (const p of ['/api/overview', '/api/scan', '/api/audit']) {
    const r = await fetch(`${srv.base}${p}`);
    assert.equal(r.status, 401, p);
  }
});

test('bad Origin on POST -> 403', async () => {
  const r = await fetch(`${srv.base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', 'X-Panel-CSRF': sess.csrf, Cookie: sess.cookie },
    body: '{}'
  });
  assert.equal(r.status, 403);
});

test('bad Host -> 403', async () => {
  const res = await rawRequest('evil.example', '/api/health');
  assert.match(res, /^HTTP\/1\.1 403/m);
});

test('missing CSRF on POST -> 403', async () => {
  const r = await fetch(`${srv.base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: sess.origin, Cookie: sess.cookie },
    body: '{}'
  });
  assert.equal(r.status, 403);
});

test('redaction masks IBAN/CNIC/phone/token/email/long digits', async () => {
  const { redactText } = require('../lib/redact');
  const s = 'iban PK36SCBL0000001123456702 cnic 35202-1234567-1 phone 03001234567 token=tok_ABC123xyz mail alma@example.com card 4111111111111111';
  const out = redactText(s);
  assert.ok(!out.includes('PK36SCBL'), 'IBAN masked');
  assert.ok(!out.includes('35202-1234567-1'), 'CNIC masked');
  assert.ok(!out.includes('03001234567'), 'phone masked');
  assert.ok(!out.includes('tok_ABC123xyz'), 'token masked');
  assert.ok(!out.includes('alma@example.com'), 'email masked');
  assert.ok(!out.includes('4111111111111111'), 'long digits masked');
});

test('logs_disabled app -> 403; enabled app log tail works', async () => {
  const denied = await fetch(`${srv.base}/api/apps/bank-api/logs`, { headers: { Cookie: sess.cookie } });
  assert.equal(denied.status, 403);
  const ok = await fetch(`${srv.base}/api/apps/web-pwa/logs`, { headers: { Cookie: sess.cookie } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.match(body.text, /ready on port 3000/);
});

test('static UI responses are no-store (no stale app.js mixing)', async () => {
  for (const p of ['/', '/app.js', '/styles.css']) {
    const r = await fetch(`${srv.base}${p}`);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('cache-control') || '', /no-store/, p);
  }
});

test('/api/setup does not exist -> 404', async () => {
  for (const m of ['GET', 'POST']) {
    const r = await fetch(`${srv.base}/api/setup`, { method: m });
    assert.equal(r.status, 404, m);
  }
});

test('PATCH meta updates display fields only', async () => {
  const r = await fetch(`${srv.base}/api/apps/web-pwa/meta`, {
    method: 'PATCH', headers: authed(sess),
    body: JSON.stringify({ display_name: 'Web PWA', category: 'production', notes: 'hi', actions: ['stop'], kind: 'pm2' })
  });
  assert.equal(r.status, 200);
  const sc = await fetch(`${srv.base}/api/scan`, { method: 'POST', headers: authed(sess), body: '{}' }).then((x) => x.json());
  const web = sc.items.find((i) => i.id === 'web-pwa');
  assert.equal(web.display_name, 'Web PWA');
  assert.equal(web.category, 'production');
  assert.deepEqual(web.actions, ['start', 'stop', 'restart'], 'actions not editable via HTTP');
});

test('corrupt policy fails closed: logs blocked, actions off, error surfaced', async () => {
  const path = require('path');
  const policyFile = path.join(fx.dir, 'policy.json');
  const backup = fs.readFileSync(policyFile, 'utf8');
  fs.writeFileSync(policyFile, '{not json');
  try {
    const logs = await fetch(`${srv.base}/api/apps/bank-api/logs`, { headers: { Cookie: sess.cookie } });
    assert.equal(logs.status, 403, 'logs blocked when policy unreadable');
    const r = await fetch(`${srv.base}/api/apps/web-pwa/actions`, {
      method: 'POST', headers: authed(sess), body: JSON.stringify({ action: 'restart', confirm: true })
    });
    assert.equal(r.status, 403, 'actions blocked when policy unreadable');
    const ov = await fetch(`${srv.base}/api/overview`, { headers: { Cookie: sess.cookie } }).then((x) => x.json());
    assert.ok(ov.policy_error, 'policy_error surfaced for the UI banner');
  } finally {
    fs.writeFileSync(policyFile, backup);
  }
  const ov2 = await fetch(`${srv.base}/api/overview`, { headers: { Cookie: sess.cookie } }).then((x) => x.json());
  assert.equal(ov2.policy_error, null, 'error clears once policy is valid again');
});

test('create-admin.js works with piped stdin (no TTY)', async () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const path = require('path');
  const usersFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ca-')), 'users.json');
  const pw = 'create-admin-test-1';
  const r = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'create-admin.js'), 'admin2'], {
    env: { ...process.env, PANEL_USERS: usersFile },
    input: `${pw}\n${pw}\n`,
    encoding: 'utf8'
  });
  assert.equal(r.status, 0, `create-admin exit 0: ${(r.stderr || '').slice(0, 200)}`);
  // NOTE: store uses the config-baked users path, so read the temp file directly.
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const found = users.find((u) => u.username === 'admin2');
  assert.ok(found, 'user persisted');
  const store = require('../lib/store');
  assert.ok(store.verifyPassword(pw, found.password_hash), 'scrypt password verifies');
});
