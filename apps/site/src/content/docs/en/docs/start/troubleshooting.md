---
title: When it does not work
description: The failures a fresh install actually hits, and what each one really is.
---

Start here:

```bash
nouride doctor
```

It checks the things that commonly stop a fresh install, a provider with no credential, an agent
pack that did not load, a gateway stuck reconnecting, no agent enabled at all, and every finding
says what to do about it. It exits non-zero on a real problem, so it also works inside a healthcheck.

[What doctor checks, in full →](/en/docs/cli/doctor/)

---

## Install

| What you see | What it usually is |
|---|---|
| `unsupported architecture` | 32-bit ARM. You need a 64-bit OS, see [Raspberry Pi](/en/docs/start/install/#raspberry-pi-and-orange-pi) |
| Binary "not found" on Alpine, and the file is right there | musl versus glibc, or a missing `apk add libstdc++` |
| `download failed` | No release at that URL yet. Build one and pass `--tarball`, or `--repo` to pull from GitHub releases |
| The install finished but `nouride` is not a command | `/usr/local/bin`, where the launcher goes, is not on your `PATH`. Run it by full path: `@@INSTALL_DIR@@/nouride status`. On a Mac the installer links it only when it can write `/usr/local/bin` or `~/.local/bin` exists: run `~/nouride/nouride status`, or create `~/.local/bin` (on your `PATH`) and run the installer again |
| `Permission denied reading …/.control-token` | The installer added you to the `nouride` group, which applies from your next login. Run `newgrp nouride`, or `sudo nouride …` |
| `doctor` warns that a restart kills the command a turn is running | The service unit is from before 0.7. Re-run the installer once: it rewrites the unit and leaves `.nouride/` alone |

## Starting

**The service starts and `/health` never answers.** The daemon refused its config and exited
*after* systemd reported success. `systemctl start` returning 0 means a process was spawned, not that
it is serving.

```bash
sudo journalctl -u nouride -n 50 --no-pager
tail -n 50 ~/nouride/.nouride/data/nouride.log    # on a Mac
```

**It refuses to start: "this release upgrades only from 0.8.0".** The data was last run by a 0.7.x, and 0.8.1 starts
only on data 0.8.0 has run on. Nothing was written. Install 0.8.0, start it once, then this version again (from older
than 0.7.28, 0.7.29 once before that); on Docker, the `0.8.0` tag once on the same volume. The refusal says the same.
A snapshot from before 0.8.0 is refused by `nouride db restore` the same way: "install 0.8.0 first".
[Upgrading to v0.8 →](/en/docs/deployment/upgrading-to-0-8/)

**`/health` says `starting` for a long time.** A booting daemon answers from its first second, with a
503 and the step it is on in `phase`: `checking the database` on a large database after a crash,
`connecting MCP servers` while a server is slow to start (boot waits ten seconds for each, then goes on
and lets it join later), `connecting gateways`. `nouride status` and the dashboard say the same. A step
that does not move is where to look in the journal.

**`nouride status` reports no daemon while one is clearly running.** Until setup has written a
config, the CLI resolves the install relative to your working directory, so from `/tmp` it looks for
`/tmp/.nouride/data/.control-token`. The error names the path it wanted, which is the fastest way to
spot this. Run it from the install directory, or set `NOURIDE_URL` and `NOURIDE_TOKEN`.

**`nouride restart` refuses.** A person needs no flags; only an agent is asked for
`--then "<follow-up>"`. If it answers *nothing would restart this daemon*, nothing supervises it: a restart asks the daemon to exit so its supervisor brings it back,
and without one that would be just a stop, so it refuses; `--force` stops it anyway. `nouride service status` says plainly whether anything would
respawn it.

## Reaching the dashboard

| What you see | What it usually is |
|---|---|
| Unreachable from another machine | Bound to loopback by default. Re-run the installer with `--host 0.0.0.0`, or tunnel: `ssh -L @@PORT@@:127.0.0.1:@@PORT@@ you@host` |
| Published Docker port reaches nothing | `HOST` is set to a loopback address, often in `.env`. The image binds every interface unless told otherwise; a container that binds loopback binds *its own* loopback |
| The page loads but every asset 404s | The `dashboard/` directory is not beside the binary. They travel together, reinstall from the tarball rather than copying one file |
| Missed the first-run password | It is shown once. On a Mac it is still in `~/nouride/.nouride/data/nouride.log`. Otherwise stop the daemon and run `sudo nouride users reset` (on a Mac, without `sudo`); the next start prints a new one ([first run](/en/docs/start/first-run/#find-the-first-time-password)). Set `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` in `.env` before the first start so it cannot happen again |

## The agent does not answer

**Nothing at all, on any surface.** No agent is running. `nouride agents` lists what loaded and what
state each is in; a pack that failed to parse is reported by `nouride doctor` with the error.

**One agent does not load after an upgrade.** `nouride doctor` and `nouride config check` name the pack and the line;
the other agents load. Two are new in 0.8.1: `[llm] fallback_model`, which 0.8.0 rewrote and which came back from git
or a hand edit (write `fallbacks = [{ provider = "…", model = "…" }]` in its place, as the error says), and a word
under `[look]` that is not one of its part's, where the error names the words the part takes.

**It answers in the dashboard but not in a chat app.** Either the connection was saved but the daemon
has not restarted, adapters are built at boot, or the sender has not been let in. Check
`nouride gateway` for the connection and `nouride access` for the person.

**It answers in a DM but ignores a group.** On Telegram, privacy mode is on: `/setprivacy → Disable`
in BotFather, or make the bot an admin. If several of your bots share the group, a message has to
name one of them. Otherwise `groups_require_mention` is doing what it says, and the agent is waiting
to be addressed by name.

**It says it was offline when you sent a message.** The message arrived more than 15 minutes before
the daemon could take it, during an outage or a long restart, so it was not answered late. Send it
again.

**It stopped mid-task and says it was interrupted by a restart.** Everything it did is kept, and if
the daemon was back within 15 minutes it carries on by itself, once. If it does not, say "continue"
and it picks up from there; a command that was cut off is marked as such.

**It replies "I cannot do that" to something it should be able to do.** The tool is not on that
agent's list. The agent's **Settings** tab in the dashboard shows which tools it has, and the agent's
`[tools] enabled` in `.nouride/agents/<id>/config.toml` is what grants them.

**Every message fails with a model error.** The provider profile has no credential, or the wrong one.
`nouride doctor` names the profile; `nouride secret` lists which credential names exist, never their
values.

## Commands and files

**A command is refused however it is spelled.** The directory is not a workspace root for that agent.
`nouride doctor` reports a declared root that does not exist, the case where everything else looks
green while every path is rejected.

**An agent asks for approval on something harmless, every single time.** At `careful` a new command asks once and
*allow always* remembers it; only the fixed list asks every time. Check what a command is with:

```bash
nouride policy check rm -rf /tmp/build
```

That answers "would this be gated" without running anything, and it works while the daemon is down,
which is exactly when somebody is debugging a refusal.

**An agent keeps asking about `terraform destroy`.** Tearing infrastructure down is on the fixed list: under
`careful` it asks every time and can never become a standing grant. Creating and changing (`terraform apply`,
`kubectl apply`) ask once at `careful`, as any new command does, and *allow always* remembers them. The read halves,
`plan`, `get`, `describe`, anything with `--dry-run`, are not gated at all.

## External agents and MCP servers

| What you see | What it usually is |
|---|---|
| **Answered by** offers no CLI, or `nouride agents scan` says "No room for a coding CLI here" | The agents' commands may hold less than 512 MiB, the floor for one CLI session. `nouride doctor` says how much they may hold; give the box more memory |
| The agent's status says its CLI is not installed | `nouride agents scan` lists each CLI with the command that installs it. [Installing a CLI](/en/docs/manual/external-agents/#installing-a-cli) |
| The agent's status says its CLI is not signed in | Claude Code: **Sign in** on Models → Coding CLIs. Codex: **Sign in** on the agent's Brain tab. Or `nouride agents login <id>` |
| "… did not pass Nouride's check", and the agent stopped | The CLI was updated, and the new version did not answer Nouride's one-line check. Go back to the version before (the same install, with `@<version>` after the package), or update Nouride; the other agents go on |
| An MCP server stays not connected after boot | It did not start: the journal says why, and `mcp server did not start, trying again`. Since 0.8.10 it is started again, waiting longer each time up to five minutes, until it comes up. A `uvx` or `npx` server fetches itself the first time (`uvx` a Python with it), which takes minutes on a slow link; a stdio server has five minutes to answer the handshake |
| A stdio MCP server lost its sign-in after the upgrade | Since 0.8.1 it runs as the agent's own user, which cannot read what it saved in the daemon's HOME. Sign it in again for each agent, give it its token through `env_secrets` where it reads one, or copy what it saved into the agent's own folder |

## Memory and load

**The box gets tight during a build.** Commands the agent spawns run at `nice 10`, and the generated
systemd unit carries a soft `MemoryHigh` ceiling at 80% of what the machine reports. On Raspberry Pi
OS the memory cgroup controller ships disabled, so systemd accepts that setting and enforces nothing:

```bash
systemctl show nouride -p MemoryCurrent --value   # `[not set]` means it is inert
```

Add `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt` and reboot.

**A build ended with `Killed`.** Since 0.7.19 an agent's commands share a cap of their own, below the
unit's ceiling, so the daemon keeps answering however heavy they get, and the command that outgrows
the cap is the one stopped (exit 137), and the agent is told so even when a pipeline exits 0. `nouride doctor` says how
much they may hold together; run fewer
at once, or give the box more memory. On a unit from before 0.7.19 doctor warns instead: re-run the
install script to rewrite it.

[Footprint and sizing →](/en/docs/architecture/performance/)

## Still stuck

```bash
nouride logs -n 200          # the daemon's own log: works with no journal, and remotely
nouride status               # agents, gateways, queue, on one screen
nouride config check         # validate the config without starting anything
```

`nouride logs` reads the log the daemon keeps itself, so it works on a machine with no journal and
against a remote daemon over `NOURIDE_URL`.
