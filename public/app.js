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
  $('actions-toggle-label').textContent = switchLabel(me.actions_enabled === true);
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

// Containers that render action buttons. The pm2 table and its mobile card
// list are separate elements; both need click handlers.
const ACTION_BUTTON_ROOTS = ['#apps-pm2', '#apps-pm2-cards'];

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
  $('nav-count-apps').textContent = pm2rows.length;

  const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="wrap"><div class="empty"><div class="big">—</div>${msg}</div></td></tr>`;

  document.querySelector('#apps-pm2 tbody').innerHTML = pm2rows.length ? pm2rows.map((a) => {
    const live = isLiveStatus(a.status);
    const pend = state.pending.has(a.id);
    const btns = actionButtons(a, pend);
    const ports = (a.ports || []).map((p) => `${p.port}${p.public ? ' ⚠' : ''}`).join(', ') || '—';
    const drift = a.kind === 'pm2' && live && r.drift && r.drift.running_not_in_dump.includes(a.name)
      ? '<span class="badge">not in dump</span>' : '';
    return `<tr><td><b>${esc(a.display_name || a.name)}</b>${drift}<br><span class="app-sub">${esc(a.id)}${(a.domains || []).length ? ' · ' + esc(a.domains.join(', ')) : ''}</span></td>
      <td><span class="tag ${esc(a.category)}">${esc(a.category)}</span></td>
      <td>${statusCell(a.status)}</td>
      <td class="num">${(a.pids || [])[0] || '—'}</td><td class="num">${a.cpu_pct != null ? a.cpu_pct + '%' : '—'}</td>
      <td class="num">${fmtMB(a.rss_b)}</td><td>${fmtUp(a.uptime_s)}</td><td class="mono">${esc(ports)}</td>
      <td class="num">${a.restarts != null ? a.restarts : '—'}</td><td class="actions">${btns || '<span class="muted">—</span>'}</td></tr>`;
  }).join('') : emptyRow(10, 'No managed applications match the current filter.');

  // Mobile: the same rows as cards, so the page never needs horizontal scroll.
  $('apps-pm2-cards').innerHTML = pm2rows.map((a) => {
    const pend = state.pending.has(a.id);
    const btns = actionButtons(a, pend);
    return `<div class="app-card">
      <div class="app-card-top">
        <div class="nm"><div class="app-card-name">${esc(a.display_name || a.name)}</div>
          <span class="tag ${esc(a.category)}">${esc(a.category)}</span></div>
        ${statusCell(a.status)}
      </div>
      <div class="app-card-stats">
        <div><div class="k">CPU</div><div class="v">${a.cpu_pct != null ? a.cpu_pct + '%' : '—'}</div></div>
        <div><div class="k">RAM</div><div class="v">${fmtMB(a.rss_b)}</div></div>
        <div><div class="k">Port</div><div class="v">${(a.ports || [])[0] ? esc(a.ports[0].port) : '—'}</div></div>
      </div>
      <div class="app-card-meta muted">uptime ${fmtUp(a.uptime_s)} · pid ${(a.pids || [])[0] || '—'} · restarts ${a.restarts != null ? a.restarts : '—'}</div>
      <div class="app-card-actions">${btns}</div>
    </div>`;
  }).join('') || '<div class="empty"><div class="big">—</div>No managed applications match the current filter.</div>';

  document.querySelector('#apps-web tbody').innerHTML = webrows.map((a) =>
    `<tr><td><b>${esc(a.display_name || a.name)}</b></td><td>${statusCell(a.status)}</td>
     <td class="wrap">${esc((a.domains || []).join(', '))}</td><td class="wrap muted">${esc(a.cwd || '')}</td></tr>`).join('');
  $('apps-web-empty').classList.toggle('hidden', webrows.length > 0);
  document.querySelector('#apps-unmanaged tbody').innerHTML = unrows.map((a) =>
    `<tr><td><b>${esc(a.name)}</b></td><td>${statusCell(a.status)}</td>
     <td class="num">${(a.pids || [])[0] || '—'}</td><td class="num">${a.cpu_pct != null ? a.cpu_pct + '%' : '—'}</td>
     <td class="num">${fmtMB(a.rss_b)}</td><td class="wrap muted">${esc(a.notes || '')}</td></tr>`).join('');
  $('apps-unmanaged-empty').classList.toggle('hidden', unrows.length > 0);
  document.querySelector('#apps-infra tbody').innerHTML = infrarows.map((a) =>
    `<tr><td><b>${esc(a.name)}</b></td><td><span class="dot ${esc(a.status)}">●</span> ${esc(a.status)}</td>
     <td>${esc(a.notes || '')}</td></tr>`).join('');
  // The desktop table and the mobile cards are SIBLING containers, and below
  // 640px only the cards are visible. Both must be wired or the mobile action
  // buttons are inert.
  // The desktop table and the mobile cards are SIBLING containers, and below
  // 640px only the cards are visible. Both must be wired or the mobile action
  // buttons are inert.
  ACTION_BUTTON_ROOTS.forEach((root) => {
    document.querySelectorAll(`${root} button`).forEach((b) => {
      if (b.dataset.act) b.addEventListener('click', () => onAppButton(b.dataset.id, b.dataset.act));
    });
  });

    // Hotspots: ranked, with a proportional bar so the leader is obvious at a
    // glance. Bars are relative to the top entry, not an absolute scale.
    const all = pm2rows.filter((a) => a.kind === 'pm2' && a.rss_b);
    const rankRow = (a, pct, value) => {
      const w = Math.max(2, Math.min(100, pct));
      return `<li data-app="${esc(a.id)}" tabindex="0" role="button">
        <span class="pos">${a._pos}</span>
        <span class="rank-name">${esc(a.name)}</span>
        <span class="bar"><i class="bar-fill" data-width="${widthClass(w)}"></i></span>
        <span class="rank-val">${esc(value)}</span>
      </li>`;
    };
    const top = [...all].sort((x, y) => (y.cpu_pct || 0) - (x.cpu_pct || 0)).slice(0, 5);
    const cpuMax = Math.max(1, ...top.map((a) => a.cpu_pct || 0));
    $('top-cpu').innerHTML = top.length
      ? top.map((a, i) => rankRow({ ...a, _pos: i + 1 }, ((a.cpu_pct || 0) / cpuMax) * 100, `${(a.cpu_pct || 0).toFixed(1)}%`)).join('')
      : '<li class="rank-empty">No running applications</li>';
    const topRam = [...all].sort((x, y) => (y.rss_b || 0) - (x.rss_b || 0)).slice(0, 5);
    const ramMax = Math.max(1, ...topRam.map((a) => a.rss_b || 0));
    $('top-ram').innerHTML = topRam.length
      ? topRam.map((a, i) => rankRow({ ...a, _pos: i + 1 }, ((a.rss_b || 0) / ramMax) * 100, fmtMB(a.rss_b))).join('')
      : '<li class="rank-empty">No running applications</li>';
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

// ---------- view switching ----------
const VIEWS = ['dashboard', 'applications', 'processes', 'ports', 'logs', 'audit', 'settings'];
function showView(name) {
  if (!VIEWS.includes(name)) name = 'dashboard';
  for (const v of VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle('on', v === name);
  }
  document.querySelectorAll('.nav-item').forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  state.view = name;
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0);
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('panel-theme', t); } catch (_) { /* private mode */ }
}

// ---------- responsive helpers ----------
const MOBILE_NAV = '(max-width: 860px)';
function isMobileNav() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_NAV).matches
    : window.innerWidth <= 860;
}
// The switch must stay readable on a phone without overflowing the header, so
// the long form is used on desktop and a short, still-unambiguous one on mobile.
function switchLabel(on) {
  if (isMobileNav()) return on ? 'ON' : 'off';
  return on ? 'actions ENABLED' : 'actions disabled';
}

// ---------- off-canvas drawer (mobile) ----------
let navOpen = false;
function setNav(open) {
  navOpen = !!open;
  document.body.classList.toggle('nav-open', navOpen);
  const back = $('nav-backdrop');
  if (back) {
    back.classList.toggle('hidden', !navOpen);
    back.setAttribute('aria-hidden', String(!navOpen));
  }
  const btn = $('nav-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', String(navOpen));
    btn.setAttribute('aria-label', navOpen ? 'Close navigation menu' : 'Open navigation menu');
  }
  if (navOpen) {
    const first = document.querySelector('#nav .nav-item');
    if (first && first.focus) first.focus();
  }
}
function closeNav() { if (navOpen) setNav(false); }

// ---------- formatting ----------
function fmtBytes(b) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function meterClass(pct) {
  if (pct == null || isNaN(pct)) return '';
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}
// CSP forbids inline styles, so meter widths are 5%-step utility classes.
function widthClass(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `w${Math.round(p / 5) * 5}`;
}
function statusCell(status) {
  const s = String(status || 'unknown');
  const glyph = s === 'running' ? '●' : (s === 'stopped' ? '○' : (s === 'errored' || s === 'missing' ? '✕' : '◐'));
  return `<span class="status ${esc(s)}"><span class="glyph" aria-hidden="true">${glyph}</span>${esc(s)}</span>`;
}

// ---------- dashboard: health metrics ----------
function renderHealth(ov) {
  const sys = ov && ov.system;
  const box = $('health-metrics');
  if (!box) return;
  if (!sys) {
    box.innerHTML = '<div class="metric"><div class="metric-label">System</div>'
      + '<div class="metric-value">unavailable</div>'
      + '<div class="metric-sub">monitoring data could not be read</div></div>';
    return;
  }
  const mem = sys.mem || {};
  const disk = sys.disk;
  const load = Array.isArray(sys.load) ? sys.load : [];
  // True whole-box CPU from /proc/stat. null on the very first sample or when
  // the counter is unreadable — render an em dash rather than a guess.
  const cpuPct = (typeof sys.cpu_pct === 'number' && !isNaN(sys.cpu_pct)) ? sys.cpu_pct : null;
  const diskPct = disk ? parseFloat(disk.use_pct) : null;
  const loadPct = load.length && sys.cpus
    ? Math.min(100, (load[0] / (sys.cpus * 2)) * 100) : null;
  const memEst = mem.estimated ? ' (estimated)' : '';

  const cards = [
    { label: 'CPU', value: cpuPct == null ? '—' : `${cpuPct}%`, pct: cpuPct,
      sub: cpuPct == null ? 'collecting…' : `${sys.cpus || '?'} cores · whole-system` },
    { label: 'Memory', value: fmtBytes(mem.used_b), pct: mem.use_pct,
      sub: `${fmtBytes(mem.available_b)} free of ${fmtBytes(mem.total_b)}${memEst}` },
    { label: 'Swap', value: mem.swap_total_b ? fmtBytes(mem.swap_used_b) : 'none',
      pct: mem.swap_total_b ? (mem.swap_used_b / mem.swap_total_b) * 100 : null,
      sub: mem.swap_total_b ? `of ${fmtBytes(mem.swap_total_b)}` : 'not configured' },
    { label: 'Disk /', value: disk ? fmtBytes(Number(disk.used_kb || 0) * 1024) : '—', pct: diskPct,
      sub: disk ? `${fmtBytes(Number(disk.avail_kb || 0) * 1024)} free of ${fmtBytes(Number(disk.total_kb || 0) * 1024)}` : 'unavailable' },
    { label: 'Load (1m)', value: load.length ? load[0].toFixed(2) : '—', pct: loadPct,
      sub: load.length > 2 ? `5m ${load[1].toFixed(2)} · 15m ${load[2].toFixed(2)}` : 'of ' + ((sys.cpus || 1) * 2) + ' max' },
    { label: 'Uptime', value: fmtUp(sys.uptime_s), sub: 'since boot' }
  ];
  box.innerHTML = cards.map((c) => {
    const pct = c.pct;
    const bar = pct != null && !isNaN(pct)
      ? `<div class="meter ${meterClass(pct)}"><i class="${widthClass(pct)}"></i></div>` : '';
    const scale = pct != null && !isNaN(pct) && c.label !== 'Load (1m)'
      ? `<span class="metric-pct">${pct.toFixed(0)}%</span>` : '';
    return `<div class="metric">
      <div class="metric-label">${esc(c.label)}${scale}</div>
      <div class="metric-value">${esc(c.value)}</div>
      <div class="metric-sub">${esc(c.sub || '')}</div>
      ${bar}
    </div>`;
  }).join('');

  const quick = [];
  if (cpuPct != null) quick.push(`cpu ${cpuPct}%`);
  if (mem.use_pct != null) quick.push(`mem ${mem.use_pct}%`);
  $('server-quick').textContent = quick.length ? quick.join(' · ') : '—';
  const st = $('server-status');
  if (st) {
    const bad = mem.use_pct >= 90 || (diskPct != null && diskPct >= 90);
    st.className = `status ${bad ? 'errored' : 'running'}`;
    st.innerHTML = `<span class="glyph" aria-hidden="true">${bad ? '✕' : '●'}</span><span>${bad ? 'degraded' : 'online'}</span>`;
  }
}

// ---------- dashboard: session-collected sparklines ----------
// The backend exposes no history, so we plot only samples actually observed
// since this page loaded. Nothing is invented. 60 samples at the 10 s poll is
// roughly a 10-minute window, kept in memory only (no storage, no timers).
const TREND_MAX = 60;
const trend = { cpu: [], mem: [], load: [], disk: [], lastCpu: null };
// Test hook: the buffers are module state, so tests need a clean slate.
function _resetTrend() {
  trend.cpu = []; trend.mem = []; trend.load = []; trend.disk = [];
  trend.lastCpu = null;
}
function seriesStats(pts) {  if (!pts.length) return null;
  let min = Infinity; let max = -Infinity;
  for (const p of pts) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  return { min, max, cur: pts[pts.length - 1].v, n: pts.length };
}
function statsLine(key, unit, digits) {
  const s = seriesStats(trend[key]);
  if (!s) return 'collecting…';
  const d = digits == null ? 0 : digits;
  return `now ${s.cur.toFixed(d)}${unit} · min ${s.min.toFixed(d)}${unit} · max ${s.max.toFixed(d)}${unit}`;
}
function pushTrend(ov) {
  const sys = ov && ov.system;
  if (!sys) return;
  const t = Date.now();
  const add = (arr, v) => {
    if (typeof v === 'number' && !isNaN(v)) { arr.push({ t, v }); if (arr.length > TREND_MAX) arr.shift(); }
  };
  // True whole-system CPU from /proc/stat. Previously this plotted the SUM of
  // per-process CPU, which is not the machine's utilisation.
  const cpuPct = (typeof sys.cpu_pct === 'number' && !isNaN(sys.cpu_pct)) ? sys.cpu_pct : null;
  trend.lastCpu = cpuPct;
  add(trend.cpu, cpuPct);
  add(trend.mem, sys.mem ? sys.mem.use_pct : null);
  add(trend.load, Array.isArray(sys.load) ? sys.load[0] : null);
  add(trend.disk, sys.disk ? parseFloat(sys.disk.use_pct) : null);

  drawChart('chart-cpu', trend.cpu, 100);
  drawChart('chart-mem', trend.mem, 100);
  drawChart('chart-load', trend.load, Math.max(1, (sys.cpus || 1) * 2));

  $('val-cpu').textContent = cpuPct == null ? 'collecting…' : `${cpuPct}% · ${statsLine('cpu', '%', 1)}`;
  $('val-mem').textContent = statsLine('mem', '%', 1);
  $('val-load').textContent = statsLine('load', '', 2);

  // Disk is a capacity gauge, not a time series: it moves too slowly to plot
  // honestly, and drawing a flat line would imply data we do not have.
  const diskPct = sys.disk ? parseFloat(sys.disk.use_pct) : null;
  const fill = $('gauge-disk-fill');
  if (fill) {
    if (diskPct == null || isNaN(diskPct)) {
      fill.className = 'gauge-fill';
      fill.setAttribute('data-empty', 'true');
    } else {
      fill.className = `gauge-fill ${meterClass(diskPct)}`;
      fill.setAttribute('data-width', widthClass(diskPct));
      fill.removeAttribute('data-empty');
    }
  }
  $('val-disk').textContent = diskPct == null || isNaN(diskPct)
    ? 'not reported'
    : `${diskPct.toFixed(0)}% used of ${fmtBytes(Number(sys.disk.total_kb || 0) * 1024)}`;
  $('val-disk-free').textContent = sys.disk
    ? `${fmtBytes(Number(sys.disk.avail_kb || 0) * 1024)} free` : '';

  $('trend-note').textContent = `${trend.cpu.length || trend.mem.length} sample${(trend.cpu.length || trend.mem.length) === 1 ? '' : 's'} since page load · ~10 min window`;
}
function drawChart(id, pts, max) {
  const svg = $(id);
  if (!svg) return;
  const W = 300; const H = 72;
  if (!pts || pts.length < 2) {
    // Be explicit that there is no data yet rather than drawing a flat line,
    // which would read as "steady at zero".
    svg.classList.add('waiting');
    svg.innerHTML = `<line class="grid-line" x1="0" y1="${H - 2}" x2="${W}" y2="${H - 2}"></line>`;
    return;
  }
  svg.classList.remove('waiting');
  const span = Math.max(1, max);
  const step = W / Math.max(1, pts.length - 1);
  const coords = pts.map((p, i) => {
    const y = H - Math.max(0, Math.min(1, p.v / span)) * (H - 10) - 4;
    return [i * step, y];
  });
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const last = pts[pts.length - 1].v / span;
  const crit = last > 0.9 ? ' crit' : (last > 0.75 ? ' warn' : '');
  const [hx, hy] = coords[coords.length - 1];
  svg.innerHTML =
    `<line class="grid-line" x1="0" y1="${H - 2}" x2="${W}" y2="${H - 2}"></line>`
    + `<line class="grid-line mid" x1="0" y1="${(H / 2).toFixed(1)}" x2="${W}" y2="${(H / 2).toFixed(1)}"></line>`
    + `<path class="area${crit}" d="${area}"></path>`
    + `<path class="line${crit}" d="${line}"></path>`
    + `<circle class="head${crit}" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="2.5"></circle>`;
}

// ---------- dashboard: alerts (real rules only) ----------
function renderAlerts(ov, scan) {
  const box = $('alerts');
  if (!box) return;
  const out = [];
  const sys = ov && ov.system;
  if (sys && sys.mem && sys.mem.use_pct >= 80) {
    out.push({ lvl: sys.mem.use_pct >= 90 ? 'crit' : 'warn', ico: '▲',
      t: `Memory usage ${sys.mem.use_pct}%`, s: `${fmtBytes(sys.mem.used_b)} used of ${fmtBytes(sys.mem.total_b)}` });
  }
  if (sys && sys.disk && parseFloat(sys.disk.use_pct) >= 80) {
    out.push({ lvl: 'warn', ico: '▲', t: `Disk usage ${sys.disk.use_pct}`, s: `${fmtBytes(Number(sys.disk.avail_kb || 0) * 1024)} remaining on /` });
  }
  const items = (scan && scan.items) || [];
  for (const a of items) {
    if (a.kind !== 'pm2' && a.kind !== 'panel') continue;
    if (a.rss_b && a.rss_b > 800 * 1024 * 1024) {
      out.push({ lvl: 'warn', ico: '▲', t: `${a.name} is using ${fmtBytes(a.rss_b)} RAM`, s: a.category || 'application' });
    }
    if (a.status === 'errored' || a.status === 'missing') {
      out.push({ lvl: 'crit', ico: '✕', t: `${a.name} is ${a.status}`, s: a.pids && a.pids[0] ? `pid ${a.pids[0]}` : 'not running' });
    }
  }
  const stopped = items.filter((a) => a.kind === 'pm2' && a.status === 'stopped').length;
  if (stopped) {
    out.push({ lvl: 'info', ico: 'ℹ', t: `${stopped} managed application${stopped === 1 ? ' is' : 's are'} stopped`, s: 'expected if intentionally disabled' });
  }
  $('alert-count').textContent = out.length ? `${out.length} item${out.length === 1 ? '' : 's'}` : '';
  if (!out.length) {
    box.innerHTML = '<div class="empty"><div class="big">✓</div>No issues detected. All monitored values are within normal ranges.</div>';
    return;
  }
  box.innerHTML = out.map((a) => `<div class="alert-item ${esc(a.lvl)}">
      <span class="ico" aria-hidden="true">${a.ico}</span>
      <span class="txt"><span class="ttl">${esc(a.t)}</span><br><span class="sub">${esc(a.s)}</span></span>
    </div>`).join('');
}

// ---------- processes ----------
function renderProcesses(ov) {
  const tb = document.querySelector('#procs-table tbody');
  if (!tb) return;
  const apps = (ov && ov.apps) || [];
  $('nav-count-procs').textContent = apps.length;
  if (!apps.length) {
    tb.innerHTML = '';
    $('procs-cards').innerHTML = '';
    $('procs-empty').classList.remove('hidden');
    return;
  }
  $('procs-empty').classList.add('hidden');
  const q = ($('proc-search').value || '').toLowerCase();
  const rows = apps.filter((a) => !q || String(a.name).toLowerCase().includes(q));
  tb.innerHTML = rows.map((a) => `<tr>
      <td class="num">${a.pid || '—'}</td>
      <td class="app-name">${esc(a.name)}<br><span class="app-sub">${esc(a.category || '')}</span></td>
      <td>${statusCell(a.status)}</td>
      <td class="num">${a.cpu_pct != null ? a.cpu_pct + '%' : '—'}</td>
      <td class="num">${fmtBytes(a.rss_b)}</td>
      <td>${fmtUp(a.uptime_s)}</td>
      <td class="num">${(a.pids || []).length}</td>
    </tr>`).join('');
  $('procs-cards').innerHTML = rows.map((a) => `<div class="app-card">
      <div class="app-card-top"><div class="nm"><div class="app-card-name">${esc(a.name)}</div>
      <span class="tag ${esc(a.category || 'unclassified')}">${esc(a.category || 'unclassified')}</span></div>
      ${statusCell(a.status)}</div>
      <div class="app-card-stats">
        <div><div class="k">PID</div><div class="v">${a.pid || '—'}</div></div>
        <div><div class="k">CPU</div><div class="v">${a.cpu_pct != null ? a.cpu_pct + '%' : '—'}</div></div>
        <div><div class="k">RSS</div><div class="v">${fmtBytes(a.rss_b)}</div></div>
      </div></div>`).join('');
}

// ---------- ports ----------
function renderPorts(scan) {
  const tb = document.querySelector('#ports-table tbody');
  if (!tb) return;
  const items = (scan && scan.items) || [];
  const rows = [];
  const seen = new Set();
  for (const a of items) {
    for (const p of (a.ports || [])) {
      const key = `${p.port}:${p.bind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ port: p.port, bind: p.bind, public: p.public, app: a.name, domains: a.domains || [] });
    }
  }
  rows.sort((x, y) => x.port - y.port);
  $('nav-count-ports').textContent = rows.length;
  $('ports-note').textContent = rows.length ? `${rows.filter((r) => r.public).length} publicly bound` : '';
  if (!rows.length) {
    tb.innerHTML = ''; $('ports-cards').innerHTML = '';
    $('ports-empty').classList.remove('hidden');
    return;
  }
  $('ports-empty').classList.add('hidden');
  tb.innerHTML = rows.map((r) => `<tr>
      <td class="num">${r.port}</td>
      <td class="mono">${esc(r.bind)}</td>
      <td>${r.public ? '<span class="tag production">public</span>' : '<span class="tag unclassified">local</span>'}</td>
      <td class="app-name">${esc(r.app)}</td>
      <td class="wrap muted">${esc(r.domains.join(', ') || '—')}</td>
    </tr>`).join('');
  $('ports-cards').innerHTML = rows.map((r) => `<div class="app-card">
      <div class="app-card-top"><div class="nm"><div class="app-card-name">:${r.port}</div>
      <span class="app-sub">${esc(r.app)}</span></div>
      ${r.public ? '<span class="tag production">public</span>' : '<span class="tag unclassified">local</span>'}</div>
      <div class="app-card-stats">
        <div><div class="k">Bind</div><div class="v">${esc(r.bind)}</div></div>
        <div><div class="k">Port</div><div class="v">${r.port}</div></div>
        <div><div class="k">Domains</div><div class="v">${r.domains.length}</div></div>
      </div></div>`).join('');
}

