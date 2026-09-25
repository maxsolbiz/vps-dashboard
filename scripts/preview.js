'use strict';
// Local UI preview server. Serves the REAL public/ files (not a mock-up) with
// API responses captured from the actual test harness, so the preview is
// schema-accurate. Never touches the VPS.
//
//   node scripts/preview.js
//   open http://127.0.0.1:8788
//
// Query flags:  ?switch=1   -> actions ENABLED (live buttons)
//               ?theme=light
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildFixtures, boot, loginAs } = require('../test/helpers');

const PORT = Number(process.env.PREVIEW_PORT || 8788);
const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon' };

let MOCK = null;

async function capture() {
  const fx = buildFixtures();
  fx.resetState();
  const srv = await boot(fx.env());
  const s = await loginAs(srv, 'admin', 'long-test-password-1');
  const hdr = { 'Content-Type': 'application/json', ...s.headers ? s.headers : {}, Cookie: s.cookie, Origin: srv.base, 'X-Panel-CSRF': s.csrf };
  const get = async (u) => {
    const r = await fetch(srv.base + u, { headers: { Cookie: s.cookie } });
    return r.json().catch(() => ({}));
  };
  // A fresh fixture has no saved scan; run one so the preview has real items.
  await fetch(srv.base + '/api/scan', { method: 'POST', headers: hdr, body: '{}' });
  MOCK = {
    scan: await get('/api/scan'),
    overview: await get('/api/overview'),
    audit: await get('/api/audit?limit=50')
  };
  if (!(MOCK.scan.items || []).length) {
    throw new Error('preview captured an empty scan — fixture produced no items');
  }
  // A scan item's logs, shaped like the real endpoint.
  const firstPm2 = (MOCK.scan.items || []).find((i) => i.kind === 'pm2') || { ports: [] };
  const firstPort = (firstPm2.ports || [])[0] || {};
  MOCK.logs = {
    text: [
      `[${new Date().toISOString()}] INFO  server listening on :${firstPort.port || 3000}`,
      `[${new Date().toISOString()}] INFO  GET /api/health 200 1.2ms`,
      `[${new Date().toISOString()}] WARN  slow query 842ms SELECT * FROM invoices WHERE status = $1`,
      `[${new Date().toISOString()}] INFO  scheduled job finished in 214ms`
    ].join('\n')
  };
  await srv.close();
  return MOCK;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const q = url.searchParams;
  const enabled = q.get('switch') === '1';

  if (p.startsWith('/api/')) {
    if (p === '/api/me') return send(res, 200, { user: { username: 'admin', role: 'admin' }, csrf: 'preview', actions_enabled: enabled });
    if (p === '/api/health') return send(res, 200, { ok: true, time: new Date().toISOString(), actions_enabled: enabled });
    if (p === '/api/scan') {
      const s = JSON.parse(JSON.stringify(MOCK.scan));
      s.cached = false;
      if (enabled) {
        for (const it of s.items || []) {
          if (it.kind === 'pm2' && it.id !== 'vps-control-panel') it.actions = ['start', 'stop', 'restart'];
        }
      } else {
        for (const it of s.items || []) it.actions = [];
      }
      return send(res, 200, s);
    }
    if (p === '/api/overview') {
      const o = JSON.parse(JSON.stringify(MOCK.overview));
      // Shape the numbers like the real target VPS (2 cores / 4 GB / 160 GB)
      // so layout density is judged at production size, not at whatever host
      // happens to run the preview. These are SAMPLE values for layout only.
      o.system = {
        uptime_s: 1584000, load: [0.42, 0.51, 0.48], cpus: 2,
        mem: { source: 'meminfo', total_b: 4294967296, available_b: 1435156480, used_b: 2859810816, use_pct: 66.6, swap_total_b: 0, swap_free_b: 0, swap_used_b: 0 },
        disk: { total_kb: 165139200, used_kb: 129761280, avail_kb: 31111168, use_pct: '82%' }
      };
      return send(res, 200, o);
    }
    if (p === '/api/audit') return send(res, 200, MOCK.audit);
    if (p.includes('/logs')) return send(res, 200, MOCK.logs);
    if (p.includes('/actions')) return send(res, 200, { ok: true, action: 'restart', app: 'demo', status: 'running', pid: 1234, verified: true, port_bound: true, waited_ms: 342 });
    return send(res, 200, {});
  }

  // static, from the real public/ directory
  const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
  const full = path.join(PUB, file);
  if (!full.startsWith(PUB) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: 'not found' });
  const ext = path.extname(full);
  const theme = q.get('theme');
  let body = fs.readFileSync(full);
  if (ext === '.html' && theme) body = Buffer.from(String(body).replace('data-theme="dark"', `data-theme="${theme}"`));
  return send(res, 200, body, MIME[ext] || 'application/octet-stream');
});

capture().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`preview  http://127.0.0.1:${PORT}`);
    console.log(`  with live buttons:  http://127.0.0.1:${PORT}/?switch=1`);
    console.log(`  light theme:        http://127.0.0.1:${PORT}/?theme=light`);
    console.log('  (serves the real public/ files; nothing is deployed)');
  });
}).catch((e) => { console.error('preview failed:', e.message); process.exit(1); });
