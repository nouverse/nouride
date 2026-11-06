---
title: System packages
description: "Letting agents install, remove and upgrade system packages on a sandboxed install: off on a host unless you ask for it, on in Nouride's Docker image, through a small root service with fixed rules, asking you every time."
---

The daemon runs sandboxed: an unprivileged user, `NoNewPrivileges`, a read-only `/usr`. Nothing it
starts can become root, `sudo` included. That is right for a daemon that runs commands a language
model chose, and it means an agent cannot install a system package like `pdftotext` on its own.

Most of the time it does not need to. Agents install programs into their own bin directory
(`.nouride/bin`), with no root and no flags: `npm i -g`, `bun add -g`, `pipx install`,
`uv tool install`, `go install` and `cargo install` all land there, and so does a release binary put
in place with `install -m 755`. `pip install` goes into a Python environment the agents share
(`.nouride/opt/python`), which sees the system's own Python packages too. All of it is on `PATH` for
every command and survives restarts and updates, and `nouride doctor` lists what is there.

The daemon builds that Python environment when it starts. On Debian and Ubuntu it needs the
`python3-venv` package; without it, `pip install` meets the system's `externally-managed-environment`
refusal, and `nouride doctor` says why.

For what has no such build, you can let agents install system packages too. **It is off unless you
turn it on.**

## Turning it on

```bash
curl -fsSL @@INSTALL_URL@@ | sudo sh -s -- --allow-packages
```

For the Router edition, add `--variant router` to the same command. If the install is not in
`@@INSTALL_DIR@@`, add `--dir` with its path, or the installer makes a second install there. On an
existing install this is safe to run: agents, memory and settings stay. A later run of the installer
without the flag keeps it on, so updating never turns it off; `--no-packages` does.

Off, nothing asks you about it. An agent knows the limit: it installs into its own bin directory, and
only when a task really needs a system package does it say so and give you the command above.

## What it can do

It sets up `nouride-pkg`, a small root service that installs, removes and upgrades packages from your
system's own repositories, and nothing else:

- **Your repositories only, by exact name.** No files, no URLs, no new repositories, no options. A
  request is an operation and package names.
- **Nothing that keeps the box reachable is ever removed**: ssh, networking, `sudo`, the init
  system, libc, the package manager. A removal that would take one of them with it, as a dependency,
  is refused as a whole.
- **Every change is simulated first.** What it would install and remove is shown before anything
  happens.
- **You approve each change.** For an agent, `install`, `remove` and `upgrade` always ask, can never
  be approved "always", and are not covered by auto-approval or scheduled turns. The one exception
  is an agent whose approval level is `trusted`: nothing asks for it, this included, so it says what it
  installs instead.

The rules live in the service, root-owned, and hold however a request arrives: an agent runs as the
same user as the daemon, so anything that trusted the daemon to have asked first would trust an agent
that went around it. The worst case is a package from your own repositories installed or removed,
never a protected one.

## Using it

```bash
nouride pkg                               # on or off, and which package manager
nouride pkg check install poppler-utils   # what it would change, changing nothing
nouride pkg install poppler-utils
nouride pkg remove poppler-utils
nouride pkg upgrade                       # everything with an update; or name packages
nouride pkg refresh                       # refresh the package lists
```

Agents use the same commands through the `nouride` tool. An agent's `install`, `remove`, `upgrade` or
`refresh` runs as a background job, because a large upgrade takes longer than the four minutes a
command in the foreground gets; the agent is told when it is done. The service writes the package
manager's output to a file and sends it once the change is over, so a job that is stopped, or a daemon
that restarts mid-change, never leaves `dpkg` half-way. Each change is logged: `journalctl -t
nouride-pkg`.

Supported: `apt` (Debian, Ubuntu, Raspberry Pi OS) and `apk` (Alpine). On a host it needs systemd; Nouride's
Docker image serves it itself (below).

It does not apply:

- **macOS**: Homebrew needs no root.
- **A daemon that runs as root** (a Nouride Box, or `nouride service install --privileged --user
  root`) runs the package manager itself, under the exec policy like any other command.

## In Docker

Nouride's image has it on (0.8.15). Root in a container is the container's, not the host's, and
recreating the container puts the image back, so there is nothing to install: the entrypoint, root
before it hands the container to the daemon's user, serves `nouride-pkg` with the same rules, and
`apk` (Alpine) is the package manager. What the image itself ships is protected too: removing it would
break the container until it is recreated.

What agents installed stays. The list and the downloaded packages are kept on the volume, in
`.nouride/system-packages`, and installed again when the container is recreated (every update does
that), from what was downloaded, with or without a network, before the daemon starts.

```bash
docker exec nouride nouride pkg install ffmpeg   # or ask an agent: you approve it, unless it is trusted
```

To turn it off, start the container with `NOURIDE_SYSTEM_PACKAGES=off` in its environment; a container
started as another user than root (`--user`) has it off too. Each change is in the container's log:
`docker logs nouride 2>&1 | grep nouride-pkg`.

## By hand

For an install made without the installer, as root, from the release tarball:

```bash
install -d -m 755 /usr/local/lib/nouride-pkg/backends
install -m 755 pkg/nouride-pkg /usr/local/lib/nouride-pkg/
install -m 644 pkg/backends/*.sh /usr/local/lib/nouride-pkg/backends/
sed 's/@GROUP@/nouride/' pkg/systemd/nouride-pkg.socket > /etc/systemd/system/nouride-pkg.socket
install -m 644 'pkg/systemd/nouride-pkg@.service' /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now nouride-pkg.socket
systemctl restart nouride
```

Keep these root-owned and outside the install directory: a copy the service user could edit would be
a way to root.

## Another distribution

Each package manager is one file under `pkg/backends/`, answering the same seven questions: is this
the host's manager, what is protected, does the repository have this exact name, what would a change
do. The rules stay in `nouride-pkg`. In the repository it is `packages/system-packages`: `root/` is
everything that runs as root, and `root/backends/README.md` says how to add one.
