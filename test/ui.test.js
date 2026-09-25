'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// public/app.js is a browser script; its bootstrap is guarded so it can be
// required here without a DOM.
const { actionButtons } = require(path.join(__dirname, '..', 'public', 'app.js'));

const base = { kind: 'pm2', id: 'app-1', status: 'running', actions: [], logs_enabled: true };

function labels(html) {
  return [...html.matchAll(/>([A-Za-z]+)<\/button>/g)].map((m) => m[1]);
}
function countDisabled(html) {
  return (html.match(/<button disabled/g) || []).length;
}

test('actions=[] with logs_enabled=true shows all three greyed buttons AND Logs', () => {
  // Regression: the greyed fallback used to fire on the combined button list
  // being empty, so a Logs button suppressed it and the action buttons vanished.
  const html = actionButtons({ ...base }, false);
  assert.deepEqual(labels(html), ['Start', 'Stop', 'Restart', 'Logs']);
  assert.equal(countDisabled(html), 3, 'exactly the three action buttons are disabled');
  assert.match(html, /not enabled in policy/);
  assert.doesNotMatch(html, /data-act="(start|stop|restart)"/, 'greyed buttons have no handler attrs');
  assert.match(html, /data-act="logs"/, 'Logs stays live');
});

test('actions=[] with logs_enabled=false shows the three greyed buttons and no Logs', () => {
  const html = actionButtons({ ...base, logs_enabled: false }, false);
  assert.deepEqual(labels(html), ['Start', 'Stop', 'Restart']);
  assert.equal(countDisabled(html), 3);
});

test('populated actions render live buttons and do NOT add the greyed fallback', () => {
  const html = actionButtons({ ...base, actions: ['stop', 'restart'] }, false);
  assert.deepEqual(labels(html), ['Stop', 'Restart', 'Logs']);
  assert.equal(countDisabled(html), 0, 'no greyed fallback when actions exist');
  assert.match(html, /data-act="stop"/);
  assert.match(html, /data-act="restart"/);
});

test('populated actions with logs_enabled=false omit Logs', () => {
  const html = actionButtons({ ...base, actions: ['stop', 'restart'], logs_enabled: false }, false);
  assert.deepEqual(labels(html), ['Stop', 'Restart']);
  assert.doesNotMatch(html, /Logs/);
});

test('stopped app with populated actions shows Start, not Stop/Restart', () => {
  const html = actionButtons({ ...base, status: 'stopped', actions: ['start', 'stop', 'restart'] }, false);
  assert.deepEqual(labels(html), ['Start', 'Logs']);
  assert.match(html, /data-act="start"/);
});

test('start_blocked disables Start and names the holder pid', () => {
  const html = actionButtons(
    { ...base, status: 'stopped', actions: ['start'], start_blocked: true, holder_pid: 99999, ports: [{ port: 3002 }] },
    false
  );
  assert.match(html, /still held by pid 99999/);
  assert.match(html, /port 3002/);
  assert.doesNotMatch(html, /data-act="start"/, 'blocked Start must not be clickable');
  assert.doesNotMatch(html, /not enabled in policy/, 'blocked is a different reason from not-in-policy');
});

test('non-pm2 rows render no buttons', () => {
  assert.equal(actionButtons({ kind: 'panel', id: 'vps-control-panel', status: 'online', actions: [], logs_enabled: false }, false), '');
  assert.equal(actionButtons({ kind: 'website', id: 'site', status: 'online', actions: [], logs_enabled: false }, false), '');
});

test('rendered buttons carry no inline style or data: URI (strict CSP)', () => {
  for (const a of [
    { ...base },
    { ...base, logs_enabled: false },
    { ...base, actions: ['stop', 'restart'] },
    { ...base, status: 'stopped', actions: ['start'], start_blocked: true, holder_pid: 1, ports: [{ port: 80 }] },
  ]) {
    const html = actionButtons(a, false);
    assert.doesNotMatch(html, /\sstyle="/, 'no inline style attributes');
    assert.doesNotMatch(html, /data:/, 'no data: URIs');
  }
});

test('app name is escaped in button ids', () => {
  const html = actionButtons({ ...base, id: 'x"><script>alert(1)</script>', actions: ['stop'] }, false);
  assert.doesNotMatch(html, /<script>/, 'id is escaped');
  assert.match(html, /&quot;/);
});

test('renderScan does not throw and honours the greyed fallback end-to-end', () => {
  // Regression guard: extracting actionButtons() dropped a `const live` that
  // renderScan still used for the drift badge, which threw ReferenceError in
  // the browser but was invisible to actionButtons-only tests.
  const { renderScan, state } = require(path.join(__dirname, '..', 'public', 'app.js'));
  const cells = {};
  const mk = (id) => ({ innerHTML: '', textContent: '', querySelectorAll: () => [], classList: { add() {}, remove() {} } });
  global.document = {
    hidden: false,
    getElementById: (id) => (cells[id] = cells[id] || mk(id)),
    querySelector: (sel) => (cells[sel] = cells[sel] || mk(sel)),
    querySelectorAll: () => []
  };
  try {
    state.pending = new Set();
    renderScan({
      scanned_at: '2026-01-01T00:00:00Z',
      items: [
        { ...base, id: 'indirect-app', name: 'indirect-app', status: 'running', actions: [], logs_enabled: true, category: 'app', ports: [] },
        { ...base, id: 'allowed-app', name: 'allowed-app', status: 'running', actions: ['stop', 'restart'], logs_enabled: false, category: 'app', ports: [] }
      ],
      drift: { running_not_in_dump: [], in_dump_not_running: [] }
    });
  } finally {
    delete global.document;
  }
  const html = cells['#apps-pm2 tbody'].innerHTML;
  const row = (id) => html.split('<tr>').find((r) => r.includes(id)) || '';
  const greyed = row('indirect-app');
  assert.match(greyed, /not enabled in policy/, 'no-allow row shows the greyed fallback in a real render');
  assert.match(greyed, />Logs</, 'and still shows Logs');
  const live2 = row('allowed-app');
  assert.doesNotMatch(live2, /not enabled in policy/, 'allowed row has no fallback');
  assert.match(live2, /data-act="stop"/);
});
