---
title: Server & systemd
description: Putting the daemon on a Linux box properly, the service account, the unit, and the hardening.
---

The short way is one command:

```bash
@@INSTALL_CMD@@
```

It does everything on this page. What follows is what it does, for when something goes wrong or the
machine is unusual enough that you want to drive it yourself.

## Native or Docker?

The choice is not about convenience.

| | Native (systemd) | Docker |
|---|---|---|
| Agent can run commands on the host | **yes**: that is the point | only inside the container |
| Blast radius of a bad command | the host, bounded by unit hardening and the exec policy | the container |
| Where `exec` lands | your actual machine | a filesystem that disappears |
| Restarts on crash / reboot | systemd | the image's entrypoint, then the container's restart policy |

**Pick native if you want an agent that can do things on your machine.** Pick Docker if you want one
that talks and reads, isolated from the host it happens to run on.

Running the native shape is the reason the exec permission model exists. Running Docker and then
bind-mounting your home directory into it gets you the risk of native with the illusion of isolation.

**Not on memory grounds**: the two measure within ~10 MB of each other.

## 1. A user that is not you, and not root

```bash
sudo useradd --system --no-create-home --home-dir @@INSTALL_DIR@@/.nouride/home --shell /usr/sbin/nologin nouride
sudo mkdir -p @@INSTALL_DIR@@ && sudo chown -R nouride:nouride @@INSTALL_DIR@@
```

`nouride service install` **refuses to generate a unit that runs as root.** This daemon executes
commands chosen by a language model, reachable from a chat app; every other boundary in it, the exec
policy, the workspace sandbox, the `0600` file modes, assumes an unprivileged account. `sudo` is on
the never-grantable list precisely so escalation is a per-command human decision, and running as root
makes it the default.

The one exception is a machine dedicated to the agent, whose whole job is to be operated by it.
`--privileged` writes a unit without the sandbox (`ProtectSystem`, `NoNewPrivileges` and the rest)
and lets it run as root: the agent can then install packages, manage services and run containers,
gated by the exec policy alone. It is never a default.

On an ordinary install, if you turn it on, agents can still install system packages from your own repositories,
asking you each time unless an agent is `trusted`: see [System packages](/en/docs/deployment/system-packages/).

A separate user also means `ProtectHome=read-only` in the unit protects *your* home directory rather
than the daemon's own.

The installer adds the account you ran it from with `sudo` to the `nouride` group, so `nouride`
works for you without `sudo` once you log in again, or after `newgrp nouride`.

## 2. The binary and its files

```bash
sudo -u nouride tar -xzf /tmp/nouride-linux-x64.tar.gz -C @@INSTALL_DIR@@
sudo -u nouride install -m 600 /dev/null @@INSTALL_DIR@@/.env
sudo -u nouride install -d -m 700 @@INSTALL_DIR@@/.nouride/home @@INSTALL_DIR@@/.nouride/home/.ssh
```

The binary belongs to the service account, which is what lets `nouride update` replace it without
root. It also means every command an agent runs could rewrite it, so **do not link it into
`/usr/local/bin`**: root would then be running a file the agents can change. The installer puts a
small launcher there instead, owned by root. Run by root, it runs the CLI as the service account; run
by anyone else, as themselves. Without it, run the CLI as the account:
`sudo -u nouride @@INSTALL_DIR@@/nouride …`. `nouride doctor` warns about a link.

The unit points `HOME` at `.nouride/home` (see below), and the daemon does not create it on its own
when `HOME` already names it. The installer does this step for you.

`.env` holds provider keys and bot tokens. It is `0600`, owned by the service account, and referenced
from the unit as `EnvironmentFile=`: **never** as `Environment=`. Unit files are world-readable, get
committed, and get pasted into issue reports; a key in `Environment=` is a leaked key.

