'use strict';

// Policy: default actions for PM2 apps + log-disable patterns + master switch.
// data/policy.json (LIVE) is editable ONLY on the server, never via HTTP.
// The tarball ships data/policy.default.json; the server copies default ->
// live only when the live file is missing, so upgrades never overwrite
// operator settings. data/overrides.json holds UI-editable display fields:
// display_name, category (production|test|utility|unclassified), notes.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ensureDir } = require('./fsutil');

const CATEGORIES = new Set(['production', 'test', 'utility', 'unclassified']);
const META_FIELDS = ['display_name', 'category', 'notes'];

function ensureLiveFiles() {
  const pairs = [
    [config.policyDefaultPath, config.policyPath],
    [config.overridesDefaultPath, config.overridesPath]
  ];
  for (const [src, dst] of pairs) {
    try {
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        ensureDir(path.dirname(dst));
        fs.copyFileSync(src, dst);
        try { fs.chmodSync(dst, 0o600); } catch (_) { /* non-POSIX fs */ }
      }
    } catch (_) { /* read-only fs: callers fail closed */ }
  }
}

// Fail closed: a missing or corrupt policy blocks everything (actions off,
// all logs off). The last good policy is kept in memory for diagnostics,
// but enforcement NEVER uses it after a failure.
let lastError = null;
let lastGood = null;

function failClosed(reason) {
  lastError = reason;
  return {
    default_actions: [],
    allow: {},
    deny: {},
    actions_enabled: false,
    ignore_paths: [],
    logs_disabled: ['*'],
    panel_name: config.panelName,
    _error: reason
  };
}

// The allow map is fail-closed: only well-formed {name: [action...]} entries
// survive, and anything missing/malformed yields an empty map (no app gets
// actions). Invalid action names are dropped, not fatal.
const VALID_ACTIONS = new Set(['start', 'stop', 'restart']);
function normalizeAllow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, actions] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) continue;
    if (!Array.isArray(actions)) continue;
    const clean = actions.filter((a) => VALID_ACTIONS.has(a));
    if (clean.length) out[name] = [...new Set(clean)];
  }
  return out;
}

// Effective actions for an app: allow-list entry, minus deny, minus anything
// the global default set doesn't permit. Returns [] for unlisted apps.
function actionsFor(policy, appName) {
  const listed = Array.isArray(policy.allow && policy.allow[appName])
    ? policy.allow[appName]
    : [];
  if (!listed.length) return [];
  const denied = Array.isArray(policy.deny && policy.deny[appName]) ? policy.deny[appName] : [];
  const permitted = new Set(policy.default_actions || []);
  return listed.filter((a) => permitted.has(a) && !denied.includes(a));
}

function loadPolicy() {
  ensureLiveFiles();
  let raw;
  try {
    raw = fs.readFileSync(config.policyPath, 'utf8');
  } catch (err) {
    return failClosed(`policy unreadable: ${err.code || err.message}`);
  }
  let p;
  try {
    p = JSON.parse(raw);
  } catch (_) {
    return failClosed('policy is not valid JSON');
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return failClosed('policy is not an object');
  }
  const out = {
    default_actions: Array.isArray(p.default_actions) ? p.default_actions : ['start', 'stop', 'restart'],
    allow: normalizeAllow(p.allow),
    deny: p.deny && typeof p.deny === 'object' ? p.deny : {},
    actions_enabled: p.actions_enabled === true,
    ignore_paths: Array.isArray(p.ignore_paths) ? p.ignore_paths.map(String) : [],
    logs_disabled: Array.isArray(p.logs_disabled) ? p.logs_disabled : [],
    panel_name: typeof p.panel_name === 'string' ? p.panel_name : config.panelName
  };
  lastError = null;
  lastGood = out;
  return out;
}

function getPolicyError() { return lastError; }
function getLastGood() { return lastGood; }

function loadOverrides() {
  ensureLiveFiles();
  try {
    const o = JSON.parse(fs.readFileSync(config.overridesPath, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch (_) {
    return {};
  }
}

function saveOverrides(overrides) {
  ensureDir(path.dirname(config.overridesPath));
  fs.writeFileSync(config.overridesPath, JSON.stringify(overrides, null, 2));
  try { fs.chmodSync(config.overridesPath, 0o600); } catch (_) { /* non-POSIX fs */ }
}

function globMatch(pattern, name) {
  const re = new RegExp(`^${String(pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

function logsEnabled(policy, name) {
  return !(policy.logs_disabled || []).some((pat) => globMatch(pat, name));
}

function applyOverrides(item, overrides) {
  const o = overrides[item.id];
  if (!o) return item;
  const out = { ...item };
  if (typeof o.display_name === 'string' && o.display_name.slice(0, 80)) out.display_name = o.display_name.slice(0, 80);
  if (CATEGORIES.has(o.category)) out.category = o.category;
  if (typeof o.notes === 'string') out.notes = o.notes.slice(0, 500);
  return out;
}

module.exports = { loadPolicy, getPolicyError, getLastGood, loadOverrides, saveOverrides, logsEnabled, applyOverrides, actionsFor, normalizeAllow, CATEGORIES, META_FIELDS, VALID_ACTIONS };
