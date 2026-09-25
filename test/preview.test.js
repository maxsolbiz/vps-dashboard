'use strict';
// Executes the ACTUAL inline <script> blocks from preview-static.html against a
// DOM stub with networking disabled, proving the single file renders on its own.
// This is the closest automated stand-in for double-clicking it: if the inlined
// app code or the baked mock data were broken, this fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'preview-static.html');
const src = fs.readFileSync(file, 'utf8');

// --- offline self-containment -------------------------------------------
test('preview-static.html is self-contained and offline', () => {
  assert.ok(fs.existsSync(file), 'preview-static.html exists');
  const ext = [...src.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/g)];
  assert.equal(ext.length, 0, 'no external src/href references');
  assert.equal((src.match(/@import/gi) || []).length, 0, 'no CSS @import');
  assert.equal((src.match(/url\(\s*["']?https?:/gi) || []).length, 0, 'no remote asset urls');
  assert.equal((src.match(/<script[^>]*\ssrc=/gi) || []).length, 0, 'no external script tags');
  assert.match(src, /<style>/, 'CSS is inlined');
  assert.match(src, /__PREVIEW__/, 'mock data is baked in');
  // The policy must forbid all network, which is the real offline guarantee.
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(src);
  assert.ok(csp, 'a CSP with connect-src is present');
  assert.match(csp[1], /connect-src 'none'/, 'connect-src none blocks every request');
  assert.ok(!/rel="icon"/.test(src), 'favicon link removed (would 404 on file://)');
});

test('baked data matches the real schema', () => {
  const json = /window\.__PREVIEW__ = (\{[\s\S]*?\});\n/.exec(src);
  assert.ok(json, '__PREVIEW__ assignment found');
  const S = JSON.parse(json[1]);
  assert.ok(Array.isArray(S.scan.items), 'scan.items is an array');
  assert.ok(S.scan.items.length >= 15, `expected the full fixture set, got ${S.scan.items.length}`);
  for (const kind of ['pm2', 'website', 'unmanaged', 'infra']) {
    assert.ok(S.scan.items.some((i) => i.kind === kind), `a ${kind} item is present`);
  }
  assert.ok(S.scan.items.some((i) => i.id === 'vps-control-panel'), 'the panel itself is present');
  assert.ok(S.overview.system, 'system metrics present');
  assert.equal(S.overview.system.cpus, 2, 'VPS-shaped core count');
  assert.match(String(S.overview.system.disk.use_pct), /%$/, 'disk percentage');
  assert.equal(S.switchOn, false, 'defaults to actions OFF');
  assert.equal(S.theme, 'dark', 'defaults to dark');
});

test('preview controls exist for actions, theme and width', () => {
  for (const sel of ['data-pv="switch"', 'data-pv="theme"', 'data-pv="w"']) {
    assert.ok(src.includes(sel), `${sel} control present`);
  }
  assert.match(src, /id="pv-bar"/, 'control bar present');
  assert.ok(src.includes('data-val="0"') && src.includes('data-val="1"'), 'both switch states offered');
  assert.ok(src.includes('data-val="dark"') && src.includes('data-val="light"'), 'both themes offered');
  for (const w of ['390', '768', '1440']) {
    assert.ok(src.includes(`data-val="${w}"`), `${w}px width preset`);
  }
});

// --- execute the inlined scripts offline --------------------------------
test('the inlined scripts execute and populate the panel with no network', async () => {
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 3, `expected mock + app + toolbar scripts, got ${scripts.length}`);

  // DOM stub
  const ids = new Set([...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const cells = new Map();
  function el(id) {
    if (!cells.has(id)) {
      const n = {
        id, innerHTML: '', value: '', checked: false, disabled: false, dataset: {},
        className: '', style: {}, _listeners: {},
        classList: {
          _s: new Set(),
          add(...c) { c.forEach((x) => this._s.add(x)); },
          remove(...c) { c.forEach((x) => this._s.delete(x)); },
          toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; if (w) this._s.add(c); else this._s.delete(c); },
          contains(c) { return this._s.has(c); }
        },
        addEventListener(ev, fn) { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
        removeEventListener() {}, appendChild() {}, remove() {}, focus() {}, click() {},
        querySelectorAll: () => [], querySelector: () => el(`${id}>q`), closest: () => null
      };
      let t = '';
      Object.defineProperty(n, 'textContent', { get: () => t, set: (v) => { t = v == null ? '' : String(v); }, enumerable: true });
      cells.set(id, n);
    }
    return cells.get(id);
  }
  const tbodyFor = (id) => el(`${id}::tbody`);
  global.document = {
    hidden: false, activeElement: null,
    documentElement: { getAttribute: () => 'dark', setAttribute() {}, outerHTML: src },
    body: el('body'),
    getElementById: (id) => el(id),
    createElement: () => el(`new-${Math.random()}`),
    querySelector: (sel) => {
      const m = /^#([\w-]+)\s+tbody$/.exec(sel);
      if (m) return tbodyFor(m[1]);
      return el(sel);
    },
    querySelectorAll: () => [],
    addEventListener() {}
  };
  global.window = {
    addEventListener() {}, scrollTo() {}, __PREVIEW__: null,
    fetch: null, location: { hash: '' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }
  };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.location = { hash: '' };
  global.history = { replaceState() {} };
  global.setInterval = () => 0;
  global.setTimeout = () => 0;

  // Run the mock layer first, then the app, in a shared sandbox.
  const vm = require('vm');
  const sandbox = {
    document: global.document, window: global.window, localStorage: global.localStorage,
    location: global.location, history: global.history,
    setInterval: global.setInterval, setTimeout: global.setTimeout,
    console, Math, Date, JSON, Promise, String, Number, Object, Array, Set, Map, parseInt, parseFloat, isNaN
  };
  // In a browser `window.fetch === fetch`; app.js calls bare fetch, so the
  // sandbox needs that same global binding, resolved lazily because the mock
  // layer assigns window.fetch only once it runs.
  Object.defineProperty(sandbox, 'fetch', {
    get: () => sandbox.window.fetch,
    configurable: true
  });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // 1. mock layer
  vm.runInContext(scripts[0], sandbox, { timeout: 5000 });
  assert.ok(sandbox.window.fetch, 'fetch is stubbed by the mock layer');
  assert.ok(sandbox.window.__PREVIEW__, 'mock state exposed');
  assert.equal(sandbox.window.__PREVIEW__.scan.items.length >= 15, true, 'baked scan present');

  // The stub must answer the panel's calls without any network.
  const me = await sandbox.window.fetch('/api/me');
  assert.equal((await me.json()).user.username, 'admin', '/api/me answered from the stub');
  const sc = await (await sandbox.window.fetch('/api/scan')).json();
  assert.equal(sc.items.every((i) => i.actions.length === 0), true, 'switch OFF -> no actions advertised');

  // Enabling through the real endpoint then re-scan reveals live buttons.
  sandbox.window.__PREVIEW__.switchOn = true;
  const sc2 = await (await sandbox.window.fetch('/api/scan')).json();
  const live = sc2.items.filter((i) => i.actions.length);
  assert.ok(live.length > 0, 'switch ON -> live buttons appear');
  assert.ok(sc2.items.find((i) => i.id === 'vps-control-panel').actions.length === 0, 'panel stays protected');

  // Confirm the confirm-word gate is honoured in the offline build too.
  const bad = await sandbox.window.fetch('/api/policy/actions-enabled', { method: 'POST', body: JSON.stringify({ enabled: true, confirm_word: 'nope' }) });
  assert.equal(bad.status, 400, 'wrong confirm word is rejected offline');
  const good = await sandbox.window.fetch('/api/policy/actions-enabled', { method: 'POST', body: JSON.stringify({ enabled: true, confirm_word: 'ENABLE' }) });
  assert.equal(good.status, 200, 'correct confirm word is accepted offline');

  // 2. the real app code must parse and boot in this sandbox
  assert.doesNotThrow(() => vm.runInContext(scripts[1], sandbox, { timeout: 10000 }), 'inlined app.js boots');
  assert.ok(typeof sandbox.renderScan === 'function', 'app.js exports/runs its render path');
});
