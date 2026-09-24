# SCAN — what discovery reads, and what it never reads

`POST /api/scan` is read-only. Single-flight, min 5 s between scans
(`PANEL_SCAN_GAP_MS`), 20 s total budget (`PANEL_SCAN_BUDGET_MS`).
Result is saved to `data/last-scan.json` (mode 0600). Nothing is written
to `/tmp`, and no scan step can start, stop, or modify anything.

## Exact command allowlist (fixed argv via execFile, no shell)

| Source | Command | Purpose |
|--------|---------|---------|
| PM2 | `pm2 jlist` | all processes incl. stopped; parsed from the first `[` (warnings tolerated) |
| processes | `ps -eo pid=,ppid=,rss=,pcpu=,etimes=,args=` | whole descendant tree per PM2 app; RSS/CPU summed over the tree |
| ports | `ss -tlnpH` (fallback `-tlnp`) | listening ports → pid → owning PM2 app; public vs 127.0.0.1 bind flag |
| infra | `systemctl is-active apache2 postgresql mariadb redis-server` | fixed unit list, display-only rows |
| disk | `df -k /` | root disk for the server card (overview only) |

Actions (separate path, same rules) may run ONLY:
`pm2 start <name>`, `pm2 stop <name>`, `pm2 restart <name>` —
name taken from the current `jlist`, validated, single argv element.
Never: `pm2 save/delete/kill/startup/update/flush/reload`, never `--update-env`.

## Non-command sources

- **Apache vhosts** (`PANEL_APACHE_DIR`, default
  `/etc/apache2/sites-enabled/*.conf`): only `ServerName`/`ServerAlias`,
  `ProxyPass`/`ProxyPassReverse` targets, `DocumentRoot`, and the
  `<VirtualHost>` port. SSL key/cert paths are never read. Domain → port →
  app mapping; DocumentRoot-only vhosts (PHP/static) become "Web site" rows
  grouped by (name, docroot) with merged ports (plain + `-le-ssl` confs for
  one site = one row). Redirect-only vhosts (no proxy, no docroot) create no
  rows. A docroot that is itself a scan root (or holds several projects)
  never hides projects.
- **Project walk** (Node `fs` Dirent walk, never shell, zero `statSync`):
  allowlisted roots only (`PANEL_SCAN_ROOTS`, default
  `/root,/var/www,/opt,/srv`), max depth 3, 2000 entries per directory,
  20000 budget per root (a huge uploads dir can't starve later roots);
  skips `node_modules/.git/.next/vendor/dist`, never follows symlinks.
  Truncation is flagged (`truncated:true` → scan warning, `complete:false`).
  `ignore_paths` in policy.json hides matching unmanaged projects.
  A project = dir with `package.json`, `ecosystem.config.*`, or
  `composer.json`. Only `package.json` **name** is read. Monorepo children
  collapse under the top dir (within the root) containing `.git`.
- **PM2 dump** (`/root/.pm2/dump.pm2`): app **names only**; everything else
  is discarded and never logged. Flags "running but not in dump" (won't
  return after reboot) and "in dump but not running".
- **Unmanaged processes**: `node`/`next` processes outside every PM2 tree
  (PM2 God daemon excluded). Project resolved via `readlink /proc/<pid>/cwd`.
  Display-only, never killable.

## What scan NEVER reads

`.env` files or values, PM2 process environments, git remotes or git history,
file contents other than `package.json` name, log file contents (only tails
of allowlisted PM2 logs via the Logs button, redacted), SSL keys/certs,
anything outside the allowlisted roots.

## Item schema

`{id, name, kind, status, pids, cpu_pct, rss_b, uptime_s, restarts,
unstable_restarts, ports:[{port,bind,public}], domains:[], cwd, category,
notes, in_dump, actions:[...], logs_enabled}`

- `kind`: `pm2` | `website` | `unmanaged` | `infra` | `panel`.
- `status`: `running` | `stopped` | `errored` | `launching` |
  `unmanaged-running` | `unmanaged-stopped`.
- `id`: PM2 name, else normalized path. New discoveries default to category
  `unclassified`. Display fields (`display_name`, `category`, `notes`) are
  editable via `PATCH /api/apps/:id/meta`; actions come from policy only.
  Action permissions are recomputed from the live policy file at action
  time (a `deny` edit needs no rescan). If policy.json is missing or
  corrupt, the panel fails closed: actions off, all logs off, and
  `policy_error` appears in `/api/overview` (UI banner).
- The panel itself (`PANEL_PM_NAME`, default `vps-control-panel`, or matching
  cwd) is shown as a read-only `panel` row: no actions, ever.
