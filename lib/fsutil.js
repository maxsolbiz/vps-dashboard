'use strict';

// Filesystem helpers with secure defaults. Private files (users, audit,
// policy, overrides) are 0600 and data/ is 0700; modes are enforced with
// chmodSync (best-effort on non-POSIX filesystems) so files copied by
// tarballs or editors with loose modes get tightened on every access.
const fs = require('fs');
const path = require('path');

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch (_) { /* non-POSIX fs */ }
}

function ensureFile(file, initial, mode = 0o600) {
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, initial, { mode });
  }
  try {
    fs.chmodSync(file, mode);
  } catch (_) { /* non-POSIX fs */ }
}

function writePrivate(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch (_) { /* non-POSIX fs */ }
}

module.exports = { ensureDir, ensureFile, writePrivate };
