---
title: What is Nouride?
description: One small daemon that runs several AI agents and connects them to the chat apps you already use.
---

Nouride is a program you run on your own machine. It hosts several **AI agents**: each with its own
name, personality and memory, and connects them to Telegram, Discord and WhatsApp so you can talk to
them the way you talk to anyone else.

It is one binary. It carries its own runtime, so there is nothing to install alongside it: no Node,
no Bun, no Python, no package manager. You download it, run one command, and finish the setup in a
browser.

## What it is not

**It is not a model.** Nouride does not run an LLM on your machine and does not want a GPU. It calls
an endpoint you point it at, Anthropic, OpenAI, OpenRouter, a company gateway, or an Ollama on your
LAN. Your RAM is unaffected by which model you choose.

**It is not a chatbot builder.** There are no flows, no node graphs and no visual editor. An agent is
a directory of Markdown files, and the whole of its behaviour is what those files say plus the tools
you allow it.

**It is not a cloud service.** Nothing phones home. The conversations, the memory and the credentials
are files in one directory on your machine.

## Who it is for

- Someone who wants a personal assistant reachable from their phone, on hardware they own.
- A small team that wants one bot per role, one for deploys, one for research, one for support, without running one container per bot.
- **Single-board computers and homelabs**: Built for Raspberry Pi or any Linux SBCs. A Raspberry Pi 4 with 2 GB of RAM comfortably runs a full fleet of agents 24/7.

## Built for Raspberry Pi or any Linux SBCs

Most modern AI agent frameworks require heavy Python runtimes, bloated containers, or 2–4 GB of RAM just to start.

Nouride was engineered from day one with the opposite philosophy, **lightweight, single-binary execution**:

- **Native ARM64 binaries**: Shipped as standalone single binaries for `linux-arm64` (Raspberry Pi OS 64-bit, Ubuntu ARM, Armbian, DietPi) and `linux-x64`, plus `darwin-arm64` for a Mac with Apple Silicon.
- **Tiny 64 MB memory floor**: The entire daemon runs in 64 MB of RAM, its first start included (measured 2026-10-17), and idles at < 1% CPU. Any low-power single-board computer stays cool, responsive, and quiet.
- **MicroSD & flash-friendly**: State is stored in local SQLite using Write-Ahead Logging (WAL) and bounded retention sweeps, preventing excessive write cycles and prolonging your SD card's life.
- **No container overhead required**: Runs directly on bare metal as a lightweight `systemd` service.
- **No GPU needed**: Inference is offloaded to remote model APIs or a local Ollama instance on your LAN.

See the [Homelab & Mini PCs deployment guide](/en/docs/deployment/homelab/) for verified board lists and performance numbers.

## The shape of it

```
   Telegram ─┐
    Discord ─┤                ┌──────────────────────────────────────────┐
   WhatsApp ─┼──── gateways ──┤  one daemon, one SQLite file, one port   │──► your model endpoint
   terminal ─┤                │                                          │
  dashboard ─┘                │  agents · tools · approvals · scheduler  │
                              └──────────────────────────────────────────┘
                                              │
                                     .nouride/  ← config, database, agents, workspace
```

Everything above happens in **one process**. Agents are not containers and not subprocesses, an
agent is a directory of Markdown that gets assembled into a prompt when a message arrives for it. Even
the WhatsApp bridge runs inside the same process by default; nothing runs beside the daemon but what the agents
start: their commands, and an external agent's coding CLI, one process per agent, started at its first turn and
stopped after five quiet minutes.

Every message and every step of a turn is written down as it happens, so a restart, an update or a
power cut loses neither: a message sent in the meantime is answered once it is back, and a turn it
cut off keeps what it did and says so. [How →](/en/docs/gateways/overview/#when-the-daemon-restarts)

## What an agent can do

Out of the box an agent can read and write files, search and fetch the web, run commands, remember
things, schedule work, and hand a job to another agent. Every one of those is a named tool you switch
on per agent, and the dangerous ones ask you before they run.

| | |
|---|---|
| **Read and write** | `read`, `write`, `edit`, `multi_edit`, `glob`, `grep`: inside directories you allow |
| **Run things** | `exec` for one-shot commands, `session` for something interactive, background jobs for anything long. Programs an agent installs go into its own bin directory, with no root |
| **Code** | Hands a feature, a refactor or a failing test suite to a coding agent CLI (Claude Code, Codex, OpenCode and others) through the built-in `coding-agents` skill, then checks its work, or is one: an [external agent](/en/docs/manual/external-agents/) is a coding CLI with a channel, missions and approvals of its own |
| **The web** | `web_search`, `web_fetch` |
| **Remember** | `memory_search`, `memory_read`, `memory_analyze`, `memory_write`: with memory on, every conversation filed nightly into a summary and facts about the people in it, plus a `MEMORY.md` the agent keeps itself |
| **Work with others** | `delegate` to a subagent, `ask_agent` to another persona, `plan` for multi-step work |
| **Learn** | `skill_create` for a new skill; `skill_improve` and `skill_install` leave a draft you approve |
| **Anything else** | Model Context Protocol servers, declared per agent |

## What it costs to run

Measured, not estimated, the provenance for every figure is on the
[footprint page](/en/docs/architecture/performance/).

| | |
|---|---|
| **Floor** | 64 MB of RAM, a first start and every start after it, measured 2026-10-17, linux-arm64, from a cold page cache. Slow to start at that limit: tens of seconds. |
| **Comfortable** | 512 MB. 1 GB if the agent does real work through `exec`. |
| **External agents** | A coding CLI per agent, on top: idle with a session open, about 330 MB for Claude Code and 190 MB for Codex. Offered only where the agents' commands have 512 MiB, so a 512 MB box gets none. |
| **Disk** | ~95 MB installed, plus whatever the agents produce. |
| **CPU** | Any. 0.18% of one core at idle (measured 2026-11-08 on an x64 box with fifteen connections): it waits on the network almost all the time. |
| **Needs no** | Postgres, Redis, vector database, GPU, or local model. |

The daemon depends directly on **four** third-party packages: Hono for HTTP, and discord.js, grammY
and Baileys for the Discord, Telegram and WhatsApp gateways. Everything else is Bun's own standard library: the
database, the HTTP server, the process spawning, the password hashing.

## Next

- [Install it](/en/docs/start/install/): Linux, Raspberry Pi, macOS or Docker.
- [First run](/en/docs/start/first-run/): the one-time password, the dashboard, three short steps.
- [Architecture](/en/docs/architecture/overview/): if you want to know how before you know whether.
