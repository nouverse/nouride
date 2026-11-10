---
title: Backup, upgrade, uninstall
description: Keeping it running, moving it, and taking it away cleanly.
---

## Is it up?

```bash
curl -fsS @@HEALTH_URL@@
```

```json
{"status":"ok","edition":"basic","appliance":false,"uptime":147,"version":"<version>","agents":6,"install":"a1b2c3d4e5f6","gateways":{"telegram:bot":"connected"}}
```

`status` is `degraded`, and the endpoint answers **503**, when a gateway is dead, when a provider has
failed three times in a row, or when the SQLite WAL has grown past its threshold. It is
`shutting_down`, also 503, while the daemon stops. `issues` lists what is wrong; a gateway that is
only disconnected or reconnecting shows up there without failing the check.
`install` is a hash of the data directory, so a CLI can tell it is talking to the right daemon when two
installs on one machine compete for the port.

**Check this, not just the service state.** `systemctl start` or `launchctl load` returning 0 means a process was
spawned, not that it is serving, a daemon that refuses its config exits *after* systemd reports
success.

```bash
nouride status              # agents, gateways, queue
nouride doctor              # what is wrong, and what to do about it
nouride service status      # which supervisor, and whether exiting gets you respawned
```

## Start, stop, restart

```bash
# Linux / Raspberry Pi
sudo systemctl restart nouride
sudo systemctl stop nouride
sudo journalctl -u nouride -f

# macOS
launchctl kickstart -k gui/$(id -u)/tech.nouverse.nouride        # restart
launchctl unload ~/Library/LaunchAgents/tech.nouverse.nouride.plist  # stop (load -w to start)
tail -f ~/nouride/.nouride/data/nouride.log

# Docker
docker compose restart
docker compose logs -f
```

`nouride restart` works on any of them, and so do **Restart** on the dashboard's Home and
`/daemon-restart` in a chat. All three wait until no turn or approval is in progress, for ten
minutes at most, and until every background job has finished, however long that takes. `--now`
(**Restart now**, `/daemon-restart now`) does not wait, and stops the jobs. They work by **asking
the daemon to exit so its supervisor brings it back**. With nothing supervising it, that is just a
stop, so they refuse with a 409 rather than silently shutting you down. `nouride service status`
answers for the process actually running and says plainly whether anything will respawn it. An agent
restarting the daemon passes `--then "<what to check>"`, so it is woken to check once the daemon is
back.

Inside a container it reports `docker` and refuses for the same reason: the restart policy lives
outside the container. Use `docker restart <container>`.

`nouride stop` is the one command that reaches the daemon without the control API, it reads the lock
file and sends a signal, which is the path that still works when the HTTP server is the thing that
has wedged.

