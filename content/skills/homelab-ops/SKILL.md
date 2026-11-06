---
name: homelab-ops
description: Keep a home server, NAS, Raspberry Pi, Proxmox host or this box healthy (disk full, memory, load, failed or crash-looping services, journal errors, Docker/Podman containers restarting, ZFS/RAID/SMART disk health, temperatures, expiring certificates, stale backups, pending updates and reboots). One helper gives a ranked health report, here or over ssh, and a daily check that speaks only when something is wrong. Use when asked to check, monitor or fix a server ("server lemot", "disk penuh").
requires: python3
needs_tools: exec, read
author: Nouride
---

# Looking after a home server

A home server rarely breaks in one go. A disk fills over weeks, a service crash-loops quietly, a certificate renewal
stopped two months ago, the backup job has not written anything since a mount dropped. The job is: **look at
everything once, rank what is wrong, show the person the few things that matter, fix the safe ones, ask about the
rest.** A script ships beside this file that does the looking in one command, so you do not run twenty commands and
read their output yourself.

## This machine

Light. The check peaked under 80 MB (measured on a Linux box), so it runs on a 512 MB board, and the machines it
watches are often that small. Over ssh, the work is on the other machine.

## Where the script is

The SKILLS list gave you this file's path, ending in `homelab-ops/SKILL.md`. The script is `scripts/health.py` in
that same directory. Below, `HEALTH` stands for its full path. Write the full path in each command, e.g.
`python3 /srv/nouride/skills/homelab-ops/scripts/health.py`.

It needs only `python3` (3.8 or newer, standard library) and takes a few seconds; run it in the foreground, not as a
background job. It changes nothing: it reads, and runs read-only commands
(`systemctl`, `journalctl`, `apt-get -s`, `docker ps`, `zpool status`, `smartctl -H`). A check whose tool is missing
is listed under "not checked" with the reason, never silently passed. It masks passwords and tokens that appear in
log lines. It always exits `0` once it ran (so a scheduler does not count a problem as its own failure); `1` is a
wrong option.

## Run it

| Where | Command |
|---|---|
| this machine | `python3 HEALTH` |
| another machine you reach by ssh (see the `network-reach` skill) | `ssh nas 'python3 - ' < HEALTH` (the script is sent over ssh; nothing is copied or installed there) |
| with options, remotely | `ssh nas 'python3 - --backup /mnt/backup/restic --cert nas.home.arpa:5001' < HEALTH` |
| as root, to see SMART, `/etc/letsencrypt` and every container | `sudo python3 HEALTH` here, `ssh nas 'sudo -n python3 -' < HEALTH` there (only if sudo needs no password) |
| only some checks | `--only disk,memory,containers` (names: disk, memory, load, systemd, journal, containers, storage, temps, certs, backups, updates, clock, dns, ports) |
| machine-readable | `--json` |

The machine must have `python3`. Most Linux servers, Proxmox and Synology DSM 7 do; a router or a minimal container may
not. Then run the single commands in `references/fixes.md` by hand. Windows is not covered by this script.

Options worth knowing: `--backup PATH[=HOURS]` (repeatable) warns when the newest file under PATH is older than HOURS
(36 by default). Give it every backup destination the person has. `--cert HOST[:PORT]` checks a site's certificate
from outside. `--ignore TEXT` drops a finding the person has accepted ("wakatime", "ports"). `--hours N` sets how far
back the journal is read (24). `--help` lists the thresholds.

## Read the report

```
health of nas (Debian GNU/Linux 12 (bookworm)) at 2026-11-01 08:00 +0700: 1 critical, 2 warnings, 1 notes (6s)
CRIT  disk: /srv is 96% full: 38.2 GB free of 916.7 GB
      more: du -xh --max-depth=1 '/srv' 2>/dev/null | sort -h | tail -15
WARN  services: backup-sync.service is crash-looping: restarted 4120 times and starting again
      more: systemctl status backup-sync.service --no-pager; journalctl -u backup-sync.service -b -n 30 --no-pager
WARN  updates: 12 security updates pending (openssl, libssl3, ...), 40 updates in all
      more: apt list --upgradable 2>/dev/null | head -40   # installing is the person's call
INFO  ports: listening on every interface: 22/tcp sshd, 8096/tcp jellyfin
fine: 3 filesystems checked; memory 5.1 GB available of 8.0 GB; ...
not checked: smart (smartctl not installed ...)
```

- Lines are ranked: `CRIT` (act today: data or service at risk), `WARN` (act this week), `INFO` (worth knowing).
- **Each problem's `more:` line is the next command to run.** Run it before you explain or fix anything, because
  the report says *what*, and `more` says *why*. One `more` per problem, the top problems first.
- "in a container" in the first line means an LXC or Docker container: disks' SMART, temperatures and the kernel's
  memory limits belong to the host. Say so, and check the host if you can reach it.
- "not checked" is part of the answer: "SMART was not checked because smartmontools is not installed" is a fact the
  person needs, not a detail to drop.

