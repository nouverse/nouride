---
title: Updating
description: Checking whether a newer Nouride exists, and installing it, from the dashboard, the CLI, or the agent itself.
---

An install can tell you it is out of date, and most can replace themselves. Which one yours is
depends on how it was delivered, and the daemon works that out rather than making you.

```bash
nouride update --check
```

```
This install
  version      <current>
  edition      basic
  platform     linux/x64
  directory    @@INSTALL_DIR@@
  supervisor   systemd
  track        latest

✓ up to date: <current> is the newest release built for this edition.
```

An install that is behind gets the other shape, and it names the artifact it would take:

```
↑ <current> → <latest>
  published    2026-09-15T05:54:36Z
  notes        https://github.com/@@GITHUB_REPO@@/releases/tag/<latest>
  artifact     nouride-linux-arm64
```

**Version and edition together are what "what is deployed here" means.** Two boxes on the same
version can differ in whether the LLM gateway is compiled in and whether they can do Nouverse
sign-in, so the edition is on `/health` as well, `{"version":"<current>","edition":"basic",…}`.

## Which releases: the update track

Since 0.8.18 an install follows one of two tracks, set on the dashboard's Update page or with
`nouride update --track latest|lts`, and kept as `[update] track` in `config.toml`:

- **`latest`**, the default: every release as it comes, new features with the fixes.
- **`lts`**: a long-term line, 1.0 the first. An install on an older line moves to it and stays on
  it, taking only its fixes. Until a newer line is out beside it, both tracks offer the same.

`nouride update` says which track it follows, and names the other track's release when it differs:

```
  v1.1.0, new, is on the latest track; this install follows lts and stays on its line (`nouride update --track latest` moves it on)
```

A Pro install or a Box asks Nouverse instead of the public mirror, and Nouverse chooses within the
same track.

## Taking one

```bash
nouride update --start
```

From a terminal that is the whole command. An agent taking the update passes the follow-up it will
come back to:

```bash
nouride update --start --then "confirm the version changed and every gateway reconnected"
```

The daemon downloads the tarball for **its own** edition and platform, checks it against the
release's checksums, swaps the files, and keeps the previous version in `.nouride-previous/` beside
the new one.

