'use strict';
// Renders the real app.js against the real index.html in a minimal DOM to
// prove every view populates without a runtime error. This is the closest
// automated stand-in for a screenshot: it exercises the same code paths the
// browser would and fails loudly on the errors a blank section would hide.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// Build a DOM stub from the real ids/classes present in index.html.
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const cells = new Map();
function el(id) {
  if (!cells.has(id)) {
    const node = {
      id, innerHTML: '', value: '', checked: false, disabled: false,
      dataset: {}, style: {}, className: '', _attrs: {},
      setAttribute(k, v) { node._attrs[k] = String(v); },
      getAttribute(k) { return k in node._attrs ? node._attrs[k] : null; },
      removeAttribute(k) { delete node._attrs[k]; },
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, on) { const want = on === undefined ? !this._s.has(c) : !!on; if (want) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, focus() {}, click() {},
      querySelectorAll: () => [], querySelector: () => el(`${id}>q`)
    };
    // A real DOM coerces textContent to a string; mirror that so assertions
    // match browser behaviour instead of stub behaviour.
    let _text = '';
    Object.defineProperty(node, 'textContent', {
      get() { return _text; },
      set(v) { _text = v == null ? '' : String(v); },
      enumerable: true
    });
    cells.set(id, node);
  }
  return cells.get(id);
}
const tbody = (tableId) => {
  const t = el(tableId);
  if (!t._tbody) { t._tbody = { ...el(`${tableId}-tbody`), innerHTML: '' }; }
  return t._tbody;
};
global.document = {
  hidden: false,
  activeElement: null,
  documentElement: { getAttribute: () => 'dark', setAttribute() {} },
  body: el('body'),
  getElementById: (id) => el(id),
  createElement: () => el(`new-${Math.random()}`),
  querySelector: (sel) => {
    if (sel.endsWith('tbody')) return tbody(sel.replace(' tbody', '').replace('#', ''));
    return el(sel);
  },
  querySelectorAll: () => [],
  addEventListener() {}
};
global.window = { addEventListener() {}, scrollTo() {} };
global.localStorage = { getItem: () => null, setItem() {} };
global.location = { hash: '' };
global.history = { replaceState() {} };
global.setInterval = () => 0;
global.setTimeout = () => 0;