Tell the person in plain words, worst first, at most five lines, with numbers from the report: *"Disk /srv hampir
penuh (96%, sisa 38 GB). Yang paling besar folder /srv/media/downloads 610 GB. Layanan backup-sync gagal terus
sejak tadi pagi, sudah 4120 kali mencoba. Ada 12 update keamanan."* Then say what you suggest, and what you need them
to decide. Never paste the whole report unless they ask.

## Fix it: what you may do, and what you ask first

The full playbook per problem (the commands that find the cause and the fix for each) is in `references/fixes.md`
beside this file. Read the section for the problem before acting. The rule for all of them:

| Safe to do when the person asked you to fix it | Ask first, with exactly what it will remove or restart |
|---|---|
| read anything: logs, status, `du`, `docker logs`, `smartctl -a` | **deleting** any file, log, image, volume, snapshot or backup |
| `apt-get clean` (only downloaded package files) | `journalctl --vacuum-size=…` (deletes old logs) |
| `systemctl reset-failed UNIT` (clears the red mark, nothing restarts) | `systemctl restart/stop/disable UNIT`, `docker restart`, `docker compose up -d` |
| `certbot renew --dry-run` (tries renewal against the test server, changes nothing) | `certbot renew`, reloading a web server |
| `docker system df`, `docker image ls --filter dangling=true` (what *could* be freed) | `docker image prune`, `docker system prune` (and never `-a` or `--volumes` without the person naming them) |
| `apt list --upgradable` | `apt upgrade`, `apt autoremove`, a reboot, `zpool scrub`, any change to `/etc` |

The person's "yes" covers what you described, not more. When a fix needs several steps, describe them all at once
and get one yes, rather than asking at every step.

**Never**, whatever the request:

- `rm -rf` anything. To free space, find the biggest items, show the list, and delete the exact files the person
  agreed to, by their full paths, never with a wildcard you have not listed.
- Restart, stop or upgrade the Nouride daemon itself (`nouride`, its service, its container) from inside a turn: you
  are running inside it, and the turn dies with it. Updates of Nouride go through its own `update` tool.
- Reboot the machine you are running on, or stop its network, or change its firewall or ssh settings: you cut off
  the only way to report back. Say what is needed and let the person do it.
- `kill -9` a process you have not identified, `chmod -R`/`chown -R` on a system path, edit `/etc/fstab`, or run
  `zpool clear`, `zpool replace`, `mdadm --remove`, `fsck` on a mounted filesystem, or `dd`. These lose data when
  they are wrong. Explain and let the person (or a specialist) decide.
- Hide a problem to make the report clean: `--ignore` is for what the person has accepted, not for what you could
  not fix.

## A daily check that speaks only when something is wrong

A Nouride scheduled job runs the script every morning; `--quiet` makes it print nothing when there is no CRIT or WARN,
and a `--command` job with no output delivers nothing: no message, no model call, no cost. Something wrong → the
report arrives in the chat as it is. Set it up when the person asks to be warned, after saying what it will run:

```sh
nouride cron add --name server-health --cron "0 7 * * *" --tz Asia/Jakarta \
  --command "python3 /srv/nouride/skills/homelab-ops/scripts/health.py --quiet"
```

- From a chat you run it through the `nouride` tool: `--gateway`, `--chat` and `--agent` default to this
  conversation. A `--command` job asks the person for approval when you create it, because it later runs with no model
  and no gate. That approval is expected.
- Use the script's real path from your SKILLS list (`/opt/nouride/skills/...` on some installs).
- For another machine: `--command "ssh nas 'python3 - --quiet' < /srv/nouride/skills/homelab-ops/scripts/health.py"`
  (the `ssh nas` entry must work without a password; see `network-reach` §4).
- Add `--backup PATH` for their backup destinations and `--ignore TEXT` for what they have accepted, so the job does
  not cry wolf every morning. A check that always complains gets ignored.
- With `--then agent` added, you are woken with the report and can explain it instead of passing it on raw. A quiet
  run prints nothing and wakes nobody, so a model call is spent only on a morning something is wrong.
- Check it once: `nouride cron run <id>` fires it now; `nouride cron runs <id>` shows what happened.

## Questions people actually ask

| They say | Start with |
|---|---|
| "server lemot" / slow | `python3 HEALTH --only load,memory,disk,storage,containers`, then `top`/`ps` from the `more` lines; `references/fixes.md` § Slow |
| "disk penuh" / out of space | `--only disk,containers`, then `du` on the full mount; § Disk full |
| "website/X tidak bisa dibuka" | `systemctl status X`, `docker ps -a`, `ss -ltnp`, `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:PORT/`; § A service is down |
| "backup jalan?" | `--only backups --backup <their path>`, and the backup tool's own log; § Backups |
| "aman nggak?" / is it OK | the full report, top five lines |
| "update dong" | the update section: list, explain, then ask; § Updates |
