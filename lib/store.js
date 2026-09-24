'use strict';

// Storage without native modules:
//   users.json (0600) — one admin, node:crypto scrypt hash. No password in env/args/HTTP.
//   sessions   — in-memory only (die with the process).
//   audit.jsonl (0600, append-only) — every mutating attempt, rotated at ~5 MB.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

function ensurePrivate(file, initial) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, initial, { mode: 0o600 });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) { /* non-POSIX fs */ }
}

// ---------- passwords (scrypt, pure JS binding to OpenSSL — no native addon) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const hash = crypto.scryptSync(Buffer.from(password), Buffer.from(saltHex, 'hex'), 32, {
      N: parseInt(n, 10), r: parseInt(r, 10), p: parseInt(p, 10)
    });
    return crypto.timingSafeEqual(Buffer.from(hashHex, 'hex'), hash);
  } catch (_) {
    return false;
  }
}

// ---------- users ----------
function loadUsers() {
  ensurePrivate(config.usersPath, '[]');
  try {
    const arr = JSON.parse(fs.readFileSync(config.usersPath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveUsers(users) {
  const tmp = `${config.usersPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, config.usersPath);
  try { fs.chmodSync(config.usersPath, 0o600); } catch (_) {}
}

function createUser(username, password) {
  username = String(username).slice(0, 64);
  if (!username || !password || String(password).length < 12) {
    throw new Error('username and password (min 12 chars) required');
  }
  const users = loadUsers();
  if (users.some((u) => u.username === username)) throw new Error('user already exists');
  const user = {
    id: crypto.randomUUID(),
    username,
    password_hash: hashPassword(String(password)),
    role: 'admin',
    created_at: new Date().toISOString()
  };
  users.push(user);
  saveUsers(users);
  return { id: user.id, username: user.username, role: user.role };
}

function findUser(username) {
  return loadUsers().find((u) => u.username === username) || null;
}

// ---------- sessions (in-memory) ----------
const sessions = new Map(); // token -> {userId, username, role, created, lastSeen}

function createSession(user, ip, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    userId: user.id, username: user.username, role: user.role,
    created: now, lastSeen: now, ip: ip || null, userAgent: (userAgent || '').slice(0, 200)
  });
  return token;
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > config.sessionIdleS * 1000) { sessions.delete(token); return null; }
  if (now - s.created > config.sessionMaxS * 1000) { sessions.delete(token); return null; }
  s.lastSeen = now;
  return { id: s.userId, username: s.username, role: s.role };
}

function destroySession(token) {
  sessions.delete(token);
}

// ---------- audit (append-only jsonl) ----------
function rotateAuditIfNeeded() {
  try {
    const st = fs.statSync(config.auditPath);
    if (st.size < config.auditMaxBytes) return;
    try { fs.renameSync(config.auditPath, `${config.auditPath}.1`); } catch (_) {}
  } catch (_) { /* missing file is fine */ }
}

function audit(entry) {
  ensurePrivate(config.auditPath, '');
  rotateAuditIfNeeded();
  const line = JSON.stringify({
    t: new Date().toISOString(),
    user: entry.username || null,
    app: entry.appId || null,
    action: entry.action,
    result: entry.result,
    error: entry.error ? String(entry.error).slice(0, 300) : null,
    ip: entry.ip || null
  });
  fs.appendFileSync(config.auditPath, `${line}\n`, { mode: 0o600 });
}

function recentAudit(limit = 100) {
  try {
    const text = fs.readFileSync(config.auditPath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-Math.min(Math.max(limit, 1), 500)).reverse().map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  hashPassword, verifyPassword, loadUsers, createUser, findUser,
  createSession, getSession, destroySession, audit, recentAudit
};