The secret store's key (0.8.19) is one file further out: root's `/etc/nouride/nouride.env`, `0600`, which the unit
names after the install's `.env` as `EnvironmentFile=-/etc/nouride/nouride.env`. systemd reads it as root before it
starts the service, so the service account never reads the file and a copy of the install carries no key. Run by
root, the `nouride` launcher hands the key to the CLI in its environment, so `secret decrypt`, `secret restore` and
`update --rollback` open the store as the service does. [Secrets →](/en/docs/architecture/storage/#secrets)

## 3. Set it up

The daemon boots with **no configuration at all**, so this step is optional, the browser can do it.
Over SSH:

```bash
cd @@INSTALL_DIR@@
sudo -u nouride ./nouride setup
```

`setup` turns the directory it runs in into an install, hence the `cd`. Other commands find the
install from anywhere once it has a `config.toml`.

[The flags, and why there is no `--api-key` →](/en/docs/start/first-run/#doing-it-over-ssh-instead)

## 4. The unit

```bash
cd @@INSTALL_DIR@@
sudo -u nouride ./nouride service install --user nouride --dir @@INSTALL_DIR@@
```

That **writes** `@@INSTALL_DIR@@/nouride.service` and prints the commands to activate it. It does not
install or enable anything: enabling a system service is a privileged, host-changing action, and a
CLI you cannot safely run to see what it would do is a CLI you end up not running.

Read the file, then:

```bash
sudo cp @@INSTALL_DIR@@/nouride.service /etc/systemd/system/nouride.service
sudo systemctl daemon-reload
sudo systemctl enable --now nouride
journalctl -u nouride -f
```

### What it does beyond `Restart=always`

| | |
|---|---|
| `ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, and the kernel and namespace protections | The daemon runs arbitrary commands by design, which is exactly why the blast radius of *the daemon itself* should be bounded |
| A private `/tmp` and `/var/tmp` via `TemporaryFileSystem=`, sized from the machine | A tmpfs is RAM; the size stops a large clone into `/tmp` from eating it. Falls back to `PrivateTmp=true` where the size cannot be worked out |
| `ReadWritePaths=@@INSTALL_DIR@@` | The necessary exception. `ProtectSystem=strict` makes everything read-only, so without this the daemon cannot write its own database and dies at boot |
| `Environment=HOME=@@INSTALL_DIR@@/.nouride/home` | `ProtectHome=read-only` leaves the service user's real home unwritable, and ssh, git and CLI logins all want to write there. Since 0.6 it is inside `.nouride/`, so copying that directory moves the agents' keys and logins with it |
| `After=network-online.target` | Chat gateways and LLM endpoints are all remote; starting earlier just fills the journal with a reconnect storm |
| `StartLimitBurst=5` within `StartLimitIntervalSec=120` | A config the daemon refuses would otherwise restart it for ever, and `systemctl status` would keep saying "activating". After five failures in two minutes it stays `failed`, with the reason in the journal; `systemctl reset-failed nouride` once it is fixed |
| `KillSignal=SIGTERM` to the daemon alone (`KillMode=mixed`), `TimeoutStopSec=45` | On a stop, running turns finish their current step and say what they did, then the daemon stops its own processes in order. The default signalled every process at once, so the command a turn was running died first. 45 s covers the daemon's 30 s drain |
| An `ExecStartPre=` update guard | While an update is unconfirmed, it counts the starts, and on the fourth it puts the previous version back. It lives outside the binary because a new binary that crashes at once cannot rescue itself |
| `MemoryHigh` at 80% of the machine | A **soft** ceiling for the daemon and everything it runs |
| `Delegate=yes` (since 0.7.19) | The daemon splits its cgroup at boot: itself, its memory protected and first on the CPU, and every command an agent runs (`exec`, background jobs, terminal sessions, MCP servers), capped below `MemoryHigh`. A command that outgrows the cap is what the kernel stops, alone. Before, it held the whole unit at the ceiling and the kernel throttled the daemon with it until nothing answered. On systemd 257 and later the cgroup filesystem is the daemon's own view of it (`ProtectControlGroups=private`); before 257 that line is left out, since it would make the daemon's own cgroup read-only |

`MemoryHigh` is written as an absolute number computed at install time, **not** `80%`: inside an LXC,
systemd resolves a percentage against the *host's* memory, and on a 2 GB container of a 62 GB node
that came out as 49.8 GB.

Commands the agent spawns also run at `nice 10`, so a build yields the CPU to a turn rather than
making every chat go silent until it finishes.

`nouride doctor` says how much the commands may hold together. A unit written before 0.7.19 does not
hand its cgroup over: doctor warns, and re-running the install script rewrites the unit and leaves
`.nouride/` alone. Docker has no unit to hand a cgroup over: give the container a memory limit, and
the commands are still what the kernel stops first.

### Each agent its own user

`service install` also writes the units of `nouride-run`, the root helper that runs each agent's commands as its own
user, `nr-<agent>`: `nouride-run.socket` and `nouride-run@.service`, beside `nouride.service`, with the commands that
copy them in. The helper itself has to be in place first. `install.sh` does it in its step "Each agent its own user";
by hand, as root:

```bash
sudo groupadd --system nr-agents
sudo groupadd --system nr-creds
sudo usermod -aG nr-agents nouride
sudo install -d -o root -g root -m 755 /usr/local/lib/nouride-run
sudo install -o root -g root -m 755 @@INSTALL_DIR@@/run/nouride-run /usr/local/lib/nouride-run/nouride-run
```

Then give `.nouride/bin`, `lib` and `opt`, and what is in them, to the group `nr-agents` to read and run, their folders
setgid, as that step does, and enable `nouride-run.socket` before the daemon starts: boot asks it once whether
agents' commands run as their own users.
Without the helper, every agent's commands run as `nouride`, and boot and `nouride doctor` say so.
[Each agent its own user →](/en/docs/architecture/overview/#each-agent-its-own-user)

## 5. Check it

```bash
systemctl status nouride
nouride doctor
nouride status
curl -fsS @@HEALTH_URL@@
```

**Check `/health`, not just the service state.** `systemctl start` returning 0 means the process was
spawned, not that it is serving, a daemon that refuses its config exits *after* systemd reports
success. While it boots, `/health` answers 503 `starting` with the step it is on, so `curl -f` waits
for the end of boot.

`nouride restart` **refuses to run** when nothing would start the daemon again, as with one started by
hand rather than by the unit. A "restart" that means "stop until you notice" is the worst kind of
wrong, so it is a 409 with an explanation rather than a silent shutdown. `nouride update --check`
names the supervisor the daemon has.

## Exposing the dashboard

It binds to loopback by default, and the right answer for most people is to leave it there:

```bash
ssh -L @@PORT@@:127.0.0.1:@@PORT@@ you@your-server
```

To serve it on the network, `--host 0.0.0.0` at install time, or:

```toml
[dashboard]
enabled = true
host = "0.0.0.0"
port = @@PORT@@
```

Bound to `0.0.0.0`, the first-login banner in the log lists this machine's LAN addresses as well as
`localhost`, unless `public_url` is set, in which case it names that.

Put a reverse proxy with TLS in front of it if it is reachable from anywhere you do not control. The
dashboard is a login, and a login over plain HTTP is a password on the wire.

## Re-running the installer after updates

`nouride update` replaces the binary, the dashboard and the skills. It never touches the unit, the
launcher or the package service: those are root's, and the update runs as the service account. So an
install that has only been updated that way keeps what it was installed with. Re-run the installer
once to bring them up to date. It leaves `.nouride/` alone, and `nouride doctor` says when it is due.

- **0.8** added `nouride-run`, so each agent's commands run as its own user. The helper and its units are
  root's, so an install only ever updated with `nouride update` gets them from the installer.
- **0.7** changed how a restart stops a running command (`KillMode=mixed`, above) and put the launcher
  on `PATH` in place of a link.
- **0.6** moved the agents' `HOME` into `.nouride/home`. The installer copies `.ssh`, `.gitconfig`,
  `.config`, `.local`, `.npmrc`, `.netrc`, `.docker`, `.kube`, `.aws` and `.gnupg` across from the
  old one, never over something already there. Until then the daemon runs the agents' commands with that
  `HOME` anyway; the copy itself was made by every 0.7.x start. The originals are left where they were.

## What to back up

`.nouride/` and `.env`, with the daemon stopped.
[Backup, upgrade, uninstall →](/en/docs/manual/maintenance/)
