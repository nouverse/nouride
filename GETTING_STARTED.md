# Getting started

Nouride is one binary. It carries its own runtime, so there is nothing to install alongside it: no
Node, no Bun, no package manager. Pick your machine below, run one command, and finish the setup in
the browser.

**What you need:** a machine that stays on, and a model endpoint (Anthropic, OpenAI, or anything
speaking either wire format). No bot token is needed to get started: you can talk to your first
agent from the dashboard or the terminal.

---

## Linux

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh
```

That is the whole install. The script creates a `nouride` service account, puts the binary in
`/srv/nouride`, writes a `0600` `.env`, generates and starts a systemd unit, waits for the daemon to
answer on `/health`, and prints where to go next.

It is plain POSIX `sh` and readable top to bottom, because it runs as root on a machine nobody has
logged into yet. Read it before you pipe it to a shell:

```bash
curl -fsSL https://get.nouride.com/install.sh | less
```

**By default the dashboard listens on loopback only**, so nothing is exposed to your network until
you say so. The script prints an `ssh -L` line to reach it. To serve it on the LAN instead:

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --host 0.0.0.0
```

<details>
<summary>Other options</summary>

| Flag | Default | What it does |
|---|---|---|
| `--host ADDR` | `127.0.0.1` | Address the dashboard binds to |
| `--port PORT` | `18254` | Dashboard port |
| `--dir PATH` | `/srv/nouride` | Install directory |
| `--user NAME` | `nouride` | Service account to create and run as |
| `--version TAG` | `latest` | Release to download |
| `--repo OWNER/N` | `nouverse/nouride` | Download from GitHub releases instead of the download domain |
| `--tarball PATH` | none | Install from a tarball already on the machine |

</details>

The script picks the right build from `uname -m` **and** your C library. Alpine and other musl
systems get a different binary, and on those you need `apk add libstdc++` first. It tells you if it
finds one missing.

---

## Raspberry Pi / Orange Pi

Same command as Linux:

```bash
curl -fsSL https://get.nouride.com/install.sh | sudo sh
```

**Your OS must be 64-bit.** Check before you start:

```bash
uname -m     # aarch64 → good.  armv7l → 32-bit, not supported
```

There is no 32-bit ARM build, and the installer stops with `unsupported architecture` rather than
downloading something that will not run. If you see `armv7l`, reinstall with a 64-bit image:
Raspberry Pi OS (64-bit), Ubuntu Server arm64, or Armbian arm64 for an Orange Pi. A Pi 3 or newer
and any modern Orange Pi can all run 64-bit; the 32-bit image is just still a common default.

Everything else is identical: systemd supervises it, it comes back after a reboot, and a Pi 4 with
2GB of RAM is comfortable for a handful of agents.

---

## macOS

On a Mac with Apple Silicon (M1 and later), as yourself, **no `sudo`**:

```bash
curl -fsSL https://get.nouride.com/install.sh | sh
```

The same script installs into `~/nouride`, links `nouride` into `/usr/local/bin` (or `~/.local/bin`), and runs it as
a LaunchAgent (`~/Library/LaunchAgents/tech.nouverse.nouride.plist`): as you, with Homebrew first on its `PATH`, and
only while you are logged in. Its log is `~/nouride/.nouride/data/nouride.log`.
`--variant router` installs the Router edition here too.

---

## Docker

```bash
mkdir -p ~/nouride && cd ~/nouride
```

Save this as `docker-compose.yml` there.

```yaml
name: nouride

services:
  nouride:
    image: ghcr.io/nouverse/nouride
    container_name: nouride
    restart: unless-stopped
    ports:
      - "127.0.0.1:18254:18254"
    # Every credential reaches the container this way. Secret *names* are chosen in your
    # config.toml — `api_key = "nougate"` reads $NOUGATE — so they cannot be listed here.
    env_file:
      - path: .env
        required: false
    environment:
      # A container must bind its own interface, or the published port reaches nothing.
      - HOST=0.0.0.0
      - PORT=18254
    volumes:
      # The whole install as one mount: config, database, secrets, agent packs, workspace.
      # One directory to back up; one to delete to start over.
      - ./nouride:/app/.nouride
    healthcheck:
      test: ["CMD", "bun", "-e", "await fetch('http://localhost:18254/health').then(r=>process.exit(r.ok?0:1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    # Docker's default is 10 s, after which a turn still running is killed mid-step.
    stop_grace_period: 45s
```

