'use strict';
// Tarball pack + verify (local only):
//   node scripts/pack.js
// Builds vps-panel.tar.gz with exactly the ship list, extracts it to a temp
// dir, runs `node --check server.js`, boots it against generated fixtures,
// and hits /api/health. Fails loudly on anything missing.
// Never ships: dev-fixtures, tests, users.json, audit.jsonl, last-scan.json.
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'vps-panel.tar.gz');

const SHIP = [
  'server.js', 'lib', 'public', 'scripts', 'ecosystem.config.js',
  'package.json', 'package-lock.json',
  'data/policy.default.json', 'data/overrides.default.json',
  'node_modules'
];
const EXCLUDES = [
  '--exclude=scripts/dev-fixtures.js',
  '--exclude=scripts/render-probe.js',
  '--exclude=test', '--exclude=*/test', '--exclude=*/tests',
  '--exclude=.claude', '--exclude=*/.claude*',
  '--exclude=*/benchmark*',
  '--exclude=*.test.js',
  '--exclude=users.json', '--exclude=audit.jsonl*', '--exclude=last-scan.json'
];
const BANNED = [/dev-fixtures/, /render-probe/, /(^|\/)test(\/|$)/, /\.claude/, /users\.json/, /audit\.jsonl/, /last-scan\.json/];

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`failed: ${cmd} ${args.join(' ')}`);
}

function listTarball(tar) {
  const out = execFileSync('tar', ['-tzf', tar], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function waitHealth(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return r.json();
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('extracted panel never became healthy');
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    throw new Error('run `npm ci --omit=dev` first');
  }
  try { fs.unlinkSync(OUT); } catch (_) {}
  sh('tar', ['-czf', OUT, ...EXCLUDES, ...SHIP], { cwd: ROOT });
  console.log(`built ${OUT} (${fs.statSync(OUT).size} bytes)`);

  const names = listTarball(OUT);
  const banned = names.filter((n) => BANNED.some((re) => re.test(n)));
  if (banned.length) throw new Error(`tarball contains banned entries:\n${banned.slice(0, 10).join('\n')}`);
  for (const need of ['server.js', 'lib/scan.js', 'lib/cpusampler.js', 'public/app.js', 'scripts/create-admin.js', 'data/policy.default.json', 'data/overrides.default.json', 'node_modules/fastify/fastify.js']) {
    if (!names.some((n) => n === need || n === `./${need}`)) throw new Error(`tarball missing: ${need}`);
  }
  for (const live of ['data/policy.json', 'data/overrides.json']) {
    if (names.some((n) => n === live || n === `./${live}`)) throw new Error(`tarball must not ship live file: ${live}`);
  }
  console.log(`tarball contents ok (${names.length} entries, no banned files)`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-pack-'));
  sh('tar', ['-xzf', OUT, '-C', tmp]);
  const dir = path.join(tmp, fs.readdirSync(tmp).find((n) => n !== '.' && n !== '..' && fs.statSync(path.join(tmp, n)).isDirectory()) || '.');
  const root = fs.existsSync(path.join(dir, 'server.js')) ? dir : tmp;
  sh('node', ['--check', 'server.js'], { cwd: root });
  console.log('node --check server.js ok');

  // Boot the EXTRACTED copy against fixtures.
  const { buildFixtures } = require('../test/helpers');
  const fx = buildFixtures();
  fx.resetState();
  const port = 18989;
  const base = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...fx.env(), PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1',
    ACTIONS_ENABLED: 'false', PANEL_SAMPLER: '0'
  };
  const child = spawn('node', ['server.js'], { cwd: root, env: childEnv, stdio: 'ignore' });
  try {
    const health = await waitHealth(base);
    if (health.actions_enabled !== false) throw new Error('expected read-only boot');
    console.log(`extracted panel booted read-only ok: ${JSON.stringify(health)}`);

    // create-admin with piped stdin (no TTY here), then login + scan.
    const pw = 'pack-test-password-1';
    const ca = spawnSync('node', ['scripts/create-admin.js', 'admin'], {
      cwd: root, env: childEnv, input: `${pw}\n${pw}\n`, encoding: 'utf8'
    });
    if (ca.status !== 0) throw new Error(`create-admin failed: ${(ca.stderr || '').slice(0, 300)}`);
    console.log('create-admin ok (piped stdin)');
    const me = await (await fetch(`${base}/api/me`)).json();
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Panel-CSRF': me.csrf },
      body: JSON.stringify({ username: 'admin', password: pw })
    });
    if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
    const loginBody = await login.json();
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) throw new Error('no session cookie');
    console.log('login ok');
    const scan = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Panel-CSRF': loginBody.csrf, Cookie: cookie },
      body: '{}'
    });
    if (scan.status !== 200) throw new Error(`scan failed: ${scan.status}`);
    const scanned = await scan.json();
    if (!Array.isArray(scanned.items) || scanned.items.length < 5) {
      throw new Error(`scan returned too few items: ${(scanned.items || []).length}`);
    }
    console.log(`scan ok: ${scanned.items.length} items`);
  } finally {
    child.kill();
  }
  console.log('PACK OK');
}

if (require.main === module) {
  main().catch((err) => { console.error(`PACK FAILED: ${err.message}`); process.exit(1); });
}
