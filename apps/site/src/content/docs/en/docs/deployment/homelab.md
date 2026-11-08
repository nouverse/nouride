---
title: Homelab & mini PCs
description: Raspberry Pi, Orange Pi, mini PCs, NAS boxes and LXC containers, what works and what to watch.
---

This is the deployment target Nouride was designed around. A Pi 4 with 2 GB of RAM comfortably runs a
handful of agents.

## What works

| Target | Verdict |
|---|---|
| **Raspberry Pi 4 / 5** (1 GB+) | Comfortable. `linux-arm64`. A Pi 5 is more than this needs |
| **Orange Pi 5 / 5 Plus** | Same. Armbian arm64 |
| **Mini PC / NUC / old laptop** | Overkill, and the right choice anyway if the agent does infrastructure work |
| **Any 512 MB VPS** | Fine, including the dashboard. The cheapest tier at most providers. No external agents: one needs 512 MiB for the agents' commands |
| **NAS with Docker** (Synology, QNAP, Unraid) | Fine. Check `uname -m`: several are arm64 |
| **Proxmox LXC** | Fine, with two caveats about memory below |
| **Alpine anything** | Needs the `-musl` build **and** `apk add libstdc++` |

## The one thing to check first

**Your OS must be 64-bit.**

```bash
uname -m     # aarch64 → good.  armv7l → 32-bit, not supported
```

There is no 32-bit ARM build, and the installer stops rather than downloading something that will not
run. If you see `armv7l`, reinstall with Raspberry Pi OS (64-bit), Ubuntu Server arm64, or Armbian
arm64. A Pi 3 or newer and any modern Orange Pi can all run 64-bit, the 32-bit image is just still a
common default.

## Install

Exactly the same command as any other Linux box:

```bash
@@INSTALL_CMD@@
```

systemd supervises it, it comes back after a reboot, and `nouride update --start` upgrades it in
place, as does re-running the script. From 0.7.x: see [Upgrading to v0.8](/en/docs/deployment/upgrading-to-0-8/).

## What it will actually use

| | |
|---|---|
| Idle, 1 agent | ~65–75 MB resident |
| Boot peak | roughly double the resting figure |
| Each extra agent | ~0.4 MB |
| CPU at idle | 0.18% of one core (measured 2026-11-08, x64, fifteen connections) |
| Disk | ~120 MB installed |

Do not deploy at the floor, 64 MB of RAM (measured 2026-10-17 on linux-arm64, a first start included): it is the
number that proves the daemon is small, not a recommendation. At the floor a start takes tens of seconds and there is nothing left for a turn.

[Every measurement, with its provenance →](/en/docs/architecture/performance/)

## `MemoryHigh` is silently inert on Raspberry Pi OS

The generated systemd unit carries a soft memory ceiling at 80% of what the machine reports.
Raspberry Pi OS ships with the memory cgroup controller **disabled**, so systemd accepts the setting
and enforces nothing:

```bash
systemctl show nouride -p MemoryCurrent --value   # `[not set]` means it is inert
cat /sys/fs/cgroup/cgroup.controllers             # no `memory` in the list
```

Fix it by adding `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt` and
rebooting.

## Inside an LXC

Two things to know.

**Percentages resolve against the host.** This is why the unit writes `MemoryHigh` as an absolute
number computed at install time: on a 2 GB container of a 62 GB node, `80%` came out as 49.8 GB.

**`/tmp` is RAM, sized from the host.** Inside an LXC, systemd sized a private `/tmp` from the host's
memory: a 2 GB container advertised 32 GB free there, and a 1.2 GB clone into it throttled the daemon
until it stopped answering. The unit gives `/tmp` an eighth of the machine instead, between 64 MB and
1 GB, so the same write fails with "no space left", an error the agent can see and work around.

## The daemon is often not the biggest thing in its own cgroup

Worth knowing before you size a small device. Measured on a live install:

| | |
|---|---|
| the daemon (with in-process WhatsApp bridge) | 73.3 MB |
| one Node-based MCP server | 91.5 MB |

Hosting the bridge in-process saves ~40 MB by eliminating the second process runtime. On a 256 MB device the daemon and WhatsApp fit comfortably; adding heavy Node MCP servers is what takes up additional memory.

An [external agent](/en/docs/manual/external-agents/)'s coding CLI is bigger still: one process per agent, started at
its first turn and stopped after five quiet minutes, measured idle with a session open at 324 MB for Claude Code and
187 MB for Codex. They need 512 MiB for the agents' commands, so a 512 MB device gets none.

[Build variants →](/en/docs/deployment/binaries/)

## Keeping the work off the SD card

An agent's output grows without bound, and an SD card is the part of a Pi that fails.

```toml
[daemon]
workspace_dir = "/mnt/ssd/nouride-workspace"
```

The three paths are separate config keys for exactly this. Nothing else has to move.

What agents install for themselves (`.nouride/bin`, `lib` and `opt`) and the caches in
`.nouride/home` grow too. `nouride doctor` shows how much each one takes.

## What to expect from the model, not the machine

None of the above depends on which model an agent uses. Providers are remote endpoints, so RAM is
unaffected, a Pi calling Claude and a 64-core server calling Claude use the same amount of memory
and wait the same amount of time.

What a small box *does* affect is `exec`: a build the agent kicks off runs on this machine. That is
what the 512 MB recommendation is really for.
