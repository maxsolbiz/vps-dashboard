module.exports = {
  apps: [
    {
      name: 'vps-control-panel',
      script: 'server.js',
      // Canonical home is /root/vps-dashboard (git clone). Overridable for
      // staging/dev checkouts; no secrets here.
      cwd: process.env.PANEL_CWD || '/root/vps-dashboard',
      // Panel must never listen publicly: localhost only. Reached via
      // https://vps.maxsolbiz.com behind the Apache reverse proxy
      // (and via SSH tunnel with plain http://127.0.0.1:8787).
      // The master actions switch lives in data/policy.json (read live, one
      // edit, no restart). Do NOT put ACTIONS_ENABLED here: the env var is
      // only an emergency kill-switch when explicitly 'false'.
      // Public hostname served through the reverse proxy (Host allowlist +
      // https Origin). No secrets here.
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '8787',
        PANEL_PUBLIC_HOST: 'vps.maxsolbiz.com'
      },
      max_memory_restart: '256M',
      exp_backoff_restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s'
    }
  ]
};
