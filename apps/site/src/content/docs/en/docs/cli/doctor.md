---
title: doctor
description: One command that checks the things which actually stop a fresh install.
---

```bash
nouride doctor
```

Every finding says what to do about it, and the command **exits non-zero on a real problem**: so it
works inside a healthcheck or a CI step, not only in front of a person.

## What it checks, in order

The order is deliberate. The half that works with no daemon runs first, because a config broken
enough to matter is usually why nothing is running.

**From disk, daemon or not**

1. **Which config is loaded**, and which data directory. Two lines, and they are the fastest way to
   spot that the CLI found a different install than the one you meant.
2. **The config itself**: every lint `nouride config check` knows, with its hint.
3. **The SQLite inside this binary**, and whether it has FTS5, which the memory index needs. A build
   without it refuses to start; release binaries all have it.
4. **System packages**: on and with which package manager, off, or not used here. Off is a choice,
   so it is stated rather than warned about.
5. **What the agents have installed.** See [the toolchain lines](#the-toolchain-lines).
6. **The systemd unit**, when there is one. A unit from before 0.7 kills the command a turn is
   running at the start of a restart, instead of letting the turn finish its step. Re-run
   `install.sh` once; it leaves `.nouride/` alone.

**From the daemon**

7. **Can it reach the daemon?** Everything below depends on this, so a failure here reports one
   accurate line rather than a wall of consequences, and stops. When it can, the next line is the
   daemon's own memory, resident and the JavaScript heap in use, as `/health` reports it (since 0.7.11):
   said, not judged.
8. **The memory index's own integrity check.** The index is a cache of the vault, so the fix is
   `nouride memory reindex`, not a restore.
9. **Durable turns**: how many turns are in flight and how many messages are waiting.
10. **Providers with a credential.** None at all is a hard failure, no agent can answer. One profile
    without a credential is a warning.
11. **Agent packs that failed to load**, with the parse error.
12. **Agents actually running.** None is a hard failure, and the hint distinguishes "none exist" from
    "loaded but disabled".
13. **Declared workspace roots that do not exist.** This is the check that was missing when a whole
    class of confusion happened: everything else reported green, agent running, gateway connected,
    provider credentialed, while every path inside that root was refused, which reads as the agent
    being broken.
14. **Agents pointing at a provider with no key**, or at one that is not configured at all. This is
    the failure that looks like a model outage.
15. **Gateways**, one line each. One that is `dead` is a failure with the restart command in the
    hint; any other state but `connected` is a warning, and so is no gateway at all.
16. **Approvals waiting**, because a tool call is blocked until answered.
17. **Messages queued**, because turns may be backing up.
18. **Skills whose host software is missing.** A warning if an agent has it on; noted and dismissed
    if nobody does.
19. **Skills an agent carries but cannot run**: the tool axis, per agent, listing only what is
    actually missing for that one.
20. **Skills with no read on record**, reported as fine rather than as a fault.

## The toolchain lines

Agents install programs without root, into `.nouride/bin`. These lines are read from disk, so they
answer with the daemon down. Who installed what is in `nouride audit`; this is the state.

- **What is there**: every program in `.nouride/bin`, where each link points, and which ones are found
  ahead of a system program of the same name.
- **A link into a cache** is a warning: clearing that cache, which anybody short of disk would do,
  breaks the program with nothing saying why. **A broken link** is the same failure after it happened.
- **A program that hides one every agent depends on**, such as `git`, `tar`, `python3`, `node` or a
  shell, is a warning. The bin directory comes first on every command's `PATH`, so that copy is what
  every agent runs.
- **A `package.json`, `package-lock.json` or `node_modules` in `.nouride/`** means somebody ran
  `npm install` there instead of a global install. Nothing reads them.

Where the agents' `HOME` is `.nouride/home`, which a service unit and the container give them, three
more:

- **Where installs land**: global `npm`, `bun`, `pipx`, `uv`, `go` and `cargo` installs go to
  `.nouride/bin`, which the daemon sets up at start.
- **The shared Python env**, `.nouride/opt/python`: what `python3` and `pip` are for agents, and what
  `pip check` says about it. Every agent installs into the same env, so one agent's upgrade can break a
  package for all of them; the hint says how to put it back. A requirement `pip check` calls missing
  but Python imports, such as a module the OS's own package ships without pip's metadata, is not
  counted as broken. Not built means `pip install` meets
  PEP 668. The daemon builds it at start, and its log says why it could not, usually a missing
  `python3-venv` package.
- **Disk use** of `bin`, `lib` and `opt` and the installers' caches in `home`, so a full disk has a
  first place to look.

On Linux, one more: `/usr/local/bin/nouride` **as a link** to the install's binary means root running
`nouride` runs a file the service account can change. Since 0.7, `install.sh` puts a launcher there
instead, which runs the CLI as the service account. Re-run it once.

## What the output looks like

A run on a service install, shortened:

```
nouride doctor

  ✓ config: /srv/nouride/.nouride/config.toml
  ✓ data dir: /srv/nouride/.nouride/data
  ✓ sqlite: 3.51.0, with FTS5
  ✓ system packages: off, so agents install into their own bin directory (install.sh --allow-packages turns it on)
  ✓ agents' programs in /srv/nouride/.nouride/bin: ffprobe → /srv/nouride/.nouride/home/.bun/install/cache/ffprobe, gh
  ! agents' programs: ffprobe is a link into a cache (/srv/nouride/.nouride/home/.bun/install/cache/ffprobe): clearing that cache breaks it
    Reinstall it properly, or remove it: rm /srv/nouride/.nouride/bin/ffprobe
  ✓ daemon reachable at http://localhost:@@PORT@@ (up 3120s)
  ✓ daemon memory: 72.8MB resident, 8.7MB of it JavaScript heap in use
  ✓ memory index: FTS5 integrity check passed
  ✓ providers with credentials: nougate-anthropic
  ✓ agents running: nouva, nox
  ! nouva: workspace root /home/you/projects/thing does not exist
    Nothing in it can be read. Check [workspace] roots in agents/nouva/config.toml. A leading ~ expands to your home directory, and a relative path resolves against the agent's own folder.
  ✓ gateway web:dashboard: connected
  ✓ gateway telegram:nouva: connected
  ✗ gateway discord:main is dead
    Check its token, then `nouride gateway restart <id>`.

1 problem(s), 2 warning(s)
```

`✓` is fine, `!` is worth knowing, `✗` is what is actually broken. Only `✗` affects the exit code.

## The old forms

From 0.7.11 to 0.7.28 the report ended with a "Ready for 0.8.0" section listing each old form this install
still used. 0.8.0 starts only on data 0.7.28 has run on, and refuses each of those forms where it is read
(the daemon for `config.toml`, that agent for a pack), saying what to write instead;
[Updating](/en/docs/deployment/updating/#from-an-older-version) lists them. So the section is gone.

## Two findings worth explaining

**"skill X needs `dot`, not installed here."** A skill declares the programs it needs in its
frontmatter, which is what makes this checkable at all. Without the check the failure is invisible
until it is expensive: the skill loads, the agent reads it, follows the procedure, and step four dies
on `dot: command not found`: halfway through a task, with an approval already spent.

**"N of M skills have no read on record."** Every skill costs a line of *every*
agent's system prompt on *every* turn, whether or not it is ever read, measured at ~3.4 KB for
eighteen of them on a live box. So one nobody has opened is a bill nobody chose to pay.

The record keeps every read of a skill since 0.7.27, however long ago, and outlives the audit log's
`[retention] audit_days`. Reads from before that are known only as far as the audit log still held
them at the upgrade (30 days by default), so "no read on record" is what can honestly be said, not
"never read".

## When it cannot reach the daemon

It stops there and says so, with everything it could check from disk already on screen. The config
path and the data directory are usually the answer. Three cases say more:

- **No control token** where the CLI looked: doctor prints only that, with the path it expected.
  Either the daemon has never started there, or the CLI found a different install than the one
  running.
- **Permission denied** on the token: it belongs to the service account, and doctor prints only that.
  Run `sudo nouride doctor`, or add yourself to the service group.
- **Another install's daemon** answering on the same port is named as such: every install uses the
  same default port, so the first one started wins it.

## Related

```bash
nouride config check [file]     # would this configuration start? Nothing is launched
nouride status                  # agents, gateways, queue
nouride update                  # version, edition, install directory and supervisor; changes nothing
```
