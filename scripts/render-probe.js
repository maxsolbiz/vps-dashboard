'use strict';
// Renders the REAL panel JS against REAL scan data with a stub DOM.
// Catches the exact line where row rendering dies, if it does.
const fs = require('fs');
const path = require('path');

const scanFile = process.argv[2];
const realScan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));

const registry = new Map();
function makeEl(key) {
  return {
    _key: key,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    appendChild() {},
    remove() {},
    click() {}
  };
}
function el(key) {
  if (!registry.has(key)) registry.set(key, makeEl(key));
  return registry.get(key);
}

global.document = {
  getElementById: (id) => el(`#${id}`),
  createElement: (tag) => makeEl(`new:${tag}:${Math.random()}`),
  querySelector: (sel) => el(sel),
  querySelectorAll: () => [],
  hidden: false
};

const routes = {
  '/api/me': { user: { username: 'admin', role: 'admin' }, csrf: 'test', actions_enabled: false },
  '/api/scan': realScan,
  '/api/overview': { at: new Date().toISOString(), pm2_available: true, system: null, apps: [] },
  '/api/audit?limit=50': { entries: [] }
};
global.fetch = async (url) => {
  const body = routes[url] || {};
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};
global.setInterval = () => 0;

let renderError = null;
process.on('unhandledRejection', (e) => { renderError = e; });

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  eval(src);
  // refreshMe() runs on load; give async chains time to settle
  await new Promise((r) => setTimeout(r, 2000));
  if (renderError) {
    console.log('UNHANDLED REJECTION:', renderError && renderError.stack);
    process.exit(2);
  }
  const pm2rows = (el('#apps-pm2 tbody').innerHTML.match(/<tr>/g) || []).length;
  const webrows = (el('#apps-web tbody').innerHTML.match(/<tr>/g) || []).length;
  const unrows = (el('#apps-unmanaged tbody').innerHTML.match(/<tr>/g) || []).length;
  const infrarows = (el('#apps-infra tbody').innerHTML.match(/<tr>/g) || []).length;
  console.log(JSON.stringify({ pm2rows, webrows, unrows, infrarows, chips: el('#chips').innerHTML.slice(0, 200) }));
})().catch((e) => { console.log('HARNESS THREW:', e && e.stack); process.exit(3); });
