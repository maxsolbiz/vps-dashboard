# DEPLOY — DRAFT (do not execute without separate sign-off)

Read-only first deploy behind an SSH tunnel. No step here touches firewall,
SSH config, or any app port.

## 0. Prerequisites (separate approvals, see HARDENING.md)

- GitHub tokens revoked (H1), Cloudflare scope checked (H2).
- `/tmp/pm2j.json` deleted (H3, approved command: `rm -- /tmp/pm2j.json`).
- Never reuse any password that appeared in a chat transcript.

## 1. Build the tarball (local, on this machine)

```powershell
Set-Location D:\Dashboard-VPS
npm ci --omit=dev
# single dependency, pure JS: fastify (see package.json)
# Build + verify in one step (fails on banned/missing files):
node scripts/pack.js
```

`pack.js` writes `vps-panel.tar.gz` with code + `node_modules` +
`data/policy.default.json` + `data/overrides.default.json` only.
It never ships dev-fixtures, tests, `users.json`, `audit.jsonl`, or
`last-scan.json`, and it excludes stray `.claude`/test/benchmark dirs
inside `node_modules`. It then extracts the tarball to a temp dir, runs
`node --check`, and boots the extracted copy read-only against fixtures:
health check, `create-admin`, login, and `POST /api/scan` must all pass.

No `npm install` on the VPS: `node_modules` ships inside the tarball.
No native modules exist in the tree (no better-sqlite3/bcryptjs);
passwords use `node:crypto` scrypt, storage is `users.json`/`audit.jsonl`.

## 2. Copy + unpack (on the VPS, approved window)

```sh
scp -i "$env:USERPROFILE\.ssh\meezan_vps" vps-panel.tar.gz root@178.105.109.19:/root/
```

```sh
mkdir -p /root/vps-panel && tar --no-same-owner -xzf /root/vps-panel.tar.gz -C /root/vps-panel && node --check /root/vps-panel/server.js
```

## 3. PM2 entry (loopback only, actions OFF)

`ecosystem.config.js` in the repo sets `HOST=127.0.0.1` and `PORT=8787`
(no `ACTIONS_ENABLED` there anymore), plus `max_memory_restart: 256M`.
Start it under PM2 as `vps-control-panel`. On first boot the server
copies `data/policy.default.json` to `data/policy.json` (and the same
for overrides) only if the live files are missing, so later redeploys
never overwrite your settings.

## 4. Create the admin (on the box, interactive terminal only)

```sh
cd /root/vps-panel && node scripts/create-admin.js
```

Hidden password prompt, refuses if a user exists, min 12 chars.
Nothing in env/argv/HTTP. Run from an interactive SSH session with a TTY.

## 5. Access via SSH tunnel only

```sh
ssh -i "$env:USERPROFILE\.ssh\meezan_vps" -N -L 8787:127.0.0.1:8787 root@178.105.109.19
```

Open `http://127.0.0.1:8787` in the browser.

Verify: login works, SCAN VPS lists all apps, overview shows
MemAvailable-based RAM, audit log records the login + scan.

## 6. Enable actions later (separate approval)

Edit `/root/vps-panel/data/policy.json` and set `actions_enabled: true`.
No restart needed: the panel reads the policy live on every action, and
a missing or corrupt file fails closed (actions off, logs off, UI banner).
Keep the `ACTIONS_ENABLED` environment variable unset; setting it to
`false` is an emergency kill-switch only.

Suggested first live action: restart `telegram-bot` (low impact). Then
close public ports one app at a time (H5), and finally the planned
reboot + SSH key-only window (H4/H7) with the Hetzner console open.