const SCAN = {
  scanned_at: new Date().toISOString(), complete: true, cached: false,
  counts: { running: 4, stopped: 2, errored: 0, unmanaged: 1, public_binds: 1 },
  diff: { new: [], gone: [] },
  drift: { running_not_in_dump: [], in_dump_not_running: [] },
  items: [
    { kind: 'pm2', id: 'web-pwa', name: 'web-pwa', display_name: 'Web PWA', status: 'running', category: 'production', pids: [100], cpu_pct: 12.5, rss_b: 268435456, uptime_s: 864000, ports: [{ port: 3000, bind: '0.0.0.0', public: true }], domains: ['happ.maxsolbiz.com'], restarts: 12, actions: ['start', 'stop', 'restart'], logs_enabled: true, indirect: true, start_blocked: false, holder_pid: null, exec_path: '/usr/bin/npm', cwd: '/root/web', notes: '' },
    { kind: 'pm2', id: 'bank-api', name: 'bank-api', display_name: 'Banking API', status: 'running', category: 'production', pids: [300], cpu_pct: 4.2, rss_b: 536870912, uptime_s: 432000, ports: [{ port: 5000, bind: '127.0.0.1', public: false }], domains: [], restarts: 1, actions: ['start', 'stop', 'restart'], logs_enabled: true, indirect: false, start_blocked: false, holder_pid: null, exec_path: '/root/bank/dist/server.js', cwd: '/root/bank', notes: '' },
    { kind: 'pm2', id: 'staging-web', name: 'staging-web', display_name: 'Staging Web', status: 'stopped', category: 'test', pids: [], cpu_pct: 0, rss_b: 0, uptime_s: 0, ports: [{ port: 4100, bind: '127.0.0.1', public: false }], domains: ['staging.maxsolbiz.com'], restarts: 41, actions: ['start', 'stop', 'restart'], logs_enabled: true, indirect: false, start_blocked: false, holder_pid: null, exec_path: '/root/staging/index.js', cwd: '/root/staging', notes: '' },
    { kind: 'pm2', id: 'vps-control-panel', name: 'vps-control-panel', status: 'running', category: 'utility', pids: [500], cpu_pct: 0.2, rss_b: 26214400, uptime_s: 3600, ports: [{ port: 8787, bind: '127.0.0.1', public: false }], domains: ['vps.maxsolbiz.com'], restarts: 0, actions: [], logs_enabled: true, indirect: false, start_blocked: false, holder_pid: null, exec_path: '/root/vps-dashboard/server.js', cwd: '/root/vps-dashboard', notes: '' },
    { kind: 'website', id: 'site-task-rewards', name: 'site-task-rewards', status: 'running', category: 'production', domains: ['task-rewards.com'], cwd: '/var/www/task-rewards', ports: [] },
    { kind: 'unmanaged', id: 'stray-node', name: 'stray-node', status: 'unmanaged-running', category: 'unclassified', pids: [900], cpu_pct: 1.1, rss_b: 52428800, uptime_s: 7200, ports: [], notes: 'not under pm2' },
    { kind: 'infra', id: 'apache2', name: 'apache2', status: 'active', category: 'utility', notes: 'systemctl is-active: active' }
  ]
};
const OVERVIEW = {
  at: new Date().toISOString(), pm2_available: true, policy_error: null,
  system: {
    uptime_s: 1584000, load: [0.42, 0.51, 0.48], cpus: 2,
    mem: { source: 'meminfo', total_b: 4294967296, available_b: 2149580800, used_b: 2145386496, use_pct: 50, swap_total_b: 0, swap_free_b: 0, swap_used_b: 0 },
    disk: { total_kb: 41943040, used_kb: 32808960, avail_kb: 8227840, use_pct: '79%' }
  },
  apps: [
    { name: 'web-pwa', status: 'running', pid: 100, pids: [100, 101, 102], cpu_pct: 12.5, rss_b: 268435456, uptime_s: 864000, category: 'production' },
    { name: 'bank-api', status: 'running', pid: 300, pids: [300], cpu_pct: 4.2, rss_b: 536870912, uptime_s: 432000, category: 'production' },
    { name: 'staging-web', status: 'stopped', pid: 0, pids: [], cpu_pct: 0, rss_b: 0, uptime_s: 0, category: 'test' }
  ]
};
const AUDIT = {
  entries: [
    { t: new Date().toISOString(), user: 'admin', app: 'web-pwa', action: 'restart', result: 'ok', error: null, ip: '92.97.188.58' },
    { t: new Date().toISOString(), user: 'admin', app: 'policy', action: 'policy-toggle', result: 'ok', error: 'actions_enabled=false', ip: '92.97.188.58' }
  ]
};

global.fetch = async (url) => {
  const u = String(url);
  const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.startsWith('/api/me')) return json({ user: { username: 'admin', role: 'admin' }, csrf: 't', actions_enabled: true });
  if (u.startsWith('/api/scan')) return json(SCAN);
  if (u.startsWith('/api/overview')) return json(OVERVIEW);
  if (u.startsWith('/api/audit')) return json(AUDIT);
  if (u.includes('/logs')) return json({ text: 'log line one\nlog line two' });
  return json({});
};

test('every view renders real content with no runtime error', async () => {
  const mod = require(path.join(root, 'public', 'app.js'));
  mod.state.csrf = 't';
  mod.state.me = { username: 'admin', role: 'admin' };
  mod.state.overview = OVERVIEW;
  mod.state.scan = SCAN;
  mod.state.diff = SCAN.diff;
  mod.state.pending = new Set();

  assert.doesNotThrow(() => mod.renderScan(SCAN), 'renderScan');
  assert.doesNotThrow(() => mod.renderHealth(OVERVIEW), 'renderHealth');
  assert.doesNotThrow(() => mod.renderServerCard(OVERVIEW), 'renderServerCard');
  assert.doesNotThrow(() => mod.renderProcesses(OVERVIEW), 'renderProcesses');
  assert.doesNotThrow(() => mod.renderPorts(SCAN), 'renderPorts');
  assert.doesNotThrow(() => mod.renderAlerts(OVERVIEW, SCAN), 'renderAlerts');
  assert.doesNotThrow(() => mod.renderPolicyInfo({ actions_enabled: true, user: { username: 'admin' } }), 'renderPolicyInfo');
  // Two samples so the sparkline has something real to draw.
  assert.doesNotThrow(() => mod.pushTrend(OVERVIEW), 'pushTrend 1');
  assert.doesNotThrow(() => mod.pushTrend(OVERVIEW), 'pushTrend 2');

  const filled = (id) => (el(id).innerHTML || '').trim().length;
  assert.ok(filled('health-metrics') > 0, 'health metrics rendered');
  assert.ok(filled('server') > 0, 'server detail rendered');
  assert.ok(filled('top-cpu') > 0, 'CPU hotspot list rendered');
  assert.ok(filled('top-ram') > 0, 'RAM hotspot list rendered');
  assert.ok(filled('alerts') > 0, 'attention panel rendered');
  assert.ok(filled('chips') > 0, 'summary chips rendered');
  assert.ok(filled('apps-pm2-cards') > 0, 'mobile app cards rendered');
  assert.ok(el('val-cpu').textContent, 'CPU trend value set');
  assert.ok(el('server-quick').textContent, 'header server pill updated');
  assert.equal(el('nav-count-apps').textContent, '4', 'nav app count set');
  assert.equal(el('nav-count-ports').textContent, '4', 'nav port count set (3000, 5000, 4100, 8787)');
});

