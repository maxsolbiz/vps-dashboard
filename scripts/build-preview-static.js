'use strict';
// Builds preview-static.html: ONE self-contained, fully offline file that
// double-clicks open in a browser. No server, no node, no build step, no
// network. Real index.html + styles.css + app.js are inlined verbatim, and
// fetch() is stubbed with schema-accurate fixture data captured from the real
// test harness.
//
//   node scripts/build-preview-static.js
//
// Output: preview-static.html (repo root)
const fs = require('fs');
const path = require('path');
const { buildFixtures, boot, loginAs } = require('../test/helpers');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'preview-static.html');

async function capture() {
  const fx = buildFixtures();
  fx.resetState();
  const srv = await boot(fx.env());
  const s = await loginAs(srv, 'admin', 'long-test-password-1');
  const hdr = {
    'Content-Type': 'application/json', Cookie: s.cookie,
    Origin: srv.base, 'X-Panel-CSRF': s.csrf
  };
  const get = async (u) => (await fetch(srv.base + u, { headers: { Cookie: s.cookie } })).json().catch(() => ({}));
  await fetch(srv.base + '/api/scan', { method: 'POST', headers: hdr, body: '{}' });
  const scan = await get('/api/scan');
  if (!(scan.items || []).length) throw new Error('fixture produced no scan items');
  const overview = await get('/api/overview');
  const audit = await get('/api/audit?limit=50');
  await srv.close();
  return { scan, overview, audit };
}

// Inline scripts must not contain a literal </script> or the document ends early.
function safeScript(src) {
  return String(src).replace(/<\/script/gi, '<\\/script');
}

