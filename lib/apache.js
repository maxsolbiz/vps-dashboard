'use strict';

// Apache vhosts: parse ONLY ServerName, ProxyPass/ProxyPassReverse targets
// and DocumentRoot from sites-enabled/*.conf. SSL key/cert paths are never
// read. Maps domain -> port -> app; DocumentRoot-only vhosts (PHP/static)
// become "Web site" rows.
const fs = require('fs');
const path = require('path');
const config = require('./config');

function parseVhostFile(text) {
  const servers = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    let vm = line.match(/^<VirtualHost\s+([^>]*)>/i);
    if (vm) {
      const pm = vm[1].match(/:(\d+)/);
      cur = { names: [], proxies: [], docroot: null, port: pm ? parseInt(pm[1], 10) : 80 };
      continue;
    }
    if (/^<\/VirtualHost/i.test(line)) { if (cur) servers.push(cur); cur = null; continue; }
    if (!cur || !line || line.startsWith('#')) continue;
    let m = line.match(/^ServerName\s+(\S+)/i);
    if (m) { cur.names.push(m[1]); continue; }
    m = line.match(/^ServerAlias\s+(.+)$/i);
    if (m) { cur.names.push(...m[1].trim().split(/\s+/)); continue; }
    m = line.match(/^DocumentRoot\s+(\S+)/i);
    if (m) { cur.docroot = m[1].replace(/^"|"$/g, ''); continue; }
    m = line.match(/^ProxyPass(?:Reverse)?\s+\S+\s+(\S+)/i);
    if (m) {
      const um = m[1].match(/^https?:\/\/([^/:]+)(?::(\d+))?/i);
      if (um) cur.proxies.push({ host: um[1], port: um[2] ? parseInt(um[2], 10) : 80 });
      continue;
    }
  }
  if (cur) servers.push(cur);
  return servers;
}

function readVhosts(dir) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.conf')).sort();
  } catch (_) {
    return out;
  }
  for (const f of files) {
    try {
      const servers = parseVhostFile(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const s of servers) out.push({ file: f, ...s });
    } catch (_) { /* unreadable vhost: skip */ }
  }
  return out;
}

function snapshot() {
  return readVhosts(config.apacheDir);
}

module.exports = { parseVhostFile, readVhosts, snapshot };