// ---------- settings ----------
function renderPolicyInfo(me) {
  const box = $('policy-info');
  if (!box) return;
  const enabled = !!(me && me.actions_enabled);
  $('setting-switch-state').className = `status ${enabled ? 'running' : 'stopped'}`;
  $('setting-switch-state').innerHTML = `<span class="glyph" aria-hidden="true">${enabled ? '●' : '○'}</span><span>${enabled ? 'enabled' : 'disabled'}</span>`;
  $('settings-toggle-btn').textContent = enabled ? 'Disable actions' : 'Enable actions…';
  const scan = state.scan;
  const allowed = (scan && scan.items ? scan.items : []).filter((a) => (a.actions || []).length).length;
  box.innerHTML = `
    <div><div class="k">Master switch</div><div class="v">${enabled ? 'enabled' : 'disabled'}</div></div>
    <div><div class="k">Apps with actions</div><div class="v">${allowed}</div></div>
    <div><div class="k">Scan</div><div class="v">${scan && scan.scanned_at ? esc(scan.scanned_at) : 'not scanned'}</div></div>
    <div><div class="k">Signed in as</div><div class="v">${me && me.user ? esc(me.user.username) : '—'}</div></div>`;
}

function renderServerCard(ov) {
  const box = $('server');
  if (!box) return;
  const sys = ov && ov.system;
  if (!sys) { box.innerHTML = '<div class="empty"><div class="big">Unavailable</div>System metrics could not be read.</div>'; return; }
  const mem = sys.mem || {};
  const d = sys.disk;
  box.innerHTML = `
    <div><div class="k">Hostname</div><div class="v">${esc(state.scan && state.scan.hostname ? state.scan.hostname : 'not reported')}</div></div>
    <div><div class="k">CPU cores</div><div class="v">${sys.cpus || '—'}</div></div>
    <div><div class="k">Memory</div><div class="v">${fmtBytes(mem.used_b)} / ${fmtBytes(mem.total_b)}</div></div>
    <div><div class="k">Memory available</div><div class="v">${fmtBytes(mem.available_b)}</div></div>
    <div><div class="k">Swap</div><div class="v">${mem.swap_total_b ? `${fmtBytes(mem.swap_used_b)} / ${fmtBytes(mem.swap_total_b)}` : 'not configured'}</div></div>
    <div><div class="k">Disk /</div><div class="v">${d ? `${d.use_pct} used` : 'unavailable'}</div></div>
    <div><div class="k">Load average</div><div class="v">${Array.isArray(sys.load) ? sys.load.map((n) => n.toFixed(2)).join(' / ') : '—'}</div></div>
    <div><div class="k">Uptime</div><div class="v">${fmtUp(sys.uptime_s)}</div></div>`;
}