(async () => {
  const mock = await capture();
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

  // Shape system numbers like the real target VPS so layout density is judged
  // at production size. SAMPLE values, for visual review only.
  mock.overview.system = {
    uptime_s: 1584000, load: [0.42, 0.51, 0.48], cpus: 2,
    mem: { source: 'meminfo', total_b: 4294967296, available_b: 1435156480, used_b: 2859810816, use_pct: 66.6, swap_total_b: 0, swap_free_b: 0, swap_used_b: 0 },
    disk: { total_kb: 165139200, used_kb: 129761280, avail_kb: 31111168, use_pct: '82%' }
  };

  // Strip the real favicon link (would 404 on file://) and the external css
  // link (inlined below). Everything else in <head> is preserved.
  let body = html
    .replace(/<link rel="icon"[^>]*>\s*/i, '')
    .replace(/<link rel="stylesheet"[^>]*>\s*/i, '')
    .replace(/<script src="\/app\.js"><\/script>\s*/i, '');

  // The real panel serves app.js/styles.css as separate files under
  // `default-src 'self'`. Here they are INLINED, so 'self' would block them
  // and the preview would render blank. This policy allows inline content while
  // hard-blocking every network path — a stronger guarantee for this artifact:
  // it proves the file works fully offline. (The production CSP is unchanged
  // and still enforced by the server.) Applied to the output head below.

  const state = {
    scan: mock.scan,
    overview: mock.overview,
    audit: mock.audit,
    switchOn: false,
    theme: 'dark'
  };

  const mockScript = `
/* ---- offline mock layer: no network, no node, no server ---- */
window.__PREVIEW__ = ${JSON.stringify(state)};
(function () {
  var S = window.__PREVIEW__;
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function scanWithActions() {
    var s = clone(S.scan);
    s.cached = false;
    s.items.forEach(function (it) {
      if (S.switchOn) {
        it.actions = (it.kind === 'pm2' && it.id !== 'vps-control-panel')
          ? ['start', 'stop', 'restart'] : [];
      } else {
        it.actions = [];
      }
    });
    return s;
  }
  function json(body, status) {
    status = status || 200;
    return Promise.resolve({
      ok: status < 400, status: status,
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(JSON.stringify(body)); }
    });
  }
  var auditLog = [];
  window.fetch = function (url, opts) {
    var u = String(url);
    opts = opts || {};
    var body = {};
    if (opts.body) { try { body = JSON.parse(opts.body); } catch (e) { /* ignore */ } }
    if (u.indexOf('/api/me') === 0) {
      return json({ user: { username: 'admin', role: 'admin' }, csrf: 'preview', actions_enabled: S.switchOn });
    }
    if (u.indexOf('/api/health') === 0) {
      return json({ ok: true, time: new Date().toISOString(), actions_enabled: S.switchOn });
    }
    if (u.indexOf('/api/scan') === 0) return json(scanWithActions());
    if (u.indexOf('/api/overview') === 0) return json(clone(S.overview));
    if (u.indexOf('/api/audit') === 0) {
      return json({ entries: auditLog.length ? auditLog : clone(S.audit.entries || []) });
    }
    if (u.indexOf('/api/policy/actions-enabled') === 0) {
      if (body.enabled === true && body.confirm_word !== 'ENABLE') {
        return json({ error: 'type ENABLE to confirm enabling actions' }, 400);
      }
      S.switchOn = !!body.enabled;
      auditLog.unshift({
        t: new Date().toISOString(), user: 'admin', app: 'policy',
        action: 'policy-toggle', result: 'ok',
        error: 'actions_enabled=' + body.enabled, ip: '127.0.0.1'
      });
      return json({ ok: true, actions_enabled: S.switchOn });
    }
    if (u.indexOf('/api/auth/login') === 0) {
      return json({ ok: true, username: 'admin', role: 'admin', csrf: 'preview' });
    }
    if (u.indexOf('/api/auth/logout') === 0) return json({ ok: true });
    if (u.indexOf('/api/auth/change-password') === 0) {
      return json({ error: 'preview build: password changes are disabled' }, 400);
    }
    if (u.indexOf('/logs') > -1) {
      var t = new Date().toISOString();
      return json({ text: [
        '[' + t + '] INFO  server listening on :3002',
        '[' + t + '] INFO  GET /api/health 200 1.2ms',
        '[' + t + '] WARN  slow query 842ms SELECT * FROM invoices WHERE status = $1',
        '[' + t + '] INFO  scheduled job finished in 214ms',
        '[' + t + '] INFO  pm2 restart requested by panel'
      ].join('\\n') });
    }
    if (u.indexOf('/actions') > -1) {
      return json({
        ok: true, action: body.action || 'restart', app: 'web-pwa',
        status: 'running', pid: 1234, verified: true, port_bound: true,
        waited_ms: 342, port_released: true
      });
    }
    if (u.indexOf('/api/') === 0) return json({});
    return json({});
  };
  // The panel calls /favicon.ico; make it a harmless no-op offline.
  var realFetch = window.fetch;
  window.fetch = function (u, o) {
    if (String(u).indexOf('/favicon.ico') > -1) return Promise.resolve({ ok: true, status: 204, json: function () { return Promise.resolve({}); } });
    return realFetch(u, o);
  };
})();
`;

  const toolbar = `
<!-- preview-only controls: not part of the panel -->
<div id="pv-bar">
  <span class="pv-tag">PREVIEW</span>
  <span class="pv-lbl">actions</span>
  <button type="button" class="pv-b on" data-pv="switch" data-val="0">OFF</button>
  <button type="button" class="pv-b" data-pv="switch" data-val="1">ON</button>
  <span class="pv-sep"></span>
  <span class="pv-lbl">theme</span>
  <button type="button" class="pv-b on" data-pv="theme" data-val="dark">dark</button>
  <button type="button" class="pv-b" data-pv="theme" data-val="light">light</button>
  <span class="pv-sep"></span>
  <span class="pv-lbl">width</span>
  <button type="button" class="pv-b" data-pv="w" data-val="390">390</button>
  <button type="button" class="pv-b" data-pv="w" data-val="768">768</button>
  <button type="button" class="pv-b" data-pv="w" data-val="1440">1440</button>
</div>
<style>
#pv-bar {
  position: fixed; z-index: 999; left: 50%; transform: translateX(-50%);
  bottom: 10px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 6px 10px; border-radius: 999px;
  background: rgba(10,14,20,.94); border: 1px solid #33404f;
  box-shadow: 0 8px 28px rgba(0,0,0,.5); font: 500 12px/1.4 system-ui, sans-serif;
  color: #8b98a9; max-width: calc(100vw - 16px);
}
.pv-tag { font-weight: 700; letter-spacing: .1em; color: #58a6ff; }
.pv-lbl { text-transform: uppercase; letter-spacing: .08em; font-size: 10px; }
.pv-sep { width: 1px; height: 16px; background: #33404f; }
.pv-b {
  appearance: none; border: 1px solid #33404f; background: transparent;
  color: #8b98a9; border-radius: 999px; padding: 4px 10px; min-height: 26px;
  font: 500 12px/1 system-ui, sans-serif; cursor: pointer; margin: 0;
}
.pv-b:hover { background: rgba(139,152,169,.14); }
.pv-b.on { background: #1f6feb; border-color: #1f6feb; color: #fff; }
#pv-frame { margin: 0 auto; border: 0; display: block; background: #0d1117; }
body.pv-framed { display: flex; justify-content: center; }
body.pv-framed #pv-frame { width: 100%; height: calc(100vh - 44px); border-left: 1px solid #33404f; border-right: 1px solid #33404f; }
</style>
`;

  // Wrap the panel markup in an iframe when a fixed width is chosen, so the
  // reviewer can check responsive behaviour without a device toolbar.
  const toolbarScript = `
(function () {
  var S = window.__PREVIEW__;
  function mark(btn) {
    var p = btn.parentNode;
    p.querySelectorAll('.pv-b').forEach(function (b) { b.classList.remove('on'); });
    btn.classList.add('on');
  }
  document.getElementById('pv-bar').addEventListener('click', function (e) {
    var b = e.target.closest('.pv-b');
    if (!b) return;
    var kind = b.dataset.pv, val = b.dataset.val;
    if (kind === 'switch') {
      S.switchOn = val === '1';
      mark(b);
      // Re-render exactly as the panel does after a real toggle.
      document.getElementById('actions-toggle').checked = S.switchOn;
      var t = document.getElementById('scan-btn');
      if (t) t.click();
    } else if (kind === 'theme') {
      S.theme = val;
      document.documentElement.setAttribute('data-theme', val);
      mark(b);
    } else if (kind === 'w') {
      mark(b);
      var w = parseInt(val, 10);
      var f = document.getElementById('pv-frame');
      if (w >= 1440) { document.body.classList.remove('pv-framed'); if (f) f.remove(); }
      else {
        if (!f) {
          f = document.createElement('iframe');
          f.id = 'pv-frame';
          f.setAttribute('title', 'panel preview');
          var html = document.documentElement.outerHTML;
          f.srcdoc = html;
          document.body.appendChild(f);
          document.body.classList.add('pv-framed');
        }
        f.style.width = w + 'px';
      }
    }
  });
})();
`;

  const out = [
    '<!DOCTYPE html>',
    '<html lang="en" data-theme="dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>MAXSOLBIZ / VPS Control — static preview</title>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'unsafe-inline\' data:; connect-src \'none\'; img-src data:; form-action \'none\'; base-uri \'none\'">',
    '<style>', css, '</style>',
    '</head>',
    '<body>',
    body.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, ''),
    '<script>', safeScript(mockScript), '</script>',
    '<script>', safeScript(app), '</script>',
    toolbar,
    '<script>', safeScript(toolbarScript), '</script>',
    '</body>',
    '</html>',
    ''
  ].join('\n');

  fs.writeFileSync(OUT, out);
  const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
  console.log(`wrote ${OUT}`);
  console.log(`  ${kb} KB, ${out.split('\n').length} lines`);
  console.log(`  baked data: ${mock.scan.items.length} scan items, ${(mock.audit.entries || []).length} audit entries`);
  console.log('  open it directly — no server, no network');
})().catch((e) => { console.error('build failed:', e.message); process.exit(1); });
