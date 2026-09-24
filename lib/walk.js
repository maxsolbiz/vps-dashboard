'use strict';

// Project directory discovery via Node fs walk (never shell).
// Roots: allowlisted only (default /root,/var/www,/opt,/srv).
// Uses readdirSync(dir, {withFileTypes:true}): zero statSync calls and no
// symlink following (a symlink is never isDirectory(), so it is never
// descended into). A directory like /root/club-mgt-uploads with thousands
// of files can't freeze the panel: entries are capped per directory and
// globally.
// A project = dir with package.json, ecosystem.config.* or composer.json.
// Only package.json "name" is read. No du, no .env, no git commands.
// Monorepo children collapse under the top dir (within the root) that has .git.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SKIP = new Set(['node_modules', '.git', '.next', 'vendor', 'dist']);

function num(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
const MAX_ENTRIES_PER_DIR = num('PANEL_WALK_PER_DIR', 2000);
const MAX_ENTRIES = num('PANEL_WALK_BUDGET', 20000);

function isProjectFile(n) {
  return n === 'package.json' || n === 'composer.json' || /^ecosystem\.config\..*$/.test(n);
}

function walk(roots, maxDepth = 3) {
  const found = []; // {dir, depth, files:Set}
  let truncated = false;
  // Budget per root: one huge uploads dir must not starve later roots.
  // Only capped entries count toward the budget.
  const perRoot = Math.ceil(MAX_ENTRIES / Math.max(roots.length, 1));
  for (const root of roots) {
    let st;
    try { st = fs.statSync(root); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    let used = 0;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
      if (used >= perRoot) { truncated = true; break; }
      const { dir, depth } = stack.pop();
      let dirents;
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) { continue; }
      let capped = dirents;
      if (dirents.length > MAX_ENTRIES_PER_DIR) {
        truncated = true;
        capped = dirents.slice(0, MAX_ENTRIES_PER_DIR);
      }
      used += capped.length;
      const files = new Set();
      for (const d of capped) {
        if (isProjectFile(d.name)) files.add(d.name); // name match only; no stat
      }
      if (files.size) found.push({ dir, depth, files });
      if (depth >= maxDepth) continue;
      for (const d of capped) {
        if (!d.isDirectory()) continue; // symlinks never descended into
        const n = d.name;
        if (SKIP.has(n) || n.startsWith('.')) continue;
        stack.push({ dir: path.join(dir, n), depth: depth + 1 });
      }
    }
  }
  return { found, truncated };
}

function readName(dir, files) {
  if (!files.has('package.json')) {
    if (files.has('composer.json')) return { name: path.basename(dir), kind: 'php' };
    return { name: path.basename(dir), kind: 'node' };
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return { name: typeof pkg.name === 'string' && pkg.name ? pkg.name : path.basename(dir), kind: 'node' };
  } catch (_) {
    return { name: path.basename(dir), kind: 'node' };
  }
}

// Collapse children under the top ancestor (within the same root) containing .git.
function collapseGit(found, roots) {
  const gitCache = new Map();
  const hasGit = (dir) => {
    if (gitCache.has(dir)) return gitCache.get(dir);
    let v = false;
    try { v = fs.statSync(path.join(dir, '.git')).isDirectory(); } catch (_) { v = false; }
    gitCache.set(dir, v);
    return v;
  };
  const normRoots = roots.map((r) => path.normalize(r));
  return found.map((f) => {
    const dir = path.normalize(f.dir);
    const root = normRoots.find((r) => dir === r || dir.startsWith(r + path.sep));
    let top = dir;
    if (root) {
      let cur = dir;
      while (cur !== root && cur.startsWith(root)) {
        if (hasGit(cur)) top = cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      if (hasGit(root)) top = root === dir ? dir : top;
    }
    return { ...f, group: top };
  });
}

function snapshot() {
  const roots = config.scanRoots.filter((r) => {
    try { return fs.statSync(r).isDirectory(); } catch (_) { return false; }
  });
  const { found, truncated } = walk(roots);
  const projects = collapseGit(found, roots).map((f) => ({ ...f, ...readName(f.dir, f.files) }));
  return { projects, truncated };
}

module.exports = { walk, readName, collapseGit, snapshot, SKIP, MAX_ENTRIES, MAX_ENTRIES_PER_DIR };
