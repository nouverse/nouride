# Deploying Nouride

Two shapes, and the choice is not about convenience:

| | Native (systemd / launchd) | Docker |
|---|---|---|
| Agent can run commands on the host | **yes** — that is the point | only inside the container |
| Blast radius of a bad command | the host, bounded by unit hardening and the exec policy | the container |
| Restarts on crash / reboot | systemd or launchd | the container's entrypoint, and its restart policy |
| Where `exec` lands | your actual machine | a filesystem that disappears, but for the `.nouride/` volume |

**Pick native if you want an agent that can do things on your machine.** Pick Docker if you want an
agent that talks and reads, isolated from the host it happens to run on. Running the native shape is
the reason the exec permission model exists (`docs/CLI.md`, `[security.exec]`); running Docker and
then bind-mounting your home directory into it gets you the risk of native with the illusion of
isolation.

**Not on memory grounds.** The two shapes measure within ~10 MB of each other — see
[SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md) for what this costs and what hardware suits it.

---

## Native

### The short way

One command puts the daemon on the box; the browser does the rest. `scripts/install.sh` covers
everything in "by hand" below — it detects the architecture and C library, creates the service
account, installs the binary beside its dashboard, writes a `0600` `.env`, generates the unit through
`nouride service install`, starts it, waits for `/health`, and prints where to go.

Since 0.7.7 it checks what it downloads first, as `nouride update` does: the tarball against the release's
checksum file — `CHECKSUMS` from 0.8.0, `SHA256SUMS` before it — and that file's signature against the key compiled into Nouride — for `latest` and every
release from v0.7.4, which all carry one. A mismatch, or a signature missing or wrong, stops the install. It
needs OpenSSL 3 for the signature, and says so and checks the checksum alone where there is none. A
`--tarball` is checked when the checksum file that lists it sits beside it — `CHECKSUMS`, or
`CHECKSUMS-pro` for a Pro build (`SHA256SUMS…` up to 0.7.x) — and that file's `.sig` with it when it is there; with no `.sig` it says
the check was against a file nothing vouches for. As root, the `nouride` it puts on
`PATH` runs the CLI as the service account, and refuses rather than run that account's binary as root
where nothing can drop to it.

```bash
# On your laptop
bun run build:binary --target linux-x64
scp dist/nouride-linux-x64.tar.gz scripts/install.sh root@server:/tmp/

# On the server
sh /tmp/install.sh --tarball /tmp/nouride-linux-x64.tar.gz
```

