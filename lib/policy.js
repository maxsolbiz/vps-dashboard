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
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
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
    deny: {},
    actions_enabled: false,
    ignore_paths: [],
    logs_disabled: ['*'],
    panel_name: config.panelName,
    _error: reason
  };
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
  fs.mkdirSync(path.dirname(config.overridesPath), { recursive: true });
  fs.writeFileSync(config.overridesPath, JSON.stringify(overrides, null, 2));
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

module.exports = { loadPolicy, getPolicyError, getLastGood, loadOverrides, saveOverrides, logsEnabled, applyOverrides, CATEGORIES, META_FIELDS };
