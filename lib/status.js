'use strict';

// Single PM2 status mapping shared by scan and overview.
// Crash-looping states must NEVER read as "stopped".
function mapStatus(s) {
  switch (String(s || '').toLowerCase()) {
    case 'online': return 'running';
    case 'launching': return 'launching';
    case 'stopping': return 'restarting';
    case 'waiting restart':
    case 'one-launch-status':
      return 'restarting';
    case 'errored': return 'errored';
    case 'stopped': return 'stopped';
    default: return String(s || 'unknown');
  }
}

// Statuses where Start is the sensible action.
function isLive(status) {
  return status === 'running' || status === 'launching' || status === 'restarting';
}

module.exports = { mapStatus, isLive };