That is the free edition: WhatsApp and the LLM gateway compiled in (the gateway off until
`[nougate] in_process = true`, which setup's **Use Nougate** and the LLM Gateway page write), one account, no
external sign-in. Built from a clone without `internals/nougate`, it has no gateway. `pro` adds multi-user
accounts, Nouverse sign-in and Box pairing. The Router edition, the free one with the gateway on, is the free
edition since 0.8.29.

Once a release exists, the tarball step goes away: `sh install.sh` downloads the right build itself.

```bash
sh install.sh                            # the free edition
sh install.sh --variant router           # the same, with the gateway on (accepted until 0.9)
```

`pro` is licensed rather than a public download, so for it the script needs `--tarball`. `--variant`
takes those three names and refuses any other.

Then open the printed URL. **The daemon boots with no configuration at all** — the provider, its
credential and the first agent are set in the dashboard wizard, which tests the endpoint before saving
anything. `nouride setup` (§3) does the same work through the same `SetupService`; it exists for a
machine you can only reach over SSH.

The dashboard binds to loopback by default, so the script prints the `ssh -L` line to reach it. Pass
`--host 0.0.0.0` instead if the box should serve it on the network.

Re-running the script upgrades the binary, rewrites the unit and the launcher, and leaves `.nouride/`
alone. A `--host` or `--port` given on a re-run replaces what `.env` has; one not given leaves it as it
is, and the script waits for, and prints, the address the daemon will actually use. On macOS a release
carries Apple Silicon builds only (`darwin-arm64`); an Intel Mac builds its own and passes `--tarball`.

| Flag | |
|---|---|
| `--tarball PATH` | install from a tarball already on this machine |
| `--version TAG`, `--base-url URL`, `--repo OWNER/NAME` | which release to download, and from where |
| `--variant NAME` | `pro`; omitted, the free edition. `router` until 0.9: the free edition with the gateway on |
| `--dir PATH`, `--user NAME` | install directory and service account — `/srv/nouride` and `nouride` |
| `--host ADDR`, `--port PORT` | where the dashboard listens — `127.0.0.1:18254` |
| `--allow-packages`, `--no-packages` | let agents install system packages through `nouride-pkg`, asking a person each time unless an agent is `trusted` — or remove it (`CLI.md`, `nouride pkg`) |

> Read it before you run it. It runs as root on a machine nobody has logged into yet, and it is
> deliberately plain POSIX `sh` for that reason.

The rest of this section is what the script does, for when something goes wrong or the machine is
unusual enough that you want to drive it yourself.

### 1. A user that is not you, and not root

```bash
sudo useradd --system --no-create-home --home-dir /srv/nouride/.nouride/home --shell /usr/sbin/nologin nouride
sudo mkdir -p /srv/nouride && sudo chown -R nouride:nouride /srv/nouride
```

`nouride service install` **refuses to generate a unit that runs as root** unless asked with
`--privileged`, for a machine dedicated to the agent. This daemon executes commands chosen by a
language model, reachable from a chat app; every other boundary in it — the exec policy, the
workspace sandbox, the `0600` file modes, each agent's own user — assumes an unprivileged account. An agent's
`sudo` is a command it has to be granted, and running as root makes every command one that needs none.

A separate user also means `ProtectHome=read-only` in the unit actually protects *your* home
directory rather than the daemon's own.

### 2. Binary and files

Built on your machine, cross-compiled for the server. The server needs no Bun install, no source tree
and no toolchain — the runtime is inside the executable.

```bash
# On your laptop. `uname -m` on the server says x86_64 (→ linux-x64) or aarch64 (→ linux-arm64).
bun run build:binary --target linux-x64
scp dist/nouride-linux-x64.tar.gz server:/tmp/
```

**Match the C library, not just the architecture.** The `linux-x64` and `linux-arm64` builds link
against glibc — Debian, Ubuntu, RHEL and relatives. Alpine needs the `-musl` build *and*
`apk add libstdc++`, which the binary needs and a bare Alpine does not have; without it the loader
reports missing C++ symbols, which reads like a corrupt download rather than a missing package. Both
mismatches fail on the first run and not before.

The tarball holds:

```
nouride               the executable — the Bun runtime, the engine, the WhatsApp bridge, and every migration
dashboard/            the built SPA, which the binary serves from beside itself
skills/               the skills that ship with the daemon — the `builtin` scope
pkg/                  nouride-pkg, the root service `--allow-packages` installs — scripts, so they can be read
config.example.toml   every setting, annotated. A reference; the daemon boots without it
frontend/             the LLM gateway's UI, in a build that carries the gateway
```

The dashboard is a directory of hash-named assets, which cannot be named as imports and so cannot be
compiled in. The daemon looks for it **next to the executable**, which is why the two travel together
and why the binary is installed into its working directory rather than into `/usr/local/bin`:

```bash
sudo -u nouride tar -xzf /tmp/nouride-linux-x64.tar.gz -C /srv/nouride
sudo -u nouride install -m 600 /dev/null /srv/nouride/.env      # credentials go here
```

`nouride` on PATH is a small root-owned launcher at `/usr/local/bin/nouride`, not a symlink. The
binary belongs to the service account — that is what lets `nouride update` replace it without root —
and so does every command an agent runs. A symlink made root run a file those commands can rewrite.
The launcher runs the CLI as the service account when root calls it, which also keeps what the CLI
writes into `.nouride/` owned by the daemon. `install.sh` writes it; by hand:

```sh
#!/bin/sh
bin=/srv/nouride/nouride
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=nouride --regid=nouride --init-groups -- \
    /usr/bin/env HOME=/srv/nouride/.nouride/home USER=nouride LOGNAME=nouride "$bin" "$@"
fi
exec "$bin" "$@"
```

The daemon still finds `/srv/nouride/dashboard` because it looks beside the binary it was started as.
`nouride doctor` warns while `/usr/local/bin/nouride` is still a link.

`.env` holds the provider keys and bot tokens. It is `0600` and owned by the service account, and it
is referenced from the unit as `EnvironmentFile=` — **never** as `Environment=`. Unit files are
world-readable, get committed, and get pasted into issue reports; a key in `Environment=` is a
leaked key.

Prefer the secret store — the dashboard's Secrets page, `nouride secret set` — for anything that can
live there. A value in `.env` is in the daemon's environment for as long as it runs, and every command
an agent runs is a process of the same user. Since 0.7.7 the daemon makes itself non-dumpable on
Linux, so those commands cannot read it through `/proc/<pid>/environ`, and the exec gate asks about
that path besides; the store keeps the value out of the environment altogether.

### 3. `nouride setup`

```bash
cd /srv/nouride
sudo -u nouride nouride setup
```

It creates the install and asks for the provider, its base URL and API key, then for the first agent:
its id, its model and a one-line persona. The key is **probed against the
endpoint before anything is written** — a credential that does not work is the most common way a fresh
install fails, and it otherwise surfaces on the agent's first message, long after setup reported success.

```
.nouride/
  config.toml           the provider profile, and the orchestrator
  data/                 SQLite (with the daemon's own state), secrets.enc, control token, backups
  agents/<id>/          the persona pack: IDENTITY.md, SOUL.md, later MEMORY.md
  workspace/
    shared/             every agent works here — see below
    private/<id>/       one agent's own
```

For a provisioning script there is no terminal to answer, so every question has a flag:

```bash
nouride setup --yes \
  --provider anthropic \
  --api-key-from-env ANTHROPIC_API_KEY \
  --agent nouva --model claude-sonnet-4-20250514
```

**There is deliberately no `--api-key`.** A key on a command line is in the shell history, in `ps`
output while the process runs, and in any CI log that echoes its commands. `--api-key-from-env` names
a variable; the interactive prompt reads the value without echoing it. Either way `config.toml` gets
the secret's *name* and `data/secrets.enc` gets the value, encrypted, at mode `0600`.

Setup **refuses to run against an install that already has a `config.toml`**. Run twice it would
otherwise look like a no-op while having replaced the orchestrator and repointed the provider.

Everything it does can also be done from the dashboard, and by the same code — the wizard and this
command drive one `SetupService`. Use whichever the machine gives you; a server reached over SSH
usually gives you this one.

> **The CLI finds the install from anywhere.** The launcher runs the binary from `/srv/nouride`, and the
> CLI looks for the install beside its own binary. Only a working directory with a `.nouride/` of its
> own — a source checkout — comes first (`CLI.md`, Finding the install).

### 4. The unit

```bash
cd /srv/nouride
nouride service install --user nouride --dir /srv/nouride
```

That **writes** `/srv/nouride/nouride.service` and prints the commands to activate it. It does not
install or enable anything itself: enabling a system service is a privileged, host-changing action,
and a CLI you cannot safely run to see what it would do is a CLI you end up not running.

Read the file, then:

```bash
sudo cp /srv/nouride/nouride.service /etc/systemd/system/nouride.service
sudo systemctl daemon-reload
sudo systemctl enable --now nouride
journalctl -u nouride -f
```

The generated unit is checked by `systemd-analyze verify` — every directive in it is one systemd
recognises. What it does beyond `Restart=always`:

- `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=true`, `NoNewPrivileges=true`,
  `RestrictSUIDSGID=true`, `RestrictNamespaces=true`, and the kernel and cgroup protections — the
  daemon runs arbitrary commands by design, which is exactly why the blast radius of *the daemon
  itself* should be bounded. `--privileged` leaves all of these out.
- Since 0.7.10, `CapabilityBoundingSet=` (none), `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
  AF_NETLINK` and `RestrictRealtime=true` — nothing the daemon or an agent's `ssh`, `git`, package
  installs, `ffmpeg` or Python uses; raw sockets need a capability this account never has. Left out on
  purpose: `ProtectProc=invisible` (an agent asked whether nginx runs would read "no"), `ProtectClock`
  and `PrivateDevices` (each closes devices — `/dev/dri` for ffmpeg, a serial adapter), and
  `SystemCallFilter` (with the Landlock shim).
- `OOMPolicy=continue`, where systemd has it (v243): a command the kernel kills for memory is killed
  alone. The default stopped the whole unit — every gateway and turn — for the build that caused it. The
  commands agents run are also what the kernel reaches for first (`oom_score_adj` 500, through
  `choom`), and the daemon is left where the unit puts it.
- The unit carries only directives this machine's systemd knows: `nouride service install` reads
  `systemctl --version` and leaves out what is newer.
- `ReadWritePaths=/srv/nouride` — the necessary exception. `ProtectSystem=strict` makes everything
  read-only, so without this the daemon cannot write its own database and dies at boot.
- `Environment=HOME=/srv/nouride/.nouride/home` — the agents' HOME, writable under `ProtectHome`, and
  where their programs keep their settings (see Where the agents work).
- `After=network-online.target` — chat gateways and LLM endpoints are all remote; starting earlier
  just fills the journal with a reconnect storm.
- `TimeoutStopSec=45` with `KillSignal=SIGTERM` and `KillMode=mixed` — the signal goes to the daemon
  alone, which asks every running turn to stop at its next step, lets each tell its chat what it did,
  and stops its own children in order; whatever is left after 45 seconds is killed.
- `StartLimitBurst=5` over 120 seconds — a daemon that refuses to boot ends `failed` with its reason in
  the journal, rather than restarting for ever.
- `ExecStartPre` — the update guard: while an update is unconfirmed, a new binary that keeps failing
  to start is replaced by the previous one. Off a box, an update confirms itself once a chat gateway is
  connected and a message has been handled, or after five minutes up with nothing to handle.

### Running the test suite on the box

Safe now, and it was not. `bun run verify` on a 2-core / 2 GB LXC used to take the container down —
not the tests, which peak at 556 MB and finish in 28 seconds, but `lint:types`, which spawned all
twelve `tsc` processes at once. One of them (`apps/engine`) peaks at 694 MB on its own; twelve is
three to four gigabytes against two, with the daemon, its agents and its gateway connections living
in the same container.

`scripts/check-types.ts` now sizes the pool from the machine — CPU count, and `MemAvailable` against
a measured 700 MB per job — and prints the width it chose. On that box it picks two and the whole of
`verify` runs in 49 seconds at a 1242 MB peak, with the daemon answering throughout.
`NOURIDE_TYPECHECK_JOBS=1` forces it lower if a box is smaller still.

Three things guard the rest, because the next runaway will not be ours:

- The generated unit carries `MemoryHigh` at 80% of what the machine reports — a *soft* ceiling, so a
  heavy command is throttled rather than something being killed. It is written as an absolute number
  computed at install time, **not** `80%`: inside an LXC systemd resolves a percentage against the
  host's memory, and on a 2 GB container of a 62 GB node that came out as 49.8 GB.
- Commands the agent spawns run at `nice 10`, so a build yields the CPU to a turn rather than making
  every chat go silent until it finishes.
- Since 0.7.19 they also run in a cgroup of their own (`Delegate=yes`; `packages/runtime/src/process-cgroup.ts`),
  capped below `MemoryHigh`, with the daemon's memory protected beside them. A soft ceiling over the
  daemon *and* its commands had been the trap: on a 2 GB box an agent's typecheck and test suite held
  the whole unit over it for three quarters of an hour, and the kernel throttled the daemon with them
  until `/health` took longer than 20 s. Now the command that outgrows the cap is killed alone.
  `nouride doctor` says the cap, and warns on a unit from before 0.7.19.

A third thing shrinks the daemon itself: the released binary is compiled with `--smol` baked into its
`execArgv`, so it runs a smaller heap and collects more often. The image starts its bundle with
`bun --smol` too, since 0.7.10. Measured on the two live boxes, before
and after the same build otherwise:

| | RSS before | RSS after | heap (anon) before | after |
|---|---|---|---|---|
| the live box — 6 agents, 9 gateways | 76.5 MB | 65.6 MB | 48.6 MB | 41.4 MB |
| a Pi Zero 2 W — 1 agent, 2 gateways | 95.4 MB | 79.3 MB | 46.4 MB | 33.2 MB |

The cost is CPU: an allocation-heavy benchmark in the shape of a turn runs 21% slower. That is the
right trade here because a turn's wall time is dominated by waiting on a model, not by local
allocation — but `bun run build:binary --no-smol` builds without it for a host with memory to spare.

Two numbers worth knowing when planning a small box. The daemon's heap is **flat in the number of
agents** — 46 MB with one agent and 48.6 MB with six, before `--smol` — so agents are close to free
and the baseline is what you budget for. And the daemon is not always the largest process in its own
cgroup: on the live box a single Node-based MCP server measured 91.5 MB against the daemon's 73.3 MB,
so on a 256 MB device one Node MCP server is the difference between fitting and not.

**On a Raspberry Pi, check that `MemoryHigh` is doing anything at all.** Raspberry Pi OS ships with the
memory cgroup controller disabled, so systemd accepts the setting and silently enforces nothing:

```bash
systemctl show nouride -p MemoryCurrent --value   # `[not set]` means it is inert
cat /sys/fs/cgroup/cgroup.controllers             # no `memory` in the list
```

Fix it by adding `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt` and rebooting.

What is *not* used is `[security.exec] max_memory_mb`. It applies `prlimit --as`, which caps address
space rather than resident size, and V8 reserves far more address space than it uses: at a 1 GB cap
`tsc` aborts with a stack trace while using 250 MB. A cap low enough to protect a small machine kills
every build on it; one high enough to let builds run protects nothing.

### 5. Check it

```bash
nouride service status      # which supervisor, and whether exiting gets you respawned
nouride doctor              # config, credentials, agents, gateways, the toolchain
nouride status
```

`nouride service status` reports on the process it can reach. If it says `none`, **`nouride restart`
will refuse to run** — a "restart" that means "stop until you notice" is the worst kind of wrong, so
it is a 409 with an explanation rather than a silent shutdown.

> Detection matches launchd's job label, not the mere presence of `XPC_SERVICE_NAME`. macOS exports
> that variable into every process from a GUI session (`0` in an ordinary shell), and presence-based
> detection made a hand-started daemon believe launchd would revive it. It did not.

### macOS

Same flow, `launchd` instead: `nouride service install --kind launchd --user "$USER" --dir ~/nouride` writes
`tech.nouverse.nouride.plist`, and the printed commands load it from `~/Library/LaunchAgents`. A
LaunchAgent runs as you and only while you are logged in — fine for a laptop, not a server. Its output
goes to `.nouride/data/nouride.log`, which the daemon keeps under 16 MB: past it, the file is copied to
`nouride.log.1` (replacing the one before) and emptied. `install.sh` creates that directory before it
loads the job, because launchd makes no directory above a log and the first boot's output carries the
one-time admin password.

The plist gives the job a `PATH` with Homebrew first — `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:~/.local/bin`,
then the system's — since launchd's own is `/usr/bin:/bin:/usr/sbin:/sbin` and a `PATH=` in `.env` cannot replace
a variable the process already has; and `Umask` 23 (0027), as the systemd unit's `UMask=0027`. `install.sh` links
`~/.local/bin/nouride` to the binary, and the CLI finds the install beside the real binary from any directory.

launchd has no `EnvironmentFile=`, so `nouride start` reads the install's `.env` itself — never replacing a
variable already set. That is the only file the binary reads from beside it: since 0.7.7 it is built to load no
`.env` and no `bunfig.toml` from the directory it runs in, where a `bunfig.toml` preload would have been code
run inside the daemon.

### OpenWrt

procd instead: `nouride service install --kind procd --privileged --user root --dir /srv/nouride` writes
`nouride.init` for `/etc/init.d/nouride`, and is the default where `/sbin/procd` exists. It runs the
update guard before every start, as the systemd unit's `ExecStartPre` does, and declares itself
(`NOURIDE_SERVICE_KIND=procd`) so the daemon knows exiting brings it back — without that an update is
refused as a stop. A box whose offered update it cannot take says so once, in the log and to Fleet.
Proven by test only: no OpenWrt board has run it yet.

---

## Upgrading

```bash
nouride update --check      # which version and edition this is, and whether a newer one exists
nouride update --start      # download, verify, swap, and restart once nothing is running
```

`--start` verifies the tarball against the release's checksum file, keeps the previous version in
`.nouride-previous/`, and restarts once nothing is running: no turn, no queued message and no pending
approval, waited for ten minutes at most, and no background job, waited for however long it takes.
`--now` restarts at once and stops the jobs (`CLI.md`, `nouride update`). A new binary that keeps
failing to start is put back by the unit's update guard; one that starts and is wrong is put back by
hand:

```bash
nouride update --rollback            # which build, and whether the database goes back with it
systemctl stop nouride && nouride update --rollback --apply && systemctl start nouride
```

Re-running `install.sh` with a newer tarball keeps the build it replaces the same way, so the way back
is there after either kind of upgrade. Back to a build before 0.8.19 it also writes the secrets as that build reads
them, `secrets.json`, which needs the store's key: run it as root (`sudo nouride update --rollback --apply`), whose
`/etc/nouride/nouride.env` the launcher hands to the CLI.

**Pro is not on the public channel.** A paired Box takes its updates from Nouverse and
installs them itself. Anywhere else — a server running a Pro build — `nouride update` says the newer
release exists and that no build of this edition is published where it looks, and prints the way that
works: the tarball, its checksum file and the file's signature from that release of the internal
repository, in one directory — the internal release carries the signature from v0.7.10 — then

```bash
sudo sh install.sh --tarball nouride-pro-linux-x64.tar.gz --variant pro
```

An Intel Mac is told the same about its platform, with the command that builds one: a release carries
macOS builds for Apple Silicon only. Whatever the channel offers, `nouride update` installs only a build for
the platform and architecture the running process reports — a Linux tarball is refused on a Mac before
anything is swapped.

`nouride update` runs as the service account and cannot write `/etc`, so it never touches the unit or
the launcher. When a release changes what `install.sh` writes, re-run `install.sh` once — it rewrites
both and leaves `.nouride/` alone. `nouride doctor` says when the unit is older than the version
running, and `nouride service diff` shows each line. A privileged install running as root — a Box —
rewrites its own unit once an update has confirmed itself, keeps the old one as
`nouride.service.previous`, and reloads systemd; it applies from the next start.

With Docker: `docker compose pull && docker compose up -d`, on the latest image (§ The upgrade floor). The shipped compose files give the daemon
`stop_grace_period: 45s`; a compose file of your own needs the same, or Docker kills a running turn
after 10 seconds.

The first start of a release that changes the schema snapshots the database first (§ When a boot
refuses over the schema); that snapshot is the way back.

### The upgrade window

**Every release after 0.8.0 upgrades from 0.8.0 only; 0.8.0 upgrades from 0.7.28 or 0.7.29.**
An install on 0.7.x starts 0.8.0 once on its way, and one older than 0.7.28 the newest 0.7.x once before that.
Each start is what carries an install across the forms below: the last 0.7.x's migrated the database, laid the vault out, and rewrote `config.toml` and each agent's pack on disk; 0.8.0's brought the database to its schema and wrote each pack's `fallback_model` as `fallbacks`.

This version starts only on data 0.8.0 has run on. On anything older it does not start, and says why and how across — before
it reads the old forms `config.toml` may still hold, and so does `nouride config check`:

```
refusing to start: this release upgrades only from 0.8.0, and the data in /srv/nouride/.nouride/data last ran 0.7.29.
This version no longer reads the forms 0.8.0 brought forward on disk, so it would start on data it cannot read.
  → install 0.8.0 and start it once (it brings the database and every pack forward on disk, after a snapshot), then this version again
  → on Docker: run ghcr.io/nouverse/nouride:0.8.0 once on the same volume, then this image again
```

The Docker line names `0.8.0`, not `0.8`: that tag moves to every 0.8.x, this one too. On systemd, `sh install.sh --version v0.8.0` installs it; start it, then install this version again.
Data an older 0.7.x last ran, or with no record of what ran it, is told both steps — `install 0.7.29 and start it once … then 0.8.0 once`, and on Docker the `0.7` tag, then `0.8.0` — since 0.8.0 alone would refuse it too.

Nothing is written before that check, so the data is as it was. When the last 0.7.x could not finish a rewrite — a `config.toml` it could not write, say — the refusal lists what it named in `carry-forward-pending`, since starting that 0.7.x again changes nothing until that is fixed.

What 0.8.0 and later refuse, and what to write instead.
0.7.28 rewrote every one of these on disk, so an install only meets them again when one comes back — a pack pulled from git, a hand edit, a script.
In `config.toml` the daemon does not start; in a pack, that agent does not load and the others do (the dashboard and `nouride config check` name it); on the command line the command exits 2.

| Old form | Write instead | Where it is refused |
|---|---|---|
| `[security] sender_allowlist` | `[security.access] allowlist` | `config.toml` |
| `[session_memory]`, and its `reset` | `[rollover]` | `config.toml` |
| `[daemon] default_agent` | `[daemon] orchestrator` | `config.toml` |
| `[[people]] id` | `ids = ["platform:account", …]` | `config.toml` |
| A `[[people]]` account with the connection it came in on (`telegram:nouva:814`), `local:…`, `web:dev` | `telegram:814`, `web:…`, `web:terminal` | `config.toml` |
| `[rsi]` | `[skills.learning]`, `mode = "ask"` or `"auto"` for `require_approval` and `always_allow` | `config.toml` |
| `approvals = "normal"`, `"risky"`, `"none"` | `"careful"`, `"balanced"`, `"trusted"` | `config.toml`, and a pack's `[agent]` |
| Telegram `mode = "webhook"` | no `mode`: Telegram polls | `config.toml` |
| `bridge_transport = "stdio"`, `bridge_command` | neither: the bridge runs in the daemon | `config.toml` |
| `exec_secrets = ["NAME"]` | `[security.exec_secrets] NAME = ["the command that needs it"]`, or `["*"]` | a pack |
| `memory_recent`, `task_plan` in `enabled`, `approval_required` or `blocked` | `memory_search`, `plan` | a pack |
| `[[mcp_servers]]` | the install's library, `agents/mcp.toml` (`nouride mcp add`) | a pack |
| `[llm] fallback_model = "x"` (0.8.0 rewrote it; refused since 0.8.1) | `fallbacks = [{ provider = "<the pack's provider>", model = "x" }]` | a pack |
| `--isolated` | `--session isolated` | the CLI |
| `--token-stdin`, `--key-stdin`, `--value-stdin` | `--stdin` | the CLI |
| `approvals approve`, `people forget` | `approvals allow-once`, `people remove` | the CLI |
| `POST /approvals/<id>/approve` | `POST /approvals/<id>/allow-once` | the control API |
| A database from before 0.8.0 (schema below 69) | 0.8.0 first | at start |
| A memory vault from before 0.7 | 0.7.29, then 0.8.0 | at start |

**Taken into the approval levels (0.8.0), not rewritten by 0.7.28.** These were never old forms — 0.8.0 removed them
(`docs/SPEC.md` §17.4), so an install meets them on its first 0.8.0 start. Refused where dropping them would let more run
without asking; otherwise ignored, with a warning naming each:

| In `config.toml` | 0.8.0 |
|---|---|
| `[security.exec] mode = "deny"` | refused: take `exec` out of `[tools] enabled` in each pack that should run no commands |
| `[security.exec] mode = "allowlist"`, `ask = "always"`, `sensitive_paths = "hardline"` | refused: `[security] approvals = "careful"`, or an agent's `[agent] approvals` |
| `[security.exec] mode = "full"`, `ask`, `ask_fallback`, `sensitive_paths`, `allowlist` | warned and ignored: `[security] approvals` decides what asks |
| a pack's `[security] secret_guard` | ignored: the guard asks at every level but `trusted` |

Read differently rather than refused, since dropping them changes nothing that runs: a `Role:` line in a pack's `IDENTITY.md` is no longer its headline (`Headline:` is); `USER.md` in a pack is neither read nor backed up; `/auto` in a chat is a message to the agent like any other (`/approvals` is the command); `memory backfill` of 0.5 and 0.6 captures is gone; a 0.7.10 or older `nouride chat` pointed at 0.8.0 finds no `/activity`.

Warned about and ignored, since each held the value nearly every install had: `[health]` (`heartbeat_interval_ms`, `disk_warn_threshold_mb`, `wal_warn_threshold_mb`), `[cron] tick_interval_ms`, `[queue] dedup_window_ms` and a gateway's `[resilience]` table are fixed values in 0.8.0 — each named in a warning at start and by `nouride config check` (`config key is a fixed value since 0.8.0 and ignored`). A copy of the old `config.example.toml` has the first three; delete the lines. A pack's `config.toml` is warned about the same way for a key it does not read (`unknown pack config key ignored`) — an `[agent] name` the example pack carried is one — and the agent loads.

### The upgrade floor

What enforces the window: a release can say which version must have run on an install's data before it may be
installed there. The line is in its checksum files — `CHECKSUMS` (and until 0.9 `CHECKSUMS-router`, its copy under the Router edition's name) and the Pro ones (`SHA256SUMS…` up to 0.7.x) —

```
# nouride-min-version: 0.7.14
```

inside what the release's signature covers, so it cannot be taken off a signed release. No line means no floor; 0.7.11
sets none. Releases before 0.7.11 pass over the line: their updaters and `install.sh` look for tarball names only.

Every 0.7.x from 0.7.11 records the version that last started in the data directory, `last-run-version` — written once
the daemon is ready, which is when that version's work on the data is done. From 0.7.22 it is written only when every
old form was brought forward on disk; until then `carry-forward-pending` beside it says what is left (a read-only
`config.toml`, say), and the record keeps the version before. The floor is read against it:

- **`nouride update`** (and the dashboard's Update page, and a paired Box's automatic update) offers the stepping stone
  when the newest release's floor is above the running version: the newest release whose own floor it meets. It says
  so — `update to 0.7.14 first; 0.8.0 needs it` — and `--start` takes the stone, never the release that needs it. Once
  the stone has started, the next check offers the newer release. With no stone on the channel's list it offers
  nothing and says to install the floor's version by hand. The install refuses a release whose signed checksum file
  needs a newer version first, whatever the check said.
- **`install.sh`**, over an install with data, refuses a release whose floor is above the recorded version, and one
  where the data directory (`<dir>/.nouride/data`) has no record — an install that last ran a release before 0.7.11 —
  with which version to install first: `sh install.sh --version v0.8.0`, start it once, then the newer one. A fresh
  install is never refused. A Pro build's `--tarball` is read the same way, from the `CHECKSUMS-pro` (or 0.7.x's `SHA256SUMS-pro`) beside it.
- **A paired Box** is offered releases by the Nouverse update gate, whose `minVersion` already sends a box below a
  release's floor to the version before it.
- **Docker has no updater**, so nothing steps an image through a floor. The docs and the shipped
  `docker-compose.prod.yml` follow the latest image: a fresh install starts on whatever is newest, and one pulled with
  each release passes through the last 0.7.x and 0.8.0 on its way. A container that missed one would reach a release
  with data its floor never ran on, which that release refuses, naming the image to run once:
  `ghcr.io/nouverse/nouride:0.8.0` — and before it `:0.7`, from older than 0.7.28 — then latest again. Each release's
  notes say so.
- **The release itself**, from 0.8.0, reads the record at start, before it writes or locks anything, and refuses data
  with an older record or none — whatever brought the binary there: a Docker tag moved by hand, a tarball unpacked over
  an old install.

---

## Docker

```bash
docker compose up -d
docker compose logs -f      # the first-run password is printed here
```

Nothing to configure first.
A fresh install boots with no `config.toml` and no agents, and everything after that happens in the
browser at `http://localhost:18254/dashboard/` — the provider endpoint and its key, the first agent,
its personality.
No terminal step in the middle, which is the whole point of that flow.

That compose file **builds** from the checkout. On a server that should not be compiling anything,
`docker-compose.prod.yml` pulls the published image instead.

### From the registry

Images are published by `.github/workflows/release.yml` when a `v*` tag is pushed, each
`linux/amd64` and `linux/arm64` in one manifest so the server pulls its own architecture without
being told which:

| Package | Edition | LLM gateway | Multi-user, Nouverse sign-in | Public |
|---|---|---|---|---|
| `ghcr.io/nouverse/nouride` | `basic` | in this process, off until asked | **absent** | yes |
| `ghcr.io/nouverse/nouride-pro` | `pro` | in this process, off until asked | in this process | no |

Until 0.9, `ghcr.io/nouverse/nouride-router` is `nouride` pushed a second time with `NOURIDE_IMAGE_MOVED_TO` set,
so a Router container keeps updating and its dashboard asks for the new name.

**`nouride` is the one to deploy.** `nouride-pro` is the licensed
edition, and Nouverse's managed pods are where its "Continue with Nouverse" button has an issuer to
talk to, so it is not something to hand out. Pointing a free image at an issuer is refused at boot rather than ignored: the
flow is not in that build at all.

The same workflow builds the native tarballs from the same commit and the same test run: the public
ones are attached to the public GitHub release, and the licensed ones go to the internal one and to
the update service, for boxes. The two install shapes are documented here as equals, and a release
that verified only one of them would be claiming something it had not checked.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

A tag needs four secrets: `SUBMODULE_TOKEN` reads the private submodules the free edition (the gateway)
and Pro build from, `RELEASES_REPO_TOKEN` publishes the public tarballs and images, `RELEASE_SIGNING_KEY` signs
every checksum file, and `NOUVERSE_RELEASE_TOKEN` publishes the Pro editions for boxes. The first two
are tried in the workflow's first job, before anything is built. `GITHUB_TOKEN` pushes the private
image, with `packages: write`. **Pulling needs a credential too**, while the package is private:

```bash
# On the server. A classic PAT or a fine-grained token with read:packages, nothing more.
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
docker compose -f docker-compose.prod.yml up -d
```

For Kubernetes the same credential becomes an `imagePullSecret`:

```bash
kubectl create secret docker-registry ghcr \
  --docker-server=ghcr.io --docker-username=<github-username> --docker-password="$GHCR_TOKEN"
```

A package can be made public in its GitHub settings, which removes the login entirely. The image
contains no credentials — `config.toml` holds secret *names* (invariant 3) and `data/` is a volume —
so that is a real option rather than a compromise, and it is the difference between one `docker login`
and a token to rotate on every machine that pulls.

### The first account

The daemon creates one admin account on the first boot of an empty database.

- **Unattended, or scripted:** set `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` in `.env`.
  Both, or neither — half a configuration is ignored rather than half-applied, because a username with
  no password would otherwise get a generated one under a name you chose and read in the log as though
  your setting had been honoured.
- **Otherwise:** the password is generated, printed to the container log once, and **must be changed at
  first sign-in**. It is not stored anywhere in plain text, so losing it means emptying the account
  table and restarting rather than looking it up — see below.

#### Lost the first password

The admin is created whenever the account table is empty, so emptying it is the whole recovery, and
`nouride users reset` does it with the binary you already have. Nothing else goes: conversations,
secrets, grants, memory and agents are not keyed to an account. It refuses while the daemon runs — a
running one holds the database open — snapshots the database before it removes anything, and names
each account it removed.

```bash
sudo systemctl stop nouride
sudo nouride users reset                                  # every account and sign-in, a snapshot first
sudo systemctl start nouride
sudo journalctl -u nouride | grep -A12 'Nouride is ready' # the new admin and its password
```

With Docker the daemon's container is stopped, and the command runs in a one-off container of the same
service, on the same volume:

```bash
docker compose stop nouride
docker compose run --rm nouride nouride users reset
docker compose start nouride
docker compose logs nouride | grep -A12 'Nouride is ready'
```

Two things do not carry over. Every account goes, not just the admin, so on an install with several
accounts each is created again. And the new admin is a new account id, so a People entry that named
the old one as `web:<id>` needs that line updated — the command prints each removed account's id.

`INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD`, if set, are read again on this start, because
the table is empty again — which is a way to choose the new password rather than read it from the log.
The snapshot it took is the way back: `nouride db restore` with the name it printed, daemon stopped.

There is deliberately no "first visitor claims the instance" mode. It is the most seamless option and
it hands the instance to whoever reaches the port before its owner does.

`.env` is still where provider keys and bot tokens go if you would rather set them there than in the
dashboard; the setup wizard writes what you type into the secret store instead — the better home,
since a value in `.env` sits in the daemon's environment — and either way the config file holds only
the *name* of a credential.

The image sets `HOST=0.0.0.0`, because inside a container the container *is* the boundary — a process
bound to `127.0.0.1` there is unreachable through `-p`. Verified the other way round once: with
loopback binding inside the container, `curl` from the host got nothing while the same request inside
the container answered.

### Tools in the image

`bash`, `openssh-client`, `util-linux` (for `script(1)`), `ripgrep`, and `socat` for the package service. Nothing
else — not `git`, not `python3`, not `kubectl`, not a cloud CLI.

The daemon runs as the unprivileged `bun` user and cannot `apk add`. **System packages go through `nouride-pkg`**
(0.8.15), as on a host installed with `--allow-packages`: the entrypoint, root before it hands over, serves it
(`packages/system-packages/root/container`), an agent asks by name and a person approves each change unless the
agent is `trusted`. What agents
installed is kept in `.nouride/system-packages` — the list, and apk's cache — and installed again from the cache
before the daemon starts in a recreated container, online or not. `NOURIDE_SYSTEM_PACKAGES=off` turns it off. To
bake a package into the image instead:

```
docker build --build-arg EXTRA_PACKAGES="git python3 kubectl helm" -t nouride .
```

What an agent installs itself — `npm i -g`, `bun add -g`, `pipx install`, `uv tool install`,
`go install`, `cargo install` — lands in `.nouride/bin`, on the volume, and survives a recreate
(Where the agents work). The installer has to be in the image for that: `npm` is not, `bun` is.

**External agents need Node and npm.** The two built-in coding CLIs install with npm —
`npm i -g @agentclientprotocol/claude-agent-acp` and `… /codex-acp` — and Claude Code's adapter needs Node 22 or later.
The image has neither: its `node` is a link to `bun`. An external agent in a container needs them installed —
`nouride pkg install nodejs npm`, kept across a recreate — or an image built with them:

```
docker build --build-arg EXTRA_PACKAGES="nodejs npm" -t nouride .
```

The image is built on Alpine 3.24, whose `nodejs` is Node 24 (checked 2026-10-27). The orchestrator then installs a
CLI on your yes (`nouride tools run`), into `.nouride/bin` on the volume. In a container every agent runs as the
daemon's user, so *Free in its folder* asks as *Ask when risky* does (§ Each agent its own user).

For infra over SSH you usually need less than you expect — `kubectl` runs on the machine at the far
end, not in here.

### Reaching other machines over SSH

The image carries `openssh-client`; two things it cannot carry have to come from outside.

**The key.** Forward your ssh-agent socket rather than mounting a private key.
A key on disk with no passphrase is a secret this process can read and any subprocess it starts can
copy; a socket is a path whose other end decides, per request, whether to sign.

The socket signs with every key the ssh-agent holds, for whoever asks, so since 0.7.10 an agent is
handed it only when its pack says so — its commands, its sessions, its scheduled commands and its
stdio MCP servers:

```toml
# agents/<id>/config.toml
[security]
ssh_agent = true
```

An agent without it does not see `SSH_AUTH_SOCK` at all. Boot names each agent that ran commands with
the socket before 0.7.10 and would not now, in `nouride doctor` and on Overview's Setup notes;
`ssh_agent = false` says it does not need it, and the note stops. A key named in `~/.ssh/config` is a
file, not the socket, and is not affected.

**Where the agents' ssh config is.** `.nouride/home/.ssh/config` — the agents' `HOME`. OpenSSH on its own reads
`~/.ssh/config` from the home `/etc/passwd` gives the account, not from `$HOME`, so since 0.7.17 the daemon puts
`ssh`, `scp` and `sftp` in `.nouride/bin` (first on the agents' `PATH`) that name the `HOME` config with `-F`, and
that config includes the account's own and the system's (`/etc/ssh/ssh_config`, which `-F` skips) at its end — whatever
ssh read before still applies, on any install, after an update too. Hosts added later land below that include, so a
`Host *` in the account's own config wins over them for an option both set. `~` inside a config is still the account's home, read-only to the service, so write `${HOME}` where a path
has to be writable.

An agent that reaches other machines often does it several times in a row. Three lines in that config keep one
connection open and reuse it, so each further `ssh` skips the handshake:

```
Host *
    ControlMaster auto
    ControlPath ${HOME}/.ssh/cm-%C
    ControlPersist 10m
```

That saves time. The agent is also told to send a whole remote sequence through one `ssh` with a heredoc, which saves
the round trips as well.

```yaml
services:
  nouride:
    environment:
      - SSH_AUTH_SOCK=/ssh-agent
    volumes:
      - ${SSH_AUTH_SOCK}:/ssh-agent          # Linux
      # macOS (Docker Desktop / OrbStack) exposes the host agent at a fixed path instead:
      # - /run/host-services/ssh-auth.sock:/ssh-agent
```

**Host keys.** The agents' HOME is `/app/.nouride/home`, on the volume, so `~/.ssh/known_hosts`
survives a recreate with nothing extra mounted. A host never seen before still prompts, and there is
no terminal to answer, so the command hangs until its timeout rather than failing — it looks like the
network, and it is a missing line. Accept new hosts on first sight:

```
ssh -o StrictHostKeyChecking=accept-new host uptime
```

**Interactive sessions work in the container, and only in the container.** `exec` still runs with
stdin closed — that is the right default for a one-shot command — but the `session` tool opens a
persistent process the agent can type into, so a bare `ssh host`, `kubectl exec -it`, `vim` and a
`sudo` password prompt are all reachable. The terminal comes from `script(1)` in `util-linux`, which
is in the image: a child that checks `isatty` sees a real pty.

A **native macOS** install gets one from the BSD `script` every Mac has. It cannot read its terminal settings
from the socket Bun gives a child for stdin (`tcgetattr` fails), so the daemon hands it a pipe through `cat`.
Native Linux is fine if `util-linux` is installed.

Long-running non-interactive work still belongs in `background: true`.

The container's entrypoint restarts the daemon when it exits, so `nouride restart` works inside the
container; `docker restart <container>` replaces the whole thing.

Keep `.nouride/` on a volume. One mount covers the config, the database, the personas, memory, the
workspace and what the agents installed; `data/` inside it holds the secret store at `0600` and the
control token at `0640` — readable by the service group, so its members run the CLI without `sudo`.

The secret store in the volume is encrypted (0.8.19). Keep its key out of the volume, so a backup of
`.nouride/` carries none: `NOURIDE_ENCRYPTION_KEY` in the compose `.env` (`openssl rand -base64 32`), or a
Docker secret named in `NOURIDE_ENCRYPTION_KEY_FILE`. Without either the daemon makes a key and keeps it in
the volume, and `nouride doctor` says so; given one later, it moves to it at its next start.

---

## Where the agents work

```
.nouride/workspace/
  shared/           every agent. This is where a relative path resolves
  private/<id>/     one agent, and no other can read it
```

**`shared/` is the working directory**, and that is what makes handover possible. Two agents in one
channel delegate by tagging — Nouva writes `@nox benerin build ini` — and with a workspace per agent
the build sat outside every directory Nox was allowed to open, so the sandbox refused it however the
path was spelled. The mention could carry an instruction and never the work. Nothing reported that as
a failure; Nox simply answered that the file was not there.

Concurrent writes are not a concern in that flow: Nox's turn starts from Nouva's reply, so Nouva's turn
has finished. Two agents asked at once in one room do work at the same time, and `write` and `edit`
hold a per-path lock, so neither loses the other's update.

`private/<id>/` is for drafts and scratch, and its `.scratchpad/` for what can be thrown away: it is
the agent's `$TMPDIR`, swept after `[retention] scratchpad_days`, and a delete inside it is never a
hardline (`SPEC.md` §17.4).
Anything another agent may need to pick up does not belong there, and the prompt tells each agent
exactly that.

A mission (0.8.0) works in `private/<id>/missions/<mission>/` unless it was given a folder, and a mission given a
folder in a git repository works in a worktree in its own, `private/<id>/missions/<mission>/worktree`, on a branch of
its own (0.8.1, `SPEC.md` §13.5). The folder goes 7 days after the mission ends; its branches stay in your repository —
`mission/<mission>`, and `mission/<mission>-helper-<n>` for each helper that wrote — and nothing deletes them, so they
pile up until you merge or delete them.

The persona pack is **not** a workspace. Work used to land in `agents/<id>/` — observed on a real run,
with the operator's project built next to `IDENTITY.md` in a git-tracked directory — which is why the
two are separate paths and why `workspace_dir` can point at another disk without moving anything else.

**What they install, and the HOME they run with.** Under a service unit or in the container, the
agents' HOME is `.nouride/home`, where programs keep their settings and logins. Installers are pointed
at `.nouride/` by the settings each one already reads, so a global install lands in `.nouride/bin` —
with what is more than one file under `.nouride/lib` and `.nouride/opt` — with no root and no flags,
and `pip install` lands in one Python environment every agent shares, `.nouride/opt/python`, which
still sees the system's own packages. Every command gets one `PATH`: `.nouride/bin` first, then that
Python env, the system's directories, and `~/.local/bin` and `~/.cargo/bin` last. All of it survives
restarts, updates and container recreates; `nouride doctor` lists it and says what needs a look.
On a person's own machine, a plain `nouride start` leaves their HOME, npm and pip alone.

### Each agent its own user (0.8.0)

On Linux with systemd, `install.sh` installs `nouride-run` — a small root helper, `/usr/local/lib/nouride-run/`, with
its socket `nouride-run.socket` — and each agent's commands run as its own user, `nr-<agent>`, made at the daemon's
first start. One agent's command no longer reaches another agent's private folder, the daemon's database and secret
store, or the credentials it was not given. Check it with `nouride doctor`: `agents' commands: each as its own user`,
and a line per agent.

What changes for the agents, and what an operator may have to do:

| What | Since 0.8.0 | If you need the old reach |
|---|---|---|
| `private/<id>/` | the agent's own, and its HOME; at its first start, a copy of the shared HOME's logins and settings (`gh`, `.gitconfig`, a kube config, Claude Code's), its `~/.ssh/config` and `known_hosts` — not the caches. The Claude Code login copied there is for the agent's own commands: an external agent's CLI signs in apart (below) | a login that renews its own token (Claude Code's) may ask one agent to sign in again |
| `shared/` | every agent's to read and write; a file there is its maker's, so only its maker changes its mode | — |
| Installs | into the agent's own `~/.local` (its `$NOURIDE_BIN`); what every agent runs — `.nouride/bin`, `lib`, `opt`, and the programs in the shared HOME (`claude`, Rust) — is the orchestrator's to install and update, with `nouride tools run -- <command>` | the orchestrator's switch, on by default: its agent page in the dashboard, or `[security] shared_tools = false` in its pack |
| Job logs, attachments, long tool output | moved from `data/` to `.nouride/jobs`, `attachments`, `tool-output` at the first start; each agent reads its own | — |
| The credentials directory | read by every agent unless its pack says `[security] credentials = false`; the default one moved from `data/credentials` to `.nouride/credentials` | — |
| A declared root (`[workspace] roots`) | reached as the agent's own user: `doctor` names one it cannot write, with the grant | `sudo setfacl -R -m u:nr-<id>:rwX -m d:u:nr-<id>:rwX <root>` |
| An agent id that is not a user name (`Nouva_2`) | its commands are refused, said at boot and by `doctor` | rename the pack's folder: lowercase letters, digits and dashes |
| A stdio MCP server (0.8.1) | runs as the agent it serves, with its HOME and installs, started in its folder unless the server's block names a `cwd` — a folder that agent's user may enter | a sign-in or settings it kept in the daemon's HOME are unreadable to it now: sign it in again for each agent, give it its token through `env_secrets` where it reads one, or copy what it saved into `private/<id>/` |
| A coding CLI (0.8.1) | an external agent's CLI runs as the agent, with its HOME and installs, from its folder; its sign-in is in `private/<id>/.cli/<cli>/<profile>/`, where `CLAUDE_CONFIG_DIR` or `CODEX_HOME` points it — not the Claude Code login copied into its HOME | sign it in on its Brain tab, or a shared Claude Code account once on **Models → Coding CLIs** |

The daemon's own CLI, run for an agent by the `nouride` tool — `nouride tools run` among it — stays the daemon's user.

Where it does not apply, commands, stdio MCP servers and coding CLIs run as the service user, as before, and boot
says why: in a container (the container is the boundary), on macOS, without systemd, or on Alpine without `useradd`
(`apk add shadow`, then run `install.sh` again). There an external agent's default preset is *Ask when risky*, and a
pack's *Free in its folder* asks as it does: the CLI would run unasked as the user that reads the database and the
secret store. `[security.exec] landlock` adds Landlock on top where the kernel has it — off at boot on many
distribution kernels; `doctor` says which.

---

## What to keep

- **`agents/`** — `MEMORY.md` above all. Months of accumulated identity, not in git.
- **`memory/`** — the vault: every conversation, every profile, `shared.md`. The database holds only
  its index, rebuilt from these files; nothing rebuilds the files.
- **`data/`** — conversations, audit log, standing exec grants, secret store, and the daemon's own state in its
  database: which agents are asleep, each external agent's CLI sessions and accounts, the alert cooldowns.
- **`config.toml`**, **`people/`** (one file per person, since 0.8.18) and **`.env`**.
- **The secret store's key** (0.8.19), kept apart from the rest on purpose: `/etc/nouride/nouride.env` where
  `install.sh` put it, `~/.config/nouride/nouride.env` on a Mac, or wherever you keep `NOURIDE_ENCRYPTION_KEY`. A copy
  of `.nouride/` without it cannot open the store, which is the point; set a backup passphrase (below) and the
  passphrase alone recovers the secrets on any machine.
- **`workspace/`** — whatever the agents have built. Output rather than identity, so restore it if you
  want the work back and skip it if you only want the daemon back. But `workspace/private/<id>/` also holds each
  external agent's CLI sign-ins (`.cli/`) and, where each agent is its own user, its HOME — its logins and its stdio
  MCP servers' sign-ins. Skip it and each of those signs in again; only a shared Claude Code account, whose token is
  in the secret store in `data/`, does not.
- **`bin/`, `lib/`, `opt/`, `home/`** — what the agents installed, and their logins. Rebuildable by
  reinstalling, which is slower than restoring.

The daemon snapshots itself into `data/backups/`, at boot and then weekly, keeping `[daemon] backup_keep` (four):
the database into `db/` — verified before each is kept, and `nouride db restore <file>` puts one back
with the daemon stopped — the packs into `agents/` (their `skills.toml` and `mcp.toml` with them), the vault into
`memory/`, and since 0.8.18 `config.toml`, `people/` and the MCP library into `config/` and the skill pool into
`skills/`, hard-linking what did not change. The secret store goes into `config/` only sealed, once `nouride secret
seal --stdin` has given it a passphrase; `nouride secret unseal` opens it with that passphrase and nothing else. Since
0.8.19 the copy sealed beside the store, `data/secrets.sealed`, is made again at each change of the store, and
`nouride secret restore --stdin` puts it back under this install's key, for a lost key or an install moved without
its key (run it with Nouride stopped). A config file's own last versions are beside it as `<file>.bak.1` to
`.bak.5`, the older ones under `history/`, and an improved skill's earlier text under `agents/skills/.history/`. A boot within a week of the newest snapshot takes none, so a box that restarts nightly for its
update does not snapshot at every boot: each database snapshot writes and reads back the whole file.

Those land on the same disk as what they protect. `[daemon] backup_dir` moves the scheduled ones
elsewhere — a USB drive, on a box that runs from an SD card. Point it at a directory *on* the drive
(`/mnt/usb/nouride`, not `/mnt/usb`): it is never created, so while the drive is unplugged snapshots are
skipped and logged rather than written into the empty mount point on the card. The snapshot taken before a
schema migration stays in `data/backups/db/` either way — it is the way back from an upgrade, and must
not depend on a drive. For the failure that takes the disk, `tar` over `.nouride/` and `.env` with the
daemon stopped is still the whole procedure.

Put back in another folder, or on another machine at another path, `.nouride/` works as it did: the first start
there finds the paths its database names under the folder it was in (attachments, job logs, a mission's folder, the
directory an "always allow" is bound to) and names them under the new one, and logs `the install was moved`. An
"always allow" for a command that is handed a secret asks once more. The same for `data_dir`, `workspace_dir` or
`agents_dir` set to another disk on its own: what is under it follows, and what stayed keeps its paths. Since 0.8.18,
for an install that has started on 0.8.18 at least once where it was.

The secret store's key does not move with the folder (0.8.19): it is kept apart so a copy of the folder cannot open
the store. Bring it along (the `NOURIDE_ENCRYPTION_KEY` line, in `/etc/nouride/nouride.env` on the new machine), or,
with a backup passphrase set, run `nouride secret restore --stdin` there before the first start: the store is written
again under the new machine's key, and the one it could not open is kept aside as `secrets.enc.unopened-…`. Without
either, the daemon refuses to start and says which key it needs.

### The secret store at rest, and the way back from 0.8.19

0.8.19 encrypts `data/secrets.json` into `data/secrets.enc` once the update is confirmed (the guard's way back needs
the old file until then), and removes the plain file after reading the new one back. Back to 0.8.18 after that,
`sudo nouride update --rollback --apply` with Nouride stopped writes `secrets.json` for it (above). Any other way:

```bash
sudo nouride secret decrypt --out /tmp/secrets.json     # as root, who can read /etc/nouride/nouride.env
# stop Nouride, move /tmp/secrets.json to .nouride/data/secrets.json (the service user's, 0600), install 0.8.18
```

Coming forward again, a `secrets.json` newer than `secrets.enc` is what 0.8.18 last wrote, and it is the one read and
encrypted. What encryption does not cover, said plainly: root on the machine, the running daemon (it holds the
values to use them), a whole image of a disk on a machine with no TPM (the key file is on that disk too), and blocks
the old plain file left on the disk, which only the operating system's disk encryption covers.

---

## When a boot refuses over the schema

```
✗ refusing to start: the migrations applied to this database are not the ones in this build.
```

The daemon keeps a fingerprint of the migrations that were applied to its database in `PRAGMA
application_id`, and refuses rather than querying a schema it may be wrong about. Two causes, and
they need opposite answers:

- **The build is wrong for this data directory** — an already-applied migration was edited, or this
  is a binary from a different lineage. Use the build that matches, or `nouride db restore`.
- **The build is right and the schema was deliberately rewritten** — a squash is the case that
  exists. Accept it once, with the daemon stopped:

```bash
systemctl stop nouride
nouride db adopt
systemctl reset-failed nouride   # only if it crash-looped first
systemctl start nouride
```

`reset-failed` is not optional after a refusal: systemd rate-limits restarts, and a start that says
`Start request repeated too quickly` is that limit rather than a second refusal. Seen on
the live box upgrading onto the first baseline, in September 2026, which is what the sequence above was written
from.

`NOURIDE_ALLOW_SCHEMA_DRIFT=1` starts a daemon without accepting anything, for getting a box up
while you work out which build is right. It does not adopt, so the next boot refuses again.

Three other refusals, each naming its way out:

- **`this database is at schema N, and this build only knows up to M`** — a newer build migrated it,
  usually an update that was rolled back. Start the newer build again, or restore the snapshot taken
  before that upgrade.
- **`this database is at schema N, from before 0.8.0`** — a database no 0.8.0 has migrated (a 0.7.x
  snapshot put back by hand, say), or one a squash left between two versions. Install 0.8.0 and start it
  once (§ The upgrade window), or restore a snapshot taken by 0.8.0 or later. Below 68, 0.8.0 refuses it in
  turn and names 0.7.28.
- **`the SQLite inside this build cannot hold the memory index`** — the build, not the data. Release
  binaries bundle a SQLite with FTS5 and what the index needs; `nouride doctor` prints the version.

**Going back a release.** Before the first migration of an upgrade, the daemon writes
`data/backups/db/nouride-<time>-before-<version>.db`, which the daily rotation leaves alone. With the
daemon stopped, `nouride db restore` that file, then install the older build. A snapshot from before
0.8.0 (schema below 69) is refused since 0.8.1: going back to 0.7.x is 0.8.0's `nouride db restore` of the
`…-before-069.db` it took, and to 0.6, 0.7.29's of `…-before-048.db`, which also puts the memory vault's day
pages where 0.6 expects them.

From 0.8.1 back to 0.8.0 there is no database step: 0.8.1 migrated nothing, so 0.8.0 opens the database as it is.
Install 0.8.0's build and start it. 0.8.0 does not read 0.8.1's `[external]` and `[look]` in a pack or
`[[external_clis]]` in `config.toml`: it warns about each as an unknown key and goes on, and an external agent
answers with its `[llm]` model until 0.8.1 is back.

---

## Alerts

Set these before you walk away from it:

```toml
[alerts]
gateway = "telegram:nouva"
chat_id = "123456789"
cooldown_ms = 300000
```

Without them a dead gateway is only a line in the journal, so you find out when you notice the agent
has gone quiet — which is hours later and looks like a different problem. Boot warns when chat
gateways are enabled and this is empty.

What arrives there: a gateway that gave up reconnecting, a WhatsApp session needing relinking, a reply
a platform refused to deliver, a pairing code someone was shown, and the disk running low. Suppression
is per *kind* of alert, not per message, so a reconnect loop reporting "gave up after 3 attempts" then
"after 4" is one alert rather than a flood.