async function refreshAll() {
  try {
    await refreshOverviewAndMerge();
  } catch (e) {
    if (await authLost(e)) return;
  }
  const ov = state.overview;
  renderHealth(ov);
  renderServerCard(ov);
  renderProcesses(ov);
  renderAlerts(ov, state.scan);
  renderPolicyInfo(state.me);
  if (ov) {
    // CPU is only meaningful as a whole-box number once merged.
    const cpuSum = (ov.apps || []).reduce((s, a) => s + (Number(a.cpu_pct) || 0), 0);
    if (Number.isFinite(cpuSum)) {
      $('server-quick').textContent = ov.system && ov.system.mem ? `cpu ${cpuSum.toFixed(0)}% · mem ${ov.system.mem.use_pct}%` : `cpu ${cpuSum.toFixed(0)}%`;
    }
  }
  pushTrend(ov);
  try {
    const d = await api('/api/audit?limit=50');
    const entries = d.entries || [];
    document.querySelector('#audit tbody').innerHTML = entries.map((e) =>
      `<tr><td class="mono">${esc(e.t)}</td><td>${esc(e.user || '')}</td><td>${esc(e.app || '')}</td>
       <td>${esc(e.action)}</td><td><span class="tag ${e.result === 'ok' ? 'production' : 'utility'}">${esc(e.result)}</span>${e.error ? ' <span class="muted">' + esc(e.error) + '</span>' : ''}</td><td class="mono">${esc(e.ip || '')}</td></tr>`).join('');
    $('audit-empty').classList.toggle('hidden', entries.length > 0);
  } catch (e) { await authLost(e); }
}

