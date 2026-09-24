'use strict';

// Memory figures MUST come from /proc/meminfo, never os.freemem().
// os.freemem() ignores page cache, so on the VPS it would report ~96% used
// when real pressure (MemAvailable-based) is ~27%.
const fs = require('fs');
const config = require('./config');

function parseMeminfo(text) {
  const m = {};
  for (const line of String(text).split('\n')) {
    const mt = line.match(/^(\w+):\s+(\d+)\s*kB/i);
    if (mt) m[mt[1]] = parseInt(mt[2], 10) * 1024;
  }
  if (!m.MemTotal || !m.MemAvailable) throw new Error('meminfo missing MemTotal/MemAvailable');
  const used = m.MemTotal - m.MemAvailable;
  return {
    source: 'meminfo',
    total_b: m.MemTotal,
    available_b: m.MemAvailable,
    used_b: used,
    use_pct: +((100 * used) / m.MemTotal).toFixed(1),
    swap_total_b: m.SwapTotal || 0,
    swap_free_b: m.SwapFree || 0,
    swap_used_b: (m.SwapTotal || 0) - (m.SwapFree || 0)
  };
}

function readMemory() {
  try {
    return parseMeminfo(fs.readFileSync(config.meminfoPath, 'utf8'));
  } catch (err) {
    // Dev fallback (Windows/macOS local runs): flagged estimated, never used on VPS.
    const os = require('os');
    const total = os.totalmem();
    const free = os.freemem();
    return {
      source: 'estimated',
      estimated: true,
      total_b: total,
      available_b: free,
      used_b: total - free,
      use_pct: +((100 * (total - free)) / total).toFixed(1),
      swap_total_b: 0,
      swap_free_b: 0,
      swap_used_b: 0
    };
  }
}

module.exports = { parseMeminfo, readMemory };