Then it **waits for idle**: it restarts once no turn is running or queued and no approval is
waiting, or after ten minutes, whichever comes first. A turn cut off then keeps what it did, and the
agent carries on with it once the daemon is back. A background job (a build, a test suite, a coding
agent's run) is waited for until it finishes, however long that takes, and the update says which job
it is waiting for. A service such as a dev server does not count: it runs until it is stopped, so
waiting for it would never end. `--now` restarts at once and stops the jobs. A message sent while
the daemon restarts is answered once it is back, if it was sent in the last fifteen minutes.

Nothing here needs root. `install.sh` gives the install directory to the service user, so the daemon
owns the files it is replacing, and it restarts by exiting for its supervisor to start the new binary
rather than by calling `systemctl`.

The CLI does both steps in one command. The dashboard splits them, because there it is worth being
able to fetch a release now and install it later.

The follow-up turn is **created before the download and armed when the restart happens**. That
ordering is not decoration: on a Raspberry Pi the download takes about 35 seconds, so a follow-up
whose clock started when it was created fired *into the update*, was killed by the restart, and,
being a one-shot, was gone. Until it is armed it sits fifteen minutes out, which is when you would be
told if the swap had killed the process instead.

:::caution[An agent must pass `--then`, and it is not ceremony]
The restart ends the conversation the command was run from, so the turn that ran it can never check
the result. The follow-up turn is created **before** anything is touched, so a daemon that comes back
wrong is still met by whoever asked, and one that does not come back at all is met as soon as it
does. A person at a terminal is watching it themselves and needs nothing extra; `--no-then` says so
explicitly.
:::

## If the new version does not come up

The previous one comes back by itself. A new version is on probation until it proves itself: a chat
gateway connected, when there are any, and a message handled, or five minutes up on an install with
nothing to handle. Until then the unit's start guard counts its starts, and on the fourth it puts
`.nouride-previous` back and starts that instead. The guard lives in the unit the installer writes,
outside the binary, because a new binary that crashes at once cannot rescue itself. The version that
runs afterwards logs what happened.

## If the new version is wrong

A version that starts and then misbehaves is past the guard, so going back is one command, run with
the daemon stopped:

```bash
nouride update --rollback            # what it would do, changing nothing
nouride update --rollback --apply    # do it
```

It puts the kept build back, and keeps this one in its place, so the same command on the older version
goes forward again. When the update migrated the database, the older binary would refuse the newer
schema, so the database goes back too, to the snapshot that migration took. That loses what happened
since, and the first command says so, with the time, before anything is touched. The database it
replaces is set aside beside it, so the rollback itself can be undone. The version you left is not
taken again by an automatic update.

Back to a version before 0.8.19, which reads the secrets only as `secrets.json`, the secrets go back with it in that
form, at `0600`; the encrypted store stays beside it, and 0.8.19 encrypts the newer `secrets.json` again when it comes
back, with whatever the older version changed. That opens the store, so on Linux run it as root (`sudo nouride update
--rollback --apply`): the store's key is root's file, and the launcher hands it over. Without the key it says so and
changes nothing.

Going back to a version before 0.8.19 any other way, its own `install.sh` say, take the secrets out first, as root:

```bash
sudo nouride secret decrypt --out /tmp/secrets.json
# stop Nouride, move /tmp/secrets.json to .nouride/data/secrets.json (the service account's, 0600), install that version
```

`install.sh` keeps the build it replaces too, so this works after either kind of upgrade. A kept build
that another version put aside (an older `install.sh`, a copied binary) is refused: it is not the one
before this.

## From the dashboard

The top of **Home** carries a badge beside **Restart**, *Up to date*, or the version that is
waiting. It is the way in: pressing it opens **Update**, a tab of **System** in the menu for an
admin, and a card on Settings for anyone else.

**Your box**, at the foot of the sidebar, shows the running version and opens Update when pressed,
with a note on it when something newer is out. The version under the wordmark gets a dot then too.
That dot is a signal, not a door: the brand goes home, and the badge or the card is what you press.

![The Update page: the running version and edition on the left, and the newest release for that edition on the right](/media/dashboard-update.png)

Everything the page needs to be trusted is on it: what is running and what edition that is, with what
platform, where it lives and what is supervising it under Details, and, beside that, the newest release
**for this edition** rather than the newest tag.

The page checks on arrival, every time. There is a **Check again** button for the impatient, and
then two steps:

1. **Download.** Fetches the release and checks it against the channel's checksums. Nothing that is
   running is touched. It can be **paused** and picked up where it stopped, a release is tens of
   megabytes and on a home connection that is a real wait, or thrown away entirely.
2. **Install and restart.** Only once the download has finished. Swaps the binary in and restarts the
   daemon, waiting for idle as above.

Each of the two that act asks first, and each confirmation says what *that step* will do. They are
separate because their consequences are separate: downloading costs bandwidth and disk, installing
costs the daemon.

Only an admin can download or install.

## Updating a container

A container is **not** updated from inside it, and the page will tell you so rather than offering a
button. The reason is not a limitation, it is what a container is. The daemon could replace its own
binary in the writable layer, restart, and work; and the next time the container is recreated, the
next deploy, the next `compose up`, the next node drain, the image would put the old version straight
back. A version that silently reverts is worse than one that never changed.

![The Update page on a container: the newest version "cannot be installed from here", with the compose, docker and kubectl commands that do work under Details](/media/dashboard-update-container.png)

Note what the page does *not* do: there is no disabled button and no shrug. The refusal says which
of the reasons applies to this install, and hands back commands that work, much like the ones below
(it names the exact version tag rather than `latest`).

So the image is replaced from outside:

```bash
# in the directory with your compose file
docker compose pull && docker compose up -d
```

That is the whole of it for most people: the compose file already names the image, so there is no
tag to get wrong.

By hand, pull the image again and recreate the container from it, with the same flags you started it
with:

```bash
docker pull @@DOCKER_IMAGE@@
docker rm -f nouride
docker run -d --name nouride ... @@DOCKER_IMAGE@@
```



`docker pull` asks the registry for the digest behind `latest` every time, so it downloads exactly
when there is something new, and only the layers that changed: the runtime and the system packages
underneath stay as they are. The volume keeps everything; recreating the container loses nothing.

A container that ran `@@DOCKER_IMAGE@@-router` is moving to `@@DOCKER_IMAGE@@`: the Router edition is part of
Community since 0.8.28, and the old name receives each release until 0.9. Its first start on Community keeps
Nougate on. [Coming from nouride-router →](/en/docs/deployment/docker/#coming-from-nouride-router)

On Kubernetes, with `imagePullPolicy: Always` on the container, a restart pulls the new `latest`:

```bash
kubectl rollout restart deploy/<name>
```

## From an older version

From 0.7.x: see [Upgrading to v0.8](/en/docs/deployment/upgrading-to-0-8/), which takes it step by step.

This version starts only on data 0.8.0 has run on. On a 0.7 from 0.7.11 on, `nouride update` and the
Update page offer the releases on the way first and say why (the newest 0.7.x when it is older than
0.7.28, then 0.8.0), and this version once 0.8.0 has started. Anything else (0.6, 0.5, an earlier 0.7, a
container) installs them by hand, starting each once: 0.7.29 unless it is on 0.7.28 or 0.7.29 already
(`--version v0.7.29` to the installer; with Docker, run the image's `0.7` tag once on the same volume),
then 0.8.0 (`--version v0.8.0`; the `0.8.0` tag, not `0.8`, which is this version now). Then it updates to
this one.

The start of the last 0.7.x brings the database, the memory vault, `config.toml` and every agent's pack
to 0.7's last form on disk, after a snapshot, and the start of 0.8.0 brings the database and the packs to
today's. From 0.6 or 0.5 the first of those means, in a few seconds:

1. **It snapshots the database** as `data/backups/db/nouride-<time>-before-048.db`, kept outside the
   daily rotation, then updates the schema and rebuilds the memory index from your vault.
2. **It moves day pages into month folders**, after backing your vault up.

Started on data 0.8.0 has not run on, this version refuses before it writes anything and says how
across: `install 0.8.0 first`, and the last 0.7.x before it when the data is older than 0.7.28 or the
vault still has its day pages in one folder.
An old form that comes back later, in a pack copied from elsewhere or a hand edit, is refused where it
is read, naming what to write instead: in `config.toml` the daemon does not start, in a pack that agent
does not load, and on the command line the command exits 2. `nouride config check` names those in
`config.toml` and each agent that would not load.

| Old form | Write instead | Refused in |
|---|---|---|
| `[security] sender_allowlist` | `[security.access] allowlist` | `config.toml` |
| `[session_memory]` | `[rollover]` | `config.toml` |
| `[daemon] default_agent` | `[daemon] orchestrator` | `config.toml` |
| `[[people]] id` | `ids = ["platform:account", …]` | `config.toml` |
| A `[[people]]` account with its connection (`telegram:nouva:814`), `local:…`, `web:dev` | `telegram:814`, `web:…`, `web:terminal` | `config.toml` |
| `[rsi]` | `[skills.learning]`, `mode = "ask"` or `"auto"` | `config.toml` |
| `approvals = "normal"`, `"risky"`, `"none"` | `"careful"`, `"balanced"`, `"trusted"` | `config.toml`, a pack |
| Telegram `mode = "webhook"` | no `mode`: Telegram polls | `config.toml` |
| `bridge_transport = "stdio"`, `bridge_command` | neither: the bridge runs in the daemon | `config.toml` |
| `exec_secrets = ["NAME"]` | `[security.exec_secrets] NAME = ["the command that needs it"]` | a pack |
| `memory_recent`, `task_plan` in a tool list | `memory_search`, `plan` | a pack |
| `[[mcp_servers]]` | the library: `nouride mcp add` | a pack |
| `[llm] fallback_model = "x"` | `fallbacks = [{ provider = "…", model = "x" }]` | a pack |
| `--isolated` | `--session isolated` | the CLI |
| `--token-stdin`, `--key-stdin`, `--value-stdin` | `--stdin` | the CLI |
| `approvals approve`, `people forget` | `approvals allow-once`, `people remove` | the CLI |
| `POST /approvals/<id>/approve` | `POST /approvals/<id>/allow-once` | the control API |

Three are read differently instead of refused: a `Role:` line in a pack's `IDENTITY.md` is not its
headline (`Headline:` is), a `USER.md` in a pack is not read, and `/auto` in a chat is a message to the
agent like any other (`/approvals` is the command).

A few keys are warned about and ignored, since each held what nearly every install had: `[health]`,
`[cron] tick_interval_ms`, `[queue] dedup_window_ms` and a gateway's `[resilience]` table are
[fixed values](/en/docs/reference/config/#fixed-since-080) now. A copy of the old `config.example.toml`
has the first three: delete the lines `nouride config check` names. A key a pack's `config.toml` does not
read is named the same way, and the agent loads.

**Once, optionally:** a binary install updated with `nouride update` keeps its old unit, which kills a
running command at the start of a restart instead of letting it finish its step, and keeps `nouride`
on `PATH` as a link that root runs directly. Re-run the installer once to fix both; `nouride doctor`
reminds you until then. With Docker, add `stop_grace_period: 45s` to your compose file.

**Going back to 0.6.7** takes 0.7.29: its `db restore` of the `…-before-048.db` snapshot also moves the
day pages back where 0.6.7 expects them. This version refuses to restore a snapshot from before 0.8.0.

**The capture folder 0.5 and 0.6 wrote** (`.nouride/memories/` by default) is not read, and this
version has no import for it. To keep what in it is older than the turn log, import it with 0.7.29's
`memory backfill` before you update; otherwise delete the folder.

## System packages

Letting agents install [system packages](/en/docs/deployment/system-packages/) is a choice made with
the installer, as root (`--allow-packages`), because an update runs as the daemon's own user and cannot
set up a root service. Once on, it stays on through every update.

In Docker it is on in Nouride's image (0.8.15), and an update keeps what agents installed: the list and the downloaded
packages are on the volume, in `.nouride/system-packages`, and installed again before the new container's daemon
starts.

## A release is only an update if it was built for you

This is the part worth reading twice, because the alternative is an install being offered something
it can never have.

Editions are built and published separately. The public channel receives the **Community** edition's
tarballs and nothing else (until 0.9, a second time under the Router edition's old names, so a Router install
updates onto Community by itself), so a release can exist without existing for your
build. What the daemon resolves is therefore not "the newest tag" but **the newest release that
actually carries a build for this edition, and whose checksum file covers it**.

So a release built only for another edition is not an update for a Community install. It is reported,
with the reason. The tag below is a stand-in, not a real release:

> `<latest>` exists and is not an update here: it carries no build for the basic edition on
> linux/x64.

Both halves are deliberate. Not offering it is what stops a failed download; saying it exists is what
stops the check looking broken.

## Installs that cannot update themselves

These cannot, and each is told what does work instead:

| This install | Why not | What to run |
|---|---|---|
| A container | An image is replaced from outside. A swap made inside is lost on the next recreate | `docker compose pull && docker compose up -d` |
| An install directory the daemon cannot write | It replaces its own files, and here it cannot | the installer again, as root |
| Nothing supervising it | The swap would work and nothing would start it again, that is a stop, not an update | `nouride service install` first |
| A Pro edition with no licence | It installs only signed releases, which come from the channel a box or a licensed server gets from Nouverse, not the public one | a box: pair it; a server: install it with the link Nouverse gave you, then check again |
| A source checkout | There is no binary to replace | `git pull`, `bun install`, `bun run build:binary` |

The refusal always carries the command. A "no" you have to go and research is a "no" that costs an
afternoon.

## The agent can do it

An agent holding the `update` tool can check unprompted and ask to install:

- **`check` is not gated at all.** Reading a version number changes nothing, and an agent that has
  to interrupt you to answer "are we current?" is one nobody asks.
- **`apply` is on the fixed list** (`replace`): asked **every time** under `careful`, and never a
  standing `allow-always`. `balanced` answers it itself: what that level still asks is
  this daemon *stopped*, not replaced. If there is nobody to ask and the level does not answer it, it is
  refused rather than run.

The agent schedules its own follow-up turn before the restart, so it is the one that reports back:

> Updated to <latest>; the previous version is in `.nouride-previous`. Restarting as soon as nothing
> else is running.

…and, twenty seconds after the restart, in the same conversation:

> Back on <latest>. Telegram and WhatsApp both reconnected.

## Where the versions come from

`@@DOWNLOAD_DOMAIN@@` redirects to a public release repository, and the newest tag is read from its
releases API, no token, and nothing about your install is sent. The answer is reused for five
minutes, because that API allows sixty requests an hour without a token; **Check again** asks now.
Tarballs are fetched from the same place `install.sh` fetches them from.

A daemon behind a proxy that does not allow it out will say so (`could not reach the release
channel`) rather than reporting that everything is up to date.

## What is checked before anything moves

- **The checksum**, against the release's own checksum file (`CHECKSUMS`; `SHA256SUMS…` up to 0.7.x),
  before a single file is touched. A truncated download still untars; a binary that does not run is
  only discovered after the old one is gone.
- **A signature.** The checksum file must be signed with a key compiled into the binary: always on Pro, and on
  the public channel for every release from 0.7.4, the first one signed.
- **That the tarball has a `nouride` executable in it.**
- **That the artifact exists at all.** An edition whose tarballs are not published is told so during
  the *check*, not at the moment it tries to take one.

The swap is renames, not copies, atomic, and allowed over a running executable, which a copy is
not. If one fails, the ones before it are put back.