test('the panel app is rendered with no action buttons even when actions are on', () => {
  const rows = tbody('apps-pm2').innerHTML;
  assert.ok(rows.includes('vps-control-panel'), 'panel appears in the list');
  const panelRow = rows.split('</tr>').find((r) => r.includes('vps-control-panel'));
  assert.ok(panelRow, 'panel row found');
  assert.doesNotMatch(panelRow, /data-act="(start|stop|restart)"/, 'panel must have no action buttons');
  assert.match(panelRow, /not enabled in policy/, 'panel shows the disabled reason');
});

test('apps with no allowed actions render three disabled buttons, not a blank cell', () => {
  const noActions = { ...SCAN, items: SCAN.items.map((i) => (i.id === 'bank-api' ? { ...i, actions: [] } : i)) };
  const mod = require(path.join(root, 'public', 'app.js'));
  mod.renderScan(noActions);
  const rows = tbody('apps-pm2').innerHTML;
  const bankRow = rows.split('</tr>').find((r) => r.includes('bank-api'));
  assert.ok(bankRow, 'bank row present');
  assert.match(bankRow, /not enabled in policy/, 'shows the policy reason');
  assert.equal((bankRow.match(/<button disabled/g) || []).length, 3, 'exactly three disabled buttons');
  assert.doesNotMatch(bankRow, /data-act="(start|stop|restart)"/, 'none are clickable');
});

test('an allow-listed app renders live buttons with no policy message', () => {
  const mod = require(path.join(root, 'public', 'app.js'));
  mod.renderScan(SCAN);
  const rows = tbody('apps-pm2').innerHTML;
  const webRow = rows.split('</tr>').find((r) => r.includes('web-pwa'));
  assert.match(webRow, /data-act="restart"/, 'restart is clickable');
  assert.doesNotMatch(webRow, /not enabled in policy/, 'no policy warning when allowed');
});

test('status is rendered with a glyph and a word, never colour alone', () => {
  const mod = require(path.join(root, 'public', 'app.js'));
  mod.renderScan(SCAN);
  const rows = tbody('apps-pm2').innerHTML;
  const bankRow = rows.split('</tr>').find((r) => r.includes('bank-api'));
  assert.match(bankRow, /class="status running"/, 'status class applied');
  assert.match(bankRow, /aria-hidden="true">●<\/span>/, 'glyph present');
  assert.match(bankRow, /running/, 'text label present');
  const stopped = rows.split('</tr>').find((r) => r.includes('staging-web'));
  assert.match(stopped, /○/, 'stopped uses a distinct glyph, not just a dimmer colour');
});

test('the drawer opens, closes, and reports its state accessibly', () => {
  const mod = require(path.join(root, 'public', 'app.js'));
  const btn = el('nav-toggle');
  const back = el('nav-backdrop');
  // mobile drawer on, desktop sidebar off
  global.window.innerWidth = 390;
  global.window.matchMedia = (q) => ({ matches: /860px/.test(q), media: q, addEventListener() {}, addListener() {} });

  mod.setNav(true);
  assert.ok(global.document.body.classList.contains('nav-open'), 'body gets nav-open');
  assert.equal(back.classList.contains('hidden'), false, 'backdrop shown');
  assert.equal(back.getAttribute('aria-hidden'), 'false', 'backdrop exposed to AT');
  assert.equal(btn.getAttribute('aria-expanded'), 'true', 'button reports expanded');
  assert.match(btn.getAttribute('aria-label'), /Close/i, 'label flips to Close');

  mod.setNav(false);
  assert.equal(global.document.body.classList.contains('nav-open'), false, 'body class cleared');
  assert.equal(back.classList.contains('hidden'), true, 'backdrop hidden again');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'button reports collapsed');
  assert.match(btn.getAttribute('aria-label'), /Open/i, 'label flips back to Open');
});

