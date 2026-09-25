'use strict';
/* Vanilla JS dashboard. No build step, no inline handlers. */
const $ = (id) => document.getElementById(id);
const state = { me: null, csrf: null, scan: null, overview: null, filter: 'all', search: '', logId: null, logWhich: 'out', live: true, pending: new Set() };

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.csrf && (opts.method === 'POST' || opts.method === 'PATCH')) headers['X-Panel-CSRF'] = state.csrf;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtMB(b) { return b == null ? '—' : (b / 1048576).toFixed(0) + ' MB'; }
function fmtUp(s) {
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  if (d) return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  const h = Math.floor(s / 3600);
  if (h) return `${h}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}m`;
}
function toast(msg, cls) {
  const t = document.createElement('div');
  t.className = `toast ${cls || ''}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

async function refreshMe() {
  const me = await api('/api/me');
  state.me = me.user;
  state.csrf = me.csrf;
  $('login-view').classList.toggle('hidden', !!me.user);
  $('app-view').classList.toggle('hidden', !me.user);
  $('logout-btn').classList.toggle('hidden', !me.user);
  $('changepw-btn').classList.toggle('hidden', !me.user);
  $('actions-toggle-wrap').classList.toggle('hidden', !me.user);
  $('actions-toggle').checked = me.actions_enabled === true;
  $('actions-toggle-label').textContent = me.actions_enabled ? 'actions ENABLED' : 'actions disabled';
  $('session').textContent = me.user ? `${me.user.username} · actions ${me.actions_enabled ? 'ENABLED' : 'disabled'}` : '';
  if (me.user) { await refreshScan(true); await refreshAll(); }
}

function matchSearch(a) {
  const q = state.search.toLowerCase();
  if (!q) return true;
  return [a.name, a.display_name, a.id, (a.domains || []).join(' '), (a.ports || []).map((p) => p.port).join(' '), a.cwd]
    .join(' ').toLowerCase().includes(q);
}
function matchFilter(a) { return state.filter === 'all' || a.category === state.filter; }

async function refreshScan(silent) {
  try {
    const last = await api('/api/scan');
    if (last && last.items) { state.scan = last; renderScan(last); }
    else if (!silent) toast('no scan yet — press SCAN VPS');
  } catch (e) { if (!silent) toast('scan load failed: ' + e.message, 'fail'); }
}

async function doScan() {
  const btn = $('scan-btn');
  btn.disabled = true;
  btn.textContent = 'SCANNING…';
  try {
    const r = await api('/api/scan', { method: 'POST', body: '{}' });
    state.scan = r;
    state.diff = r.diff || { new: [], gone: [] }; // kept until the next scan
    renderScan(r);
    toast(`scan complete: ${r.counts.running} running, ${r.counts.stopped} stopped${r.cached ? ' (cached)' : ''}`, 'ok');
  } catch (e) { toast('scan failed: ' + e.message, 'fail'); }
  btn.disabled = false;
  btn.textContent = 'SCAN VPS';
  await refreshAll();
}

// Builds the action-button cell for one pm2 row. Pure: no DOM, so it is unit
// testable (test/ui.test.js). The greyed Start/Stop/Restart fallback keys off
// the app having no allowed actions, NOT off the combined button list being
// empty — otherwise a Logs button suppresses the fallback and the action
// buttons vanish instead of showing disabled.
function actionButtons(a, pend) {
  if (a.kind !== 'pm2') return '';
  const live = isLiveStatus(a.status);
  const allowed = a.actions || [];
  const btns = [];
  if (!live && allowed.includes('start')) {
    if (a.start_blocked) {
      btns.push(`<button disabled title="port ${(a.ports || [])[0] ? a.ports[0].port : '?'} still held by pid ${a.holder_pid}">Start</button>`);
    } else {
      btns.push(`<button data-act="start" data-id="${esc(a.id)}" ${pend ? 'disabled' : ''}>Start</button>`);
    }
  }
  if (live && allowed.includes('stop')) btns.push(`<button class="danger" data-act="stop" data-id="${esc(a.id)}" ${pend ? 'disabled' : ''}>Stop</button>`);
  if (live && allowed.includes('restart')) btns.push(`<button data-act="restart" data-id="${esc(a.id)}" ${pend ? 'disabled' : ''}>Restart</button>`);
  if (!allowed.length) {
    btns.push('<button disabled title="not enabled in policy">Start</button><button disabled title="not enabled in policy">Stop</button><button disabled title="not enabled in policy">Restart</button>');
  }
  if (a.logs_enabled) btns.push(`<button class="ghost" data-act="logs" data-id="${esc(a.id)}">Logs</button>`);
  return btns.join(' ');
}

function renderScan(r) {
  $('scan-meta').textContent = r.scanned_at ? `last scan: ${r.scanned_at}${r.cached ? ' (cached)' : ''}${r.complete === false ? ' · INCOMPLETE' : ''}` : '';
  const diff = state.diff;
  $('scan-diff').textContent = diff && (diff.new.length || diff.gone.length)
    ? `diff: ${diff.new.length} new (${diff.new.join(', ')}), ${diff.gone.length} gone (${diff.gone.join(', ')})` : '';
  // Chips are recomputed from the (live-merged) rows on every render,
  // so they never go stale between scans.
  const rows = r.items || [];
  $('scan-warn').textContent = (r.warnings && r.warnings.length)
    ? `scan warnings: ${r.warnings.join(' | ')}` : '';
  const c = {
    running: rows.filter((i) => i.status === 'running').length,
    stopped: rows.filter((i) => i.status === 'stopped' || i.status === 'unmanaged-stopped').length,
    errored: rows.filter((i) => i.status === 'errored' || i.status === 'restarting').length,
    unmanaged: rows.filter((i) => i.kind === 'unmanaged').length,
    public_binds: rows.filter((i) => (i.ports || []).some((p) => p.public)).length
  };
  $('chips').innerHTML =
    `<span>Running ${c.running}</span><span>Stopped ${c.stopped}</span>` +
    `<span>Errored ${c.errored}</span><span>Unmanaged ${c.unmanaged}</span>` +
    `<span class="${c.public_binds ? 'warn' : ''}">Public binds ${c.public_binds}</span>` +
    ((r.drift && (r.drift.running_not_in_dump.length || r.drift.in_dump_not_running.length))
      ? `<span class="warn">dump drift: running∉dump [${r.drift.running_not_in_dump.join(', ')}] · dump∉running [${r.drift.in_dump_not_running.join(', ')}]</span>` : '');
  const items = (r.items || []).filter((a) => matchSearch(a) && matchFilter(a));
  const pm2rows = items.filter((a) => a.kind === 'pm2' || a.kind === 'panel');
  const webrows = items.filter((a) => a.kind === 'website');
  const unrows = items.filter((a) => a.kind === 'unmanaged');
  const infrarows = items.filter((a) => a.kind === 'infra');

  document.querySelector('#apps-pm2 tbody').innerHTML = pm2rows.map((a) => {
    const live = isLiveStatus(a.status);
    const pend = state.pending.has(a.id);
    const btns = actionButtons(a, pend);
    const ports = (a.ports || []).map((p) => `${p.port}${p.public ? ' ⚠' : ''}`).join(', ') || '—';
    const drift = a.kind === 'pm2' && live && r.drift && r.drift.running_not_in_dump.includes(a.name)
      ? '<span class="badge">not in dump</span>' : '';
    return `<tr><td><b>${esc(a.display_name || a.name)}</b>${drift}<br><small>${esc(a.id)}${(a.domains || []).length ? ' · ' + esc(a.domains.join(', ')) : ''}</small></td>
      <td><span class="tag ${esc(a.category)}">${esc(a.category)}</span></td>
      <td><span class="dot ${esc(a.status)}">●</span> ${esc(a.status)}</td>
      <td>${(a.pids || [])[0] || '—'}</td><td>${a.cpu_pct != null ? a.cpu_pct + '%' : '—'}</td>
      <td>${fmtMB(a.rss_b)}</td><td>${fmtUp(a.uptime_s)}</td><td>${esc(ports)}</td>
      <td>${a.restarts != null ? a.restarts : '—'}</td><td>${btns || '<i>—</i>'}</td></tr>`;
  }).join('');
  document.querySelector('#apps-web tbody').innerHTML = webrows.map((a) =>
    `<tr><td><b>${esc(a.display_name || a.name)}</b></td><td><span class="dot ${esc(a.status)}">●</span> ${esc(a.status)}</td>
     <td>${esc((a.domains || []).join(', '))}</td><td>${esc(a.cwd || '')}</td></tr>`).join('');
  document.querySelector('#apps-unmanaged tbody').innerHTML = unrows.map((a) =>
    `<tr><td><b>${esc(a.name)}</b></td><td><span class="dot ${esc(a.status)}">●</span> ${esc(a.status)}</td>
     <td>${(a.pids || [])[0] || '—'}</td><td>${a.cpu_pct != null ? a.cpu_pct + '%' : '—'}</td>
     <td>${fmtMB(a.rss_b)}</td><td>${esc(a.notes || '')}</td></tr>`).join('');
  document.querySelector('#apps-infra tbody').innerHTML = infrarows.map((a) =>
    `<tr><td><b>${esc(a.name)}</b></td><td><span class="dot ${esc(a.status)}">●</span> ${esc(a.status)}</td>
     <td>${esc(a.notes || '')}</td></tr>`).join('');
  document.querySelectorAll('#apps-pm2 button').forEach((b) =>
    b.addEventListener('click', () => onAppButton(b.dataset.id, b.dataset.act)));

  const all = pm2rows.filter((a) => a.kind === 'pm2' && a.rss_b);
  $('top-cpu').innerHTML = [...all].sort((x, y) => y.cpu_pct - x.cpu_pct).slice(0, 5)
    .map((a) => `<li>${esc(a.name)} — ${a.cpu_pct}%</li>`).join('');
  $('top-ram').innerHTML = [...all].sort((x, y) => y.rss_b - x.rss_b).slice(0, 5)
    .map((a) => `<li>${esc(a.name)} — ${fmtMB(a.rss_b)}</li>`).join('');
}

function isLiveStatus(s) { return s === 'running' || s === 'launching' || s === 'restarting'; }

// Merge live overview data into the scan rows by app name on every poll,
// so rows never go stale between scans.
function mergeOverview(ov) {
  if (!ov || !ov.apps || !state.scan || !state.scan.items) return;
  const map = Object.fromEntries(ov.apps.map((a) => [a.name, a]));
  for (const item of state.scan.items) {
    if (item.kind !== 'pm2' && item.kind !== 'panel') continue;
    const o = map[item.name];
    if (!o) continue;
    item.status = o.status;
    item.cpu_pct = o.cpu_pct;
    item.rss_b = o.rss_b;
    item.pids = o.pids;
    item.uptime_s = o.uptime_s;
    item.ports = o.ports;
    item.restarts = o.restarts;
  }
}

function renderServerCard(ov) {
  if (!ov.system) return;
  const m = ov.system.mem;
  $('server').innerHTML =
    `<div><b>RAM</b><br>${m.use_pct}% used (${m.source}${m.estimated ? ', estimated' : ''})</div>` +
    `<div><b>Swap</b><br>${(m.swap_used_b / 1073741824).toFixed(2)} / ${(m.swap_total_b / 1073741824).toFixed(2)} GB</div>` +
    `<div><b>Load</b><br>${ov.system.load.map((x) => x.toFixed(2)).join(' / ')} · ${ov.system.cpus} cores</div>` +
    `<div><b>Disk /</b><br>${ov.system.disk ? ov.system.disk.use_pct + ' used' : 'n/a'}</div>` +
    `<div><b>Uptime</b><br>${fmtUp(ov.system.uptime_s)}</div>`;
}

async function authLost(e) {
  if (e && e.status === 401) { await refreshMe(); return true; }
  return false;
}

async function refreshOverviewAndMerge() {
  const ov = await api('/api/overview');
  state.overview = ov;
  renderServerCard(ov);
  const banner = $('policy-banner');
  if (ov.policy_error) {
    banner.textContent = `policy problem — actions and logs are blocked: ${ov.policy_error}`;
    banner.classList.remove('hidden');
  } else {
    banner.textContent = '';
    banner.classList.add('hidden');
  }
  mergeOverview(ov);
  if (state.scan) renderScan(state.scan);
}

async function refreshAll() {
  try {
    await refreshOverviewAndMerge();
  } catch (e) {
    if (await authLost(e)) return;
  }
  try {
    const d = await api('/api/audit?limit=50');
    document.querySelector('#audit tbody').innerHTML = d.entries.map((e) =>
      `<tr><td>${esc(e.t)}</td><td>${esc(e.user || '')}</td><td>${esc(e.app || '')}</td>
       <td>${esc(e.action)}</td><td>${esc(e.result)}${e.error ? ' · ' + esc(e.error) : ''}</td><td>${esc(e.ip || '')}</td></tr>`).join('');
  } catch (e) { await authLost(e); }
}

let modalResolve = null;
let modalMode = 'confirm';
function closeModal(value) {
  $('modal').classList.add('hidden');
  $('modal-pw-current').value = '';
  $('modal-pw-new').value = '';
  $('modal-pw-confirm').value = '';
  $('modal-pw-error').textContent = '';
  $('modal-confirm-word').value = '';
  $('modal-confirm-word-error').textContent = '';
  if (modalResolve) modalResolve(value);
}
function hideModalExtras() {
  $('modal-pw-wrap').classList.add('hidden');
  $('modal-confirm-word-wrap').classList.add('hidden');
  $('modal-confirm-word-error').textContent = '';
}
function confirmModal(title, text, needName) {
  modalMode = 'confirm';
  $('modal-title').textContent = title;
  $('modal-text').textContent = text;
  $('modal-confirm-name-wrap').classList.toggle('hidden', !needName);
  hideModalExtras();
  $('modal-confirm-name').value = '';
  $('modal').classList.remove('hidden');
  return new Promise((resolve) => { modalResolve = resolve; });
}
// Password-change dialog. The confirm field is client-side only; the new
// password itself is never logged or echoed back by the server.
function passwordModal() {
  modalMode = 'password';
  $('modal-title').textContent = 'Change panel login password';
  $('modal-text').textContent = 'This changes the password for THIS panel login only. The Apache Basic Auth password is separate and is never changed here.';
  $('modal-confirm-name-wrap').classList.add('hidden');
  hideModalExtras();
  $('modal-pw-wrap').classList.remove('hidden');
  $('modal-pw-current').value = '';
  $('modal-pw-new').value = '';
  $('modal-pw-confirm').value = '';
  $('modal-pw-error').textContent = '';
  $('modal').classList.remove('hidden');
  $('modal-pw-current').focus();
  return new Promise((resolve) => { modalResolve = resolve; });
}
// Arming confirmation for the master switch. Off is deliberately frictionless.
function confirmEnableModal() {
  modalMode = 'enable';
  $('modal-title').textContent = 'Enable starting/stopping apps?';
  $('modal-text').textContent = 'This allows starting, stopping and restarting any app listed in the allow list — including production and banking apps. Type ENABLE to arm it. You can switch it off again with one click, no typing.';
  $('modal-confirm-name-wrap').classList.add('hidden');
  hideModalExtras();
  $('modal-confirm-word-wrap').classList.remove('hidden');
  $('modal-confirm-word').value = '';
  $('modal').classList.remove('hidden');
  $('modal-confirm-word').focus();
  return new Promise((resolve) => { modalResolve = resolve; });
}
async function showLogs() {
  if (!state.logId) return;
  $('log-app').textContent = `— ${state.logId} (${state.logWhich})`;
  $('logs').textContent = 'loading…';
  try {
    const d = await api(`/api/apps/${encodeURIComponent(state.logId)}/logs?which=${state.logWhich}`);
    $('logs').textContent = d.text.slice(-20000) || '(empty)';
  } catch (e) { $('logs').textContent = 'failed: ' + e.message; }
}

// These two MUST stay at module top level, not inside the document guard below.
// app.js runs in strict mode, where a function declared inside a block is
// block-scoped; renderScan() is top level and references onAppButton, so moving
// it into the guard made every row button throw ReferenceError on click.
async function onAppButton(id, act) {
  if (act === 'logs') { state.logId = id; state.logWhich = 'out'; await showLogs(); return; }
  const a = (state.scan.items || []).find((x) => x.id === id);
  const needName = act === 'stop';
  const typed = await confirmModal(`${act} ${a ? a.name : id}?`,
    needName ? `This will STOP ${id}. Type the app name to confirm.` : `This will ${act} ${id}.`, needName);
  if (typed === null) return;
  state.pending.add(id);
  renderScan(state.scan);
  try {
    const r = await api(`/api/apps/${encodeURIComponent(id)}/actions`, {
      method: 'POST', body: JSON.stringify({ action: act, confirm: true, confirmName: needName ? typed : undefined })
    });
    toast(`${r.action} ${r.app}: now ${r.status} (pid ${r.pid})`, 'ok');
  } catch (e) {
    // Always re-enable the row first: on a 401 (expired session) we return
    // to the login form, and the buttons must not stay disabled behind it.
    state.pending.delete(id);
    if (state.scan) renderScan(state.scan);
    if (await authLost(e)) return;
    toast(`failed: ${e.message}`, 'fail');
    return;
  }
  state.pending.delete(id);
  // Refresh rows from REAL state (overview cache was cleared server-side),
  // not from the stale saved scan.
  try {
    await refreshOverviewAndMerge();
    const d = await api('/api/audit?limit=50');
    document.querySelector('#audit tbody').innerHTML = d.entries.map((x) =>
      `<tr><td>${esc(x.t)}</td><td>${esc(x.user || '')}</td><td>${esc(x.app || '')}</td>
       <td>${esc(x.action)}</td><td>${esc(x.result)}${x.error ? ' · ' + esc(x.error) : ''}</td><td>${esc(x.ip || '')}</td></tr>`).join('');
  } catch (e) { await authLost(e); }
}

// Browser-only bootstrap: event wiring + first load. Guarded so test/ui.test.js
// can require this file for actionButtons() without a DOM.
if (typeof document !== 'undefined') {
$('modal-ok').addEventListener('click', () => {
  if (modalMode === 'password') {
    const cur = $('modal-pw-current').value;
    const next = $('modal-pw-new').value;
    const conf = $('modal-pw-confirm').value;
    if (next !== conf) { $('modal-pw-error').textContent = 'new passwords do not match'; return; }
    if (next.length < 12) { $('modal-pw-error').textContent = 'new password must be at least 12 characters'; return; }
    closeModal({ mode: 'password', current_password: cur, new_password: next });
    return;
  }
  if (modalMode === 'enable') {
    const word = $('modal-confirm-word').value;
    if (word !== 'ENABLE') { $('modal-confirm-word-error').textContent = 'must be exactly ENABLE'; return; }
    closeModal({ mode: 'enable', enabled: true });
    return;
  }
  closeModal($('modal-confirm-name').value);
});
$('modal-cancel').addEventListener('click', () => closeModal(null));

$('log-out').addEventListener('click', () => { state.logWhich = 'out'; showLogs(); });
$('log-err').addEventListener('click', () => { state.logWhich = 'err'; showLogs(); });

$('scan-btn').addEventListener('click', doScan);
$('refresh-btn').addEventListener('click', refreshAll);
$('live-toggle').addEventListener('change', (e) => { state.live = e.target.checked; });
$('search').addEventListener('input', (e) => { state.search = e.target.value; if (state.scan) renderScan(state.scan); });
document.querySelectorAll('.filters button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.filters button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  state.filter = b.dataset.f;
  if (state.scan) renderScan(state.scan);
}));
$('login-btn').addEventListener('click', async () => {
  $('login-err').textContent = '';
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }) });
    state.csrf = r.csrf;
    $('login-pass').value = '';
    await refreshMe();
  } catch (e) { $('login-err').textContent = e.message; }
});
for (const id of ['login-user', 'login-pass']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
}
$('changepw-btn').addEventListener('click', async () => {
  const out = await passwordModal();
  if (!out || out.mode !== 'password') return;
  try {
    const r = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: out.current_password, new_password: out.new_password }) });
    const n = r.other_sessions_revoked || 0;
    toast(n ? `Password changed. ${n} other session${n === 1 ? '' : 's'} signed out.` : 'Password changed.');
  } catch (e) {
    toast(`Password change failed: ${e.message}`, 'err');
  }
});

// Master switch. OFF is one click; ON requires typing ENABLE. After a
// successful toggle we rescan immediately, because the saved scan advertised
// the previous switch state and would otherwise leave the buttons stale.
async function setActionsEnabled(enabled, confirmWord) {
  try {
    const r = await api('/api/policy/actions-enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled, confirm_word: confirmWord })
    });
    await refreshMe();
    await doScan();
    toast(enabled ? 'Actions ENABLED — buttons are live.' : 'Actions disabled — buttons are greyed out.');
    return r;
  } catch (e) {
    await refreshMe();
    toast(`Toggle failed: ${e.message}`, 'err');
    return null;
  }
}
$('actions-toggle').addEventListener('change', async (e) => {
  const wantOn = e.target.checked;
  if (!wantOn) { await setActionsEnabled(false); return; }
  const out = await confirmEnableModal();
  if (!out || out.mode !== 'enable') { await refreshMe(); return; }
  await setActionsEnabled(true, 'ENABLE');
});
$('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  await refreshMe();
});
  setInterval(() => { if (state.live && state.me && !document.hidden) refreshAll(); }, 10000);
  refreshMe();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { actionButtons, isLiveStatus, esc, renderScan, state };
}