let modalResolve = null;
let modalMode = 'confirm';
let lastFocus = null;
function focusables() {
  const box = $('modal');
  if (!box) return [];
  return [...box.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.offsetParent !== null);
}
function trapTab(e) {
  if (e.key !== 'Tab') return;
  const f = focusables();
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function closeModal(value) {
  const box = $('modal');
  if (box) box.classList.add('hidden');
  $('modal-pw-current').value = '';
  $('modal-pw-new').value = '';
  $('modal-pw-confirm').value = '';
  $('modal-pw-error').textContent = '';
  $('modal-confirm-word').value = '';
  $('modal-confirm-word-error').textContent = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
  if (modalResolve) modalResolve(value);
}
function openModal() {
  lastFocus = document.activeElement;
  $('modal').classList.remove('hidden');
  const f = focusables();
  if (f.length) f[0].focus();
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
  openModal();
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
  openModal();
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
  openModal();
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
    await refreshAll();
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
// Escape cancels, Tab is trapped inside the dialog while it is open.
$('modal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeModal(null); return; }
  trapTab(e);
});

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

async function doChangePassword() {
  const out = await passwordModal();
  if (!out || out.mode !== 'password') return;
  try {
    const r = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: out.current_password, new_password: out.new_password }) });
    const n = r.other_sessions_revoked || 0;
    toast(n ? `Password changed. ${n} other session${n === 1 ? '' : 's'} signed out.` : 'Password changed.');
  } catch (e) {
    toast(`Password change failed: ${e.message}`, 'err');
  }
}
$('changepw-btn').addEventListener('click', doChangePassword);

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
$('settings-toggle-btn').addEventListener('click', async () => {
  const on = $('actions-toggle').checked;
  if (on) { await setActionsEnabled(false); return; }
  const out = await confirmEnableModal();
  if (!out || out.mode !== 'enable') { await refreshMe(); return; }
  await setActionsEnabled(true, 'ENABLE');
});
$('changepw-btn-2').addEventListener('click', () => doChangePassword());
$('theme-btn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next);
});
$('nav-toggle').addEventListener('click', () => {
  // Below 860 the nav is an off-canvas drawer; above it, a collapsible sidebar.
  if (isMobileNav()) { setNav(!navOpen); return; }
  const app = $('app-view');
  const collapsed = app.classList.toggle('nav-collapsed');
  $('nav-toggle').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('panel-nav', collapsed ? 'collapsed' : 'open'); } catch (_) { /* ignore */ }
});
$('nav-backdrop').addEventListener('click', closeNav);
$('proc-search').addEventListener('input', () => renderProcesses(state.overview));
$('log-refresh').addEventListener('click', () => showLogs());
document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => { showView(b.dataset.view); closeNav(); });
});
// Hotspot rows are clickable: open the app's Logs, which is the fastest useful
// drill-down without inventing a second detail surface.
document.getElementById('main').addEventListener('click', (e) => {
  const row = e.target.closest ? e.target.closest('.rank li[data-app]') : null;
  if (row && state.scan) {
    showView('logs');
    state.logId = row.dataset.app;
    state.logWhich = 'out';
    showLogs();
  }
});
document.getElementById('main').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest ? e.target.closest('.rank li[data-app]') : null;
  if (row && state.scan) {
    e.preventDefault();
    showView('logs');
    state.logId = row.dataset.app;
    state.logWhich = 'out';
    showLogs();
  }
});
window.addEventListener('hashchange', () => { showView(location.hash.slice(1)); closeNav(); });
// Leaving the mobile breakpoint must not strand an open drawer off-screen.
if (typeof window.matchMedia === 'function') {
  const mq = window.matchMedia(MOBILE_NAV);
  const onChange = () => {
    closeNav();
    $('actions-toggle-label').textContent = switchLabel($('actions-toggle').checked);
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}
// Keyboard: 1-7 jump between views when not typing in a field.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!$('modal').classList.contains('hidden')) return;
  if (e.key === 'Escape') { closeNav(); return; }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= VIEWS.length) { showView(VIEWS[n - 1]); closeNav(); }
});
$('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  await refreshMe();
});
  // restore persisted preferences before first paint of data
  try {
    const savedTheme = localStorage.getItem('panel-theme');
    if (savedTheme) applyTheme(savedTheme);
    if (localStorage.getItem('panel-nav') === 'collapsed') $('app-view').classList.add('nav-collapsed');
  } catch (_) { /* ignore */ }
  showView(location.hash.slice(1) || 'dashboard');
  // Pause polling on a hidden tab; resume (and catch up) when it returns.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.live && state.me) refreshAll();
  });
  setInterval(() => { if (state.live && state.me && !document.hidden) refreshAll(); }, 10000);
  refreshMe();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    actionButtons, isLiveStatus, esc, renderScan, state,
    renderHealth, renderServerCard, renderProcesses, renderPorts,
    renderAlerts, renderPolicyInfo, showView, VIEWS, pushTrend, drawChart, fmtBytes,
    setNav, closeNav, switchLabel, isMobileNav, _resetTrend
  };
}