test('setNav is idempotent and closeNav only acts when open', () => {
  const mod = require(path.join(root, 'public', 'app.js'));
  global.window.matchMedia = (q) => ({ matches: /860px/.test(q), media: q, addEventListener() {}, addListener() {} });
  mod.setNav(false);
  assert.doesNotThrow(() => mod.closeNav(), 'closeNav when already closed is safe');
  mod.setNav(true);
  assert.doesNotThrow(() => mod.closeNav(), 'closeNav when open works');
  assert.equal(global.document.body.classList.contains('nav-open'), false);
});

test('the switch label adapts to the viewport without losing meaning', () => {
  const m = require(path.join(root, 'public', 'app.js'));
  global.window.matchMedia = (q) => ({ matches: /860px/.test(q), media: q, addEventListener() {}, addListener() {} });
  assert.equal(m.switchLabel(true), 'ON', 'mobile: enabled reads ON');
  assert.equal(m.switchLabel(false), 'off', 'mobile: disabled reads off');
  global.window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, addListener() {} });
  assert.equal(m.switchLabel(true), 'actions ENABLED', 'desktop: full enabled label');
  assert.equal(m.switchLabel(false), 'actions disabled', 'desktop: full disabled label');
});

test('mobile card action buttons are wired, not just the desktop table', () => {
  // Regression: #apps-pm2 (table) and #apps-pm2-cards (mobile cards) are
  // SIBLINGS. Only the table was queried for buttons, so below 640px — where
  // the table is display:none and the cards are shown — Stop/Restart did
  // nothing on mobile while working perfectly on desktop.
  const mod = require(path.join(root, 'public', 'app.js'));
  const attached = [];
  const mkBtn = (id, act) => ({
    dataset: { id, act },
    addEventListener: (ev, fn) => attached.push({ id, act, ev, fn })
  });
  // table buttons
  tbody('apps-pm2').innerHTML = '';
  const cards = el('apps-pm2-cards');
  cards.innerHTML = '';
  // simulate both containers having buttons
  global.document.querySelectorAll = (sel) => {
    if (sel === '#apps-pm2 button') return [mkBtn('table-app', 'restart')];
    if (sel === '#apps-pm2-cards button') return [mkBtn('card-app', 'stop'), mkBtn('card-app2', 'restart')];
    return [];
  };
  mod.renderScan(SCAN);

  const acts = attached.map((a) => `${a.id}:${a.act}`);
  assert.ok(acts.includes('table-app:restart'), 'table buttons still wired');
  assert.ok(acts.includes('card-app:stop'), 'CARD stop button is wired');
  assert.ok(acts.includes('card-app2:restart'), 'CARD restart button is wired');
  assert.ok(attached.every((a) => a.ev === 'click'), 'all use the click event');
  // and invoking a card handler must reach onAppButton without throwing
  const stopBtn = attached.find((a) => a.act === 'stop');
  assert.doesNotThrow(() => {
    const r = stopBtn.fn();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }, 'clicking a mobile Stop must not throw');
});

test('non-action buttons (Logs) are not double-wired as app actions', () => {
  const mod = require(path.join(root, 'public', 'app.js'));
  const attached = [];
  global.document.querySelectorAll = (sel) => (sel === '#apps-pm2 button'
    ? [{ dataset: { id: 'x', act: 'restart' }, addEventListener: (e, f) => attached.push(e) }] : []);
  mod.renderScan(SCAN);
  assert.equal(attached.length, 1, 'exactly one handler per button');
});

test('long names and empty collections degrade gracefully', () => {
  const mod = require(path.join(root, 'public', 'app.js'));
  const longName = 'a'.repeat(120);
  const odd = { ...SCAN, items: [{ ...SCAN.items[0], id: longName, name: longName, display_name: longName, ports: [], domains: [longName], rss_b: 0, cpu_pct: null, uptime_s: 0, restarts: null }] };
  assert.doesNotThrow(() => mod.renderScan(odd), 'long names must not throw');
  assert.doesNotThrow(() => mod.renderPorts(odd), 'portless apps must not throw');
  assert.doesNotThrow(() => mod.renderProcesses({ apps: [] }), 'no processes must not throw');
  assert.doesNotThrow(() => mod.renderAlerts({ system: null }, { items: [] }), 'no system data must not throw');
  assert.doesNotThrow(() => mod.renderHealth({}), 'empty overview must not throw');
  assert.doesNotThrow(() => mod.renderHealth(null), 'null overview must not throw');
  assert.doesNotThrow(() => mod.renderServerCard(null), 'null server card must not throw');
});