```bash
docker compose up -d
docker compose logs -f          # the first-run password is printed here
```

Or without a compose file:

```bash
docker run -d --name nouride --restart unless-stopped --stop-timeout 45 \
  -p 127.0.0.1:18254:18254 \
  -e HOST=0.0.0.0 \
  -v "$PWD/nouride:/app/.nouride" \
  ghcr.io/nouverse/nouride
```

`HOST=0.0.0.0` is not optional in a container. Loopback is the right default for a daemon running
natively on a host, but a container that binds loopback binds *its own* loopback, and your published
port reaches nothing.

The port is published on the host's loopback only, as a native install listens: open the dashboard on the
machine itself, or tunnel to it from yours with `ssh -L 18254:127.0.0.1:18254 you@your-server`. To reach it
from other machines, drop `127.0.0.1:` (`"18254:18254"`), and the dashboard then answers anyone who can reach the
host, and a port Docker publishes goes around a firewall such as `ufw`. For a public address, keep it on loopback
and put a reverse proxy with TLS in front of it on the same machine (Caddy, nginx, a Cloudflare Tunnel): the
dashboard is a login, and a login over plain HTTP is a password on the wire.

---

## First run: getting into the dashboard

**The daemon boots with no configuration at all.** There is no config file to write before it
starts: the provider, its credential and your first agent are all set in the browser.

### 1. Find the first-time password

It is generated on the very first start, printed **once**, and never stored in plain text. Where to
look depends on how you installed:

```bash
# Linux, Raspberry Pi
sudo journalctl -u nouride | grep -A12 'Nouride is ready'

# macOS
grep -A12 'Nouride is ready' ~/nouride/.nouride/data/nouride.log

# Docker
docker compose logs nouride | grep -A12 'Nouride is ready'
```

You will get something like:

```
  Nouride is ready. Open the dashboard to finish setting it up:

    http://127.0.0.1:18254/dashboard/

    username  admin
    password  <generated>
```

**Prefer to choose your own?** Set these in `.env` *before* the first start. This is what an
unattended install wants, since nobody is watching the log:

```bash
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=<something long>
```

They are read only while the user table is empty, so they cannot be used to reset a password later.

### 2. Open it

```
http://127.0.0.1:18254/dashboard/
```

On a Mac you installed it on, open it there. On a server bound to loopback (the default), tunnel to it
from your own machine:

```bash
ssh -L 18254:127.0.0.1:18254 you@your-server
```

Then open the same URL locally. Nothing is exposed to the network by doing this.

### 3. The wizard

It asks two things:

1. **Your model endpoint:** Anthropic or OpenAI wire format, a base URL, and an API key. The
   endpoint is tested before anything is saved, so a typo fails here rather than at the first
   message.
2. **Your first agent:** an id, a display name, and a one-line persona.

That is the whole setup. Bot tokens for Telegram, Discord or WhatsApp come later, from the dashboard
or from `.env`.

### Doing it over SSH instead

If you can only reach the machine through a terminal, `nouride setup` does the same work:

```bash
# As the service account, in the install directory. `su -s /bin/sh` because that account has
# `nologin` as its shell — `sudo -u` can trip over that on some distributions.
sudo su -s /bin/sh nouride -c 'cd /srv/nouride && ./nouride setup'
```

In Docker it is `docker compose exec nouride ./nouride setup`.

The daemon is already running and picks up what `setup` wrote only when it restarts, and `setup` ends by saying how:
`sudo systemctl restart nouride` on a server, `docker compose restart nouride` from the host for a container.

It is interactive by default. For a provisioning script, pass everything and skip the prompts. Note that
there is deliberately **no `--api-key` flag**, because a key on a command line lands in shell
history, in `ps` output, and in CI logs. Name an environment variable instead:

```bash
./nouride setup --yes \
  --provider anthropic \
  --api-key-from-env ANTHROPIC_API_KEY \
  --agent nouva --name Nouva \
  --model claude-sonnet-5 \
  --prompt "You are a helpful assistant."
```

It refuses to run against an install that already has a config, rather than quietly rewriting your
default agent.

---

## Keeping it running

The installer already made it always-on: `systemctl enable --now` on Linux,
`restart: unless-stopped` in Docker. It survives a crash and comes back after a reboot.

### Is it actually up?

```bash
curl -fsS http://127.0.0.1:18254/health
```

```json
{"status":"ok","uptime":147,"version":"0.1.0","agents":6,"gateways":{"telegram:bot":"connected"}}
```