A stop or a restart lets running turns finish the step they are on. Each one closes with what it did
and tells its chat before the daemon goes; see [below](#upgrade).

## Backup

The daemon snapshots its own database weekly, and at boot unless the newest is under a week old,
and keeps the newest `backup_keep` (four by default, a month back) under `data/backups/db/`. Every snapshot is
integrity-checked before it is kept, and one that fails the check is discarded rather than left where a
restore might find it.

Since 0.8.18 the database also holds what the daemon keeps for itself: which agents are asleep, when each alert was
last sent, each external agent's CLI sessions and the accounts added on the Models page. A snapshot, and a restore of
one, carries them with everything else.

`[daemon] backup_dir` puts the scheduled snapshots of the database, the packs, the vault, the config and the skill
pool somewhere else (on a box that runs from an SD card, a USB drive). Name a directory on the drive
(`/mnt/usb/nouride`, not `/mnt/usb`): it is never created, so while the drive is unplugged the snapshots
are skipped and logged, not written onto the card under the empty mount point.

```bash
nouride db backup            # take one now, before you do something risky
nouride db list              # newest first
nouride db verify [file]     # check a snapshot, or the live database
nouride db restore <file>    # put one back (the daemon must be stopped)
```

A snapshot is a single ordinary SQLite file with no sidecars, so recovery does not need these
commands: `cp` it over `data/nouride.db` with the daemon stopped and delete `nouride.db-wal` and
`nouride.db-shm` beside it. `nouride db restore` does exactly that, plus two things worth having,
it refuses to run while the daemon is up, and it moves the database it replaces to
`nouride.db.replaced-<timestamp>` so restoring the wrong snapshot is itself undoable.

> **Why not `cp` of the live file?** Because it looks like it works. The database is three files,
> and everything committed since the last checkpoint is in `nouride.db-wal`. A copy of the main file
> alone opens without complaint and is missing the newest rows, a backup that exists, restores
> cleanly, and is silently behind. The snapshots use SQLite's own `VACUUM INTO`, which is consistent
> against a running daemon.

For the whole install rather than the database alone, stop it first:

```bash
sudo systemctl stop nouride
sudo tar -czf nouride-backup-$(date +%F).tar.gz -C @@INSTALL_DIR@@ .nouride .env
sudo systemctl start nouride
```

On a Mac, the same with `launchctl unload` / `load -w` on `~/Library/LaunchAgents/tech.nouverse.nouride.plist`
around `tar -czf nouride-backup-$(date +%F).tar.gz -C ~/nouride .nouride .env`, no `sudo`.

What is in there, ranked by how much it would hurt to lose:

| | |
|---|---|
| **`memory/`** | what the agents remember: conversations, people, shared facts. Files are the truth here; the search index in the database is rebuilt from them. [Memory →](/en/docs/architecture/memory/) |
| **`agents/`** | `MEMORY.md` above all, each agent's own notes. Months of accumulated identity, not in git |
| **`data/`** | conversations, audit log, standing grants, the secret store, and what the daemon keeps for itself, such as which agents are asleep |
| **`workspace/private/`** | on a Linux service where [each agent is its own user](/en/docs/architecture/overview/#each-agent-its-own-user), each agent's HOME, `workspace/private/<id>/`: its ssh keys, what it installed for itself, its MCP servers' sign-ins, an external agent's CLI sign-ins (`.cli/`), a mission's worktree. Back it up with the rest |
| **`home/`** | the daemon's HOME: ssh keys, CLI logins. On Docker, macOS or without the helper it is every agent's HOME too |
| **`config.toml` and `.env`** | how this install differs from a default one |
| **the secret store's key** | outside `.nouride/` on purpose (0.8.19): root's `/etc/nouride/nouride.env` on Linux, `~/.config/nouride/nouride.env` on a Mac, the container's environment. The store in a backup does not open without it: keep a copy apart from the backup, or set a backup password (below), which recovers the secrets on its own |
| **`workspace/`**, the rest | whatever the agents have built. Output rather than identity, restore it if you want the work back, skip it if you only want the daemon back |
| **`bin/`, `lib/`, `opt/`** | programs the agents installed. Saves reinstalling them, and nothing more |

The daemon also keeps dated copies of the persona packs under `data/backups/agents/` and of the
memory vault under `data/backups/memory/`, and since 0.8.18 of `config.toml`, the people and the MCP library under
`data/backups/config/` and of the skill pool under `data/backups/skills/`. Those are kilobytes of text and recovery is
`cp`, deliberately, it does not need this code to still work. They cover an agent corrupting its own memory, a bad
nightly pass or a config saved wrong; they do not cover a disk.

The secret store is in none of them until you give it a backup password (0.8.18): on the dashboard's **Secrets** page,
under **Backup password**, or from a shell:

```bash
read -rs PASS && printf '%s' "$PASS" | nouride secret seal --stdin; unset PASS
```

From then on each config snapshot holds `secrets.sealed`, which only that password opens, and one is taken at once so
you can check. Since 0.8.19 the copy beside the store, `data/secrets.sealed`, is made again at each change. To put the
secrets back, on a rebuilt box or when the store's key is lost, with Nouride stopped (as root on Linux, as for every
command that opens the store):

```bash
read -rs PASS && printf '%s' "$PASS" | nouride secret restore --stdin; unset PASS     # data/secrets.sealed
read -rs PASS && printf '%s' "$PASS" | nouride secret restore data/backups/config/<time>/secrets.sealed --stdin; unset PASS
```

The store is written again under this install's key, and one it could not open is kept aside as
`secrets.enc.unopened-…`.

Keep the passphrase off the box. Lose it and the sealed copies stay sealed, for you as for anyone who finds the drive.

All of these live under `data/`, which is the directory every deployment shape mounts, so a snapshot
lands wherever you already back up. That also means they are **on the same disk as the thing they
protect**: copy them somewhere else for the failure that takes the disk with it.

## Upgrade

```bash
# Linux / Raspberry Pi / macOS
nouride update --start           # or the dashboard's Update page

# Docker
docker compose pull && docker compose up -d
```

Re-running the installer (`@@INSTALL_CMD@@`) works too. Your database, secrets, agent packs and
workspace in `.nouride/` are left alone either way. [Updating →](/en/docs/deployment/updating/)
From 0.7.x: see [Upgrading to v0.8](/en/docs/deployment/upgrading-to-0-8/).

**An update waits until nothing is running.** `nouride update --start`, the Update page and an
agent's own update restart the way `nouride restart` does: once no turn is running and no approval
is waiting, within ten minutes, and once no background job is working, however long that takes.
What they print names what they wait for, such as "restarting once the background job `make build`
(12m) finishes, however long that takes". A service such as a dev server does not count: it runs
until it is stopped. `--now` restarts at once and stops the jobs.

Background jobs do not survive the daemon going down, in a crash or a stop: the agent is told at
boot which of its jobs were interrupted, and can run them again. That is deliberate. The daemon is
meant to run all day, and a long outage means it was stopped or something is wrong.

**Anyone mid-turn is told.** When the daemon stops, each running turn stops at its next step, keeps
everything it did, and says so in its chat before the daemon goes:

> ⚠️ I was interrupted by a restart while working on "deploy the site". Done: `read site.toml`,
> `git status`. Cut off: `exec ./deploy.sh` (it may have partly run). Everything I did is kept. If
> I'm back within 15 minutes I'll carry on by myself; after that I'll ask you first.

It cannot tell an upgrade from a shutdown, or how long it will be down, so the message says what
each case brings. If the daemon is back within 15 minutes, the agent carries on by itself, once.
After longer than that it does not: the next start asks the chat whether to carry on, once, with a
Continue button where the platform has buttons, and the person says "continue" or presses it. A
turn cut off more than two days ago is not asked about, nor one in a chat the person has written in
since. To stop the work for good, use `/stop`, not a restart.
[What they see →](/en/docs/manual/chatting/)

If the daemon is killed outright instead, `kill -9`, the OOM killer, a power cut, no message can
be sent at the time, so the *next* boot closes those turns the same way and tells the same
conversations once the gateways are up: what was done, what was cut off, and either that it is
carrying on (cut off in the last 15 minutes) or the same question (cut off longer ago). Messages
that arrived while it was down are answered if they were sent in the last 15 minutes.

The service unit gives the daemon 45 seconds to do this, and signals only the daemon, so it can stop
its own commands. A binary install from before 0.7.0 that was updated with `nouride update` still has its
old unit, which kills a running command at once: re-run the installer once to rewrite it. `nouride
doctor` reminds you until you do. With Docker, give the container the same time with
`stop_grace_period: 45s`, as the shipped compose files do.

Migrations run at boot and are compiled into the binary, so there is no separate step and nothing to
remember within 0.8. From 0.7.x, 0.8.0 has to start once first:
[Upgrading to v0.8](/en/docs/deployment/upgrading-to-0-8/). Check afterwards:

```bash
nouride version
nouride doctor
```

## Moving it to another machine

One directory, so this is a copy:

1. Run the installer on the new box, and stop the daemon it starts.
2. Stop the old daemon.
3. Copy `.nouride/` and `.env` across, preserving ownership and modes, `data/` holds `0600` files.
4. Bring the secret store's key (0.8.19), which stays out of `.nouride/` on purpose: the `NOURIDE_ENCRYPTION_KEY` line
   of the old box's `/etc/nouride/nouride.env` in place of the one the installer made on the new box. Or, with a backup
   password set, run `sudo nouride secret restore --stdin` on the new box instead: the secrets are written again under
   its own key. Without either, the new one refuses to start and says which key it needs.
5. Start the new one and run `nouride doctor`.
6. Only then decommission the old one. **Two daemons must not run against the same bot token**: two
   Telegram bots polling one token get half the messages each.

The new box can keep it at another path. Its first start there names under the new folder every path the database
held under the old one: attachments in past conversations, job logs, a mission's folder, the folder an "always allow"
was given for (one given for a command that is handed a secret asks once more). The log says `the install was moved`.
This works for an install that has started on 0.8.18 or later at least once where it was.

`workspace_dir` can point at another disk if that is where the work belongs; nothing else has to
move.

## Renaming a gateway

The one operation that rewrites the config, the database, the agent packs bound to the gateway and
the memory vault together, so it refuses to run while the daemon is up:

```bash
sudo systemctl stop nouride
nouride gateway rename telegram:old telegram:new --apply
sudo systemctl start nouride
```

Without `--apply` it shows what it would change. The vault is snapshotted first, under
`data/backups/memory/<stamp>-before-rename`.

It refuses, before it writes anything, when a message was still waiting or a turn was cut off on the
old name when the daemon stopped (start the daemon, let it answer, stop it and run the rename again),
and when the new name was used before by a gateway since removed, whose rows are still there: pick a
name nothing has used.

## Uninstall

```bash
# Linux / Raspberry Pi
sudo systemctl disable --now nouride
sudo rm /etc/systemd/system/nouride.service /usr/local/bin/nouride
sudo systemctl daemon-reload
sudo rm -rf @@INSTALL_DIR@@          # this deletes your agents and conversations

# macOS
launchctl unload -w ~/Library/LaunchAgents/tech.nouverse.nouride.plist
rm ~/Library/LaunchAgents/tech.nouverse.nouride.plist
rm -f /usr/local/bin/nouride ~/.local/bin/nouride
rm -rf ~/nouride                     # this deletes your agents and conversations

# Docker
docker compose down
rm -rf ./nouride
```

`/usr/local/bin/nouride` is the small launcher the installer puts on `PATH` (on a Mac, a link, in
`/usr/local/bin` or `~/.local/bin`). `nouride service
uninstall` prints the right commands for whichever supervisor you are on.

## Disk, and what grows

`.nouride/workspace/` grows without bound, it is whatever the agents produce. `.nouride/memory/`
grows slowly: verbatim transcripts there are compacted after `[memory] transcript_days` (180).
Everything else ages out on the schedule in `[retention]`: conversations, with the files sent in them,
and audit rows at 30 days, background-job logs at 14, the daemon's own log and scratchpads at 3,
oversized tool output at 2. Scheduler runs go after `[cron] run_retention_days` (3).

The daemon watches its own disk: under 1 GB free raises an alert rather than only logging, and
`/health` reports degraded once the SQLite WAL passes 100 MB. Both are fixed values since 0.8.0.

## Alerts

Set these before you walk away from it:

```toml
[alerts]
gateway = "telegram:nouva"
chat_id = "123456789"
```

Without them a dead gateway is only a line in the log, so you find out when you notice the agent has
gone quiet, hours later, looking like a different problem. Boot warns when chat gateways are enabled
and this is empty.
