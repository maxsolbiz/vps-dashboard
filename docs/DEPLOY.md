# DEPLOY — VPS Control Panel

Live at `https://vps.maxsolbiz.com` (Apache → `127.0.0.1:8787`).
Code lives in `git@github.com:maxsolbiz/vps-dashboard.git`, checked out on the
server at `/root/vps-dashboard` and run by PM2 as `vps-control-panel`.

## 0. Daily flow (git push → deploy.sh)

Local:

```powershell
Set-Location D:\Dashboard-VPS
# edit, then:
npm test
git add -A && git commit -m "..." && git push origin main
```

Server (pulls, installs only if `package-lock.json` changed, syntax-checks,
reloads the panel only, then health-checks):

```sh
ssh -i "$env:USERPROFILE\.ssh\meezan_vps" root@178.105.109.19 "bash /root/vps-dashboard/scripts/deploy.sh"
```

`deploy.sh` is manual only: no cron, no webhook. It aborts before restarting
anything if the pull or `node --check` fails, and prints a rollback command if
the health check fails.

## 1. Enabling or disabling actions

Two switches, both in `/root/vps-dashboard/data/policy.json` (read live, no
restart). Never edit this file from the panel; the panel only writes
`overrides.json`.

**Master switch** — off by default:

```sh
ssh -i "$env:USERPROFILE\.ssh\meezan_vps" root@178.105.109.19 \
  "sed -i '/actions_enabled/s/false/true/' /root/vps-dashboard/data/policy.json"
```

Set it back to `false` when finished. `ACTIONS_ENABLED=false` in the
environment is an emergency kill-switch only; it is deliberately absent from
`ecosystem.config.js`.

**Allow list** — an app with no entry gets **no actions at all** (fail-closed,
so new or renamed apps are inert until you list them):

```json
"allow": { "telegram-bot": ["restart"] }
```

Effective actions = allow entry ∩ `default_actions` − `deny[app]`. A missing or
malformed `allow` blocks everything. `stop` additionally requires typing the
app name. The panel never appears in `allow` and is always protected.

## 1a. Rehearsal checklist (do this the first time, and rehearse before real work)

- [ ] Read `docs/HARDENING.md` H11, then add **only** the apps you intend to
      touch to `allow`, keeping `stop` out unless you truly mean it.
- [ ] Confirm the target's real state first (`pm2 describe <name>`, its logs,
      any in-process schedulers like hbl-pwa's `[backup-scheduler]`).
- [ ] Set `actions_enabled: true`. Do the work. Set it back to `false`.
- [ ] **Stop order: web → API → worker.** Never the reverse.
- [ ] **Start order: worker → API → web**, one app at a time, ~30 s between
      each. Two cores handle a Next.js cold start badly if several start at once.
- [ ] For apps started via `npm start` (hbl-pwa is one): after a stop, run
      `ss -ltnp | grep :<port>`. **It must be empty before you press Start**, or
      the start can fail with "address in use". PM2 usually kills the whole
      tree, so this is a verification, not a cleanup.
- [ ] After a stop, a proxied domain returns **503** from Apache — that is the
      expected signal, not a new fault.
- [ ] A stop is **not permanent across reboots**: PM2 restores from the dump
      saved earlier, which had everything online. Run `pm2 save` yourself only
      when you *want* a stop to survive a reboot.
- [ ] Never start `meezan-selfie-purge` until someone has read what it does
      (a scheduled retention/purge job). Never stop `meezan-backups` (the live
      database backup scheduler).
- [ ] Logs for `meezan-*`, `hbl-*` and `telegram-bot` are disabled in the panel
      by policy — use SSH to read them.

## 2. Rollback

Code — previous commit, then reload:

```sh
cd /root/vps-dashboard
git log --oneline -5                 # find the good commit
git checkout <sha>
pm2 startOrReload ecosystem.config.js --only vps-control-panel --update-env
```

**After a `git checkout` the repo is in detached HEAD and `git pull --ff-only`
will fail.** Before the next deploy, return to the branch:

```sh
cd /root/vps-dashboard && git checkout main && git pull --ff-only origin main
```

Apache — take the public site offline:

```sh
a2dissite vps.maxsolbiz.com-le-ssl vps.maxsolbiz.com && apachectl configtest && systemctl reload apache2
```

Full Apache restore (from the pre-deploy backup):

```sh
tar -xzf /root/apache-backup-20260924.tar.gz -C /
apachectl configtest && systemctl reload apache2
```

The panel itself stays reachable over the SSH tunnel (`ssh -L 8787:127.0.0.1:8787`)
even with Apache changes.

## 3. Rotating the Basic Auth password

Run it yourself; the prompt does not echo. **No `-c`** on an existing file
(`-c` would truncate it):

```powershell
ssh -t -i "$env:USERPROFILE\.ssh\meezan_vps" root@178.105.109.19 "htpasswd -B /etc/apache2/.htpasswd-vps vpsadmin"
```

Check the mode afterwards (expect `640 root www-data`):

```sh
ls -l /etc/apache2/.htpasswd-vps
```

To add a second user, run the same command with a different username. Basic
Auth has no lockout of its own, so use a long random password (24+ chars).

## 4. Rotating the deploy key

1. On the VPS, generate a new key and show only the public half:
   ```sh
   ssh-keygen -t ed25519 -f /root/.ssh/vps_dashboard_deploy -N "" -C "vps-dashboard-deploy" -q
   cat /root/.ssh/vps_dashboard_deploy.pub
   ```
2. Add that public key in GitHub → repo → Settings → Deploy keys (read-only),
   then delete the old key.
3. Verify: `ssh -T git@github-vps-dashboard`.

Never edit `authorized_keys`; the deploy key is outbound-only.

## 5. Certificate renewal

Issued with `certbot certonly --webroot -w /var/www/acme-vps -d vps.maxsolbiz.com`.
Auto-renew runs via `certbot.timer` (enabled, active). This cert uses webroot,
so a per-certificate deploy hook reloads Apache after renewal:

```text
/etc/letsencrypt/renewal/vps.maxsolbiz.com.conf → renew_hook = systemctl reload apache2
```

**Deploy hooks are skipped during `--dry-run`**, so the reload is only proven at
the first real renewal (~30 days before the 2026-12-23 expiry). Check it then:

```sh
echo | openssl s_client -connect vps.maxsolbiz.com:443 -servername vps.maxsolbiz.com 2>/dev/null | openssl x509 -noout -enddate
```

The date Apache serves must be the new one. Manual dry-run proof:

```sh
certbot renew --dry-run --cert-name vps.maxsolbiz.com
```

The ACME path is deliberately excluded from the HTTP→HTTPS redirect, which is
what makes renewal work behind Basic Auth.

## 6. Notes and gotchas

- `vps.maxsolbiz.com` DNS must stay **DNS-only (grey cloud)**. An orange cloud
  would break the ACME challenge and hide the real client IP from Apache logs.
- The `happ.task-rewards.com` and `happ.finetechs.online` vhosts still exist but
  those names have no DNS records. When hbl-pwa moves to a new domain, create
  the DNS record **before** the vhost and the certificate request.
- Apache is only ever `reloaded`, never restarted. Always run
  `apachectl configtest` first and roll back with `a2dissite` if it fails.
- The panel binds `127.0.0.1:8787` only; never open that port.
- Old tarball flow: `/root/vps-panel` and `/root/vps-panel.tar.gz` still exist
  as rollback references. Cleanup candidates, not yet removed.