**Check this, not just the service state.** `systemctl start` returning 0 means the process was
spawned, not that it is serving: a daemon that refuses its config exits *after* systemd reports
success.

### Day-to-day

The CLI finds its own install, so these work from any directory:

```bash
nouride status          # one screen: agents, gateways, queue
nouride doctor          # diagnose a setup that is not working
nouride logs -f         # live log — works with no journal, and against a remote daemon
nouride chat            # talk to an agent from the terminal, no bot token needed
```

### Start, stop, restart

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

`nouride restart` works on any of them, but it works by **asking the daemon to exit so its supervisor
brings it back**. With nothing supervising it, that would be a stop, so it refuses and says so;
`--force` stops it anyway. Check first if you are unsure:

```bash
nouride service status
```

It answers for the process actually running, and says plainly whether anything will respawn it.

---

## Upgrading

Re-run the installer. It stops the daemon, replaces the binary, and starts it again. Your database,
secrets, agent packs and workspace in `.nouride/` are left alone.

```bash
# Linux, Raspberry Pi
curl -fsSL https://get.nouride.com/install.sh | sudo sh

# macOS
curl -fsSL https://get.nouride.com/install.sh | sh

# Docker
docker compose pull && docker compose up -d
```

---

## Uninstalling

Everything the daemon owns is in one directory, so removing it is removing that.

```bash
# Linux, Raspberry Pi
sudo systemctl disable --now nouride
sudo rm /etc/systemd/system/nouride.service /usr/local/bin/nouride
sudo systemctl daemon-reload
sudo rm -rf /srv/nouride          # this deletes your agents and conversations

# macOS
launchctl unload -w ~/Library/LaunchAgents/tech.nouverse.nouride.plist
rm ~/Library/LaunchAgents/tech.nouverse.nouride.plist
rm -f /usr/local/bin/nouride ~/.local/bin/nouride
rm -rf ~/nouride                  # this deletes your agents and conversations

# Docker
docker compose down
rm -rf ./nouride
```

`nouride service uninstall` prints the right commands for whichever supervisor you are on, if you
would rather not remember them.

---

## When it does not work

| What you see | What it usually is |
|---|---|
| Installer says `unsupported architecture` | 32-bit ARM. You need a 64-bit OS: see the Pi section |
| Binary "not found" on Alpine, and the file is right there | musl vs glibc, or a missing `apk add libstdc++` |
| Service starts, `/health` never answers | The daemon refused its config. `sudo journalctl -u nouride -n 50 --no-pager` |
| Dashboard unreachable from another machine | Bound to loopback by default. Reinstall with `--host 0.0.0.0`, or tunnel with `ssh -L` |
| Published Docker port reaches nothing | `HOST=0.0.0.0` is missing |
| Missed the first-run password | It is shown once, and nothing stores it. Stop the daemon, run `sudo nouride users reset`, and start it again: every account is removed, so a new admin is created and its password printed. Conversations, secrets and agents are untouched. With Docker, and the details, see [DEPLOY.md](./docs/DEPLOY.md#lost-the-first-password). Set `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` in `.env` before the first start and this cannot happen |

`nouride doctor` checks the things that commonly stop a fresh install (a provider with no
credential, an agent pack that did not load, a gateway stuck reconnecting, no agent enabled at all),
and each finding says what to do about it.

---

## Where things live

```
/srv/nouride/              (Linux)   ~/nouride/  (macOS)   ./nouride/  (Docker volume)
├── nouride                the binary
├── dashboard/            the web UI it serves
├── skills/               skills that ship with the daemon
├── .env                  credentials and per-host values (0600)
└── .nouride/
    ├── config.toml       everything structural
    ├── data/             SQLite, secrets, attachments
    ├── agents/           personas and agent packs
    │   └── skills/       the skill pool — every agent draws from it, on by default
    └── workspace/        what the agents produce
```

**Back up `.nouride/`.** Everything else is a download.

---

## Next

| | |
|---|---|
| [docs/CLI.md](./docs/CLI.md) | every command, and why the CLI is for you rather than for the agent |
| [docs/DEPLOY.md](./docs/DEPLOY.md) | production deployment, hardening, and the reverse-proxy setup |
| [config.example.toml](./config.example.toml) | every setting, annotated. It ships beside the binary too |
| [packages/wa-bridge/README.md](./packages/wa-bridge/README.md) | the WhatsApp bridge, which runs inside the daemon |
