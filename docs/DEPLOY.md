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

Master switch is the live policy file (one edit, no restart):

```sh
ssh -i "$env:USERPROFILE\.ssh\meezan_vps" root@178.105.109.19 \
  "sed -i 's/\"actions_enabled\": .*/\"actions_enabled\": true,/' /root/vps-dashboard/data/policy.json"
```

Set it back to `false` to lock the panel down again. A missing or corrupt
policy fails closed (actions off, all logs off, red banner in the UI).
`ACTIONS_ENABLED=false` in the environment is an emergency kill-switch only;
it is deliberately absent from `ecosystem.config.js`.

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
