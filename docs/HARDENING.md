# HARDENING CHECKLIST — each item needs its own explicit sign-off

```text
STANDING RULES (permanent)
- NEVER run or edit ufw, iptables, nftables, fail2ban, or sshd_config, and never touch port 22 or any app port rule.
- No VPS command that writes, deletes, restarts or reloads anything without my written approval of that exact command.
- Never print git remotes, .env values, or unredacted pm2 jlist/env/describe output. No writes to /tmp.
- From infra.env use only VPS_HOST and SSH_KEY_PATH.
```

Nothing below has been executed. Every item touches the live server or a
credential, so each one is approved and applied separately.

## H1 — Rotate leaked GitHub tokens (CRITICAL)
- The `meezan-bank` and `taskbloom` git remotes contain embedded personal
  access tokens (seen via `git remote get-url origin` during audit).
- Revoke both at GitHub → Settings → Developer settings → Personal access tokens.
- Check the GitHub audit log for unexpected use.
- On the VPS (separate approval): rewrite remotes to SSH like the other repos,
  e.g. `git remote set-url origin git@github.com:<org>/<repo>.git`.
- Rule for future runs: from `infra.env` use ONLY `VPS_HOST` and `SSH_KEY_PATH`;
  never print other values; redact remotes with
  `sed -E 's#//[^@/]+@#//***@#'`.

## H2 — Cloudflare token scope check
- The token in local `infra.env` entered an AI session. Confirm it is scoped to
  only the zones/records it needs, or rotate it in the Cloudflare dashboard.

## H3 — Remove audit artifact /tmp/pm2j.json
- `ls -l` shows `-rw-r--r--` (world-readable), ~44 KB, contains full process
  environments which may include secrets. Created by the audit itself.
- Worse than "low": anything running as `www-data` (e.g. the PHP app) can read it.
- APPROVED, not yet executed (no VPS contact in the local-build task):
  `rm -- /tmp/pm2j.json`.

## H4 — PM2 reboot persistence (UNPROVEN, needs a planned reboot test)
- CORRECTION to an earlier claim of "broken": the unit is enabled,
  `ExecStart` is `pm2 resurrect`, and `dump.pm2` was refreshed at 01:12 the
  morning of the audit. A reboot will probably bring the apps back, but nobody
  has tested it.
- Do NOT test with `systemctl restart pm2-root` on the live box: standard PM2
  units include `ExecStop=pm2 kill`. Read the full unit first with
  `systemctl cat pm2-root` (read-only).
- The real test is a planned reboot in a quiet window with the Hetzner web
  console open, combined with the SSH key-only change (H7) in one window.

## H5 — Bind 3000/3002/5000 to 127.0.0.1 (one app at a time)
- VERIFIED public binds: `*:5000` (meezan-backend), `*:3000` (hbl-pwa),
  `0.0.0.0:3002` (event-invoice-frontend).
- VERIFIED: Apache proxies to all three via 127.0.0.1; only Apache-local
  traffic observed at sample time; no remote ESTAB to those ports seen.
- NOT YET PROVEN: nothing else calls them directly (local ledger path
  `D:\APK\central-ledger` was missing, so the cross-check is UNVERIFIED).
- `club-mgt-web` and `sitara-web` already use `-H 127.0.0.1` — same pattern.
- Order: event-invoice-frontend (`HOSTNAME=127.0.0.1` in start-frontend.sh),
  then meezan-backend, then hbl-pwa (domain changed, re-verify first).

## H6 — Firewall: do NOT `ufw enable`
- A lockout needs console recovery. Leave port 22 alone.
- Check the Hetzner Cloud Firewall in the web console first; if one already
  covers the box, host ufw adds risk for no benefit.

## H7 — SSH posture (do LAST, with console open)
- VERIFIED: `PermitRootLogin yes`, `PasswordAuthentication yes`,
  `PubkeyAuthentication yes`; fail2ban inactive; ~215 MB of failed-login
  records ≈ 10,000 attempts/day. Root+password with no fail2ban is real exposure.
- Fix with key-only login, NOT fail2ban (fail2ban is a firewall-class change).
- Confirm current logins first (read-only): `last -i | head` and failed/successful
  password counts from the ssh journal.
- Do this last, with the Hetzner console open and a second session still logged
  in. Use a drop-in file that sorts before cloud-init's (first match wins),
  e.g. `00-hardening.conf`, then `sshd -t`, then `systemctl reload ssh`, then
  test a brand-new session before closing the old one. Separate approval.

## H8 — Disk reclaim (3+ GB, low risk)
- VERIFIED: journald 3.1 GB → `journalctl --vacuum-size=500M` (approved window).
- btmp 98 MB + 117 MB → rotate/clear after confirming no forensics need.

## H9 — PM2 memory caps + restart backoff
- Restart counts (hbl-pwa 337, meezan-backend 282) are deploy/manual restarts,
  NOT crashes: `unstable_restarts` is 0 everywhere (selfie-purge: 1, cron job).
- Still worth adding per-app `max_memory_restart` (256–512 MB) and
  `exp_backoff_restart_delay` in a staged change.

## H10 — Panel deployment (after local tests pass)
- Deploy to `/root/vps-panel`, run under PM2 on 127.0.0.1:8787,
  `ACTIONS_ENABLED=false` initially; access via
  `ssh -L 8787:127.0.0.1:8787 root@<host>`.
- Enable actions only after login + audit-log verified working.
- RISK NOTE: the panel process runs as root under PM2 because it must reach
  root's PM2 daemon — it is effectively root over all apps. Mitigations:
  tunnel-only access, registry allowlist, per-app actions, typed stop
  confirmation, audit log, no shell, no `pm2 save` from the panel.
- First live action (after read-only deploy verifies): restart `telegram-bot`
  (low impact). Then close public ports one at a time (H5).
