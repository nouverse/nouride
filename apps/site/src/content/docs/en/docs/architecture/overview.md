---
title: Overview & design
description: How one process runs many agents, where the boundaries are, and why they are there.
---

Nouride is one long-lived process. Everything below happens inside it: agents, gateways, the tool
loop, the scheduler, the HTTP server and the dashboard it serves. Beside it runs only what agents start: their
commands, their stdio MCP servers, and an [external agent](/en/docs/manual/external-agents/)'s coding CLI: one
process per agent, started at its first turn and stopped after five quiet minutes.

## The path a message takes

```
  Discord WS        Telegram poll       WhatsApp (in-process)      dashboard / CLI
      │                  │                       │                       │
      └───────────────── gateway adapters ───────┴───────────────────────┘
                         │  a normalised envelope
                         ▼
                   room log      ── a group's messages are kept, addressed or not
                         │
                         ▼
                   access gate   ── is this sender allowed to reach an agent at all?
                         │
                         ▼
                   inbox         ── written down before anything acts on it
                         │
                         ▼
                   queue         ── one turn at a time in a DM, several in a group
                         │
                         ▼
                   router        ── mention? gateway owner? channel binding? orchestrator?
                         │
                         ▼
                   hooks         ── is it a slash command? answer it and stop
                         │  no
                         ▼
              agent registry     ── the persona pack, its tools and skills for this turn
                         │
                         ▼
        prompt → context → executor ──────────┐
                         ▲                     │ the model asked for a tool
                         │                     ▼
                         │        tool registry → approval gate → run it
                         └──────── tool results ┘
                         │  final text           (every step journaled)
                         ▼
                   gateway.send()
```

**The access gate runs before anything is queued.** A stranger's message does not start a turn,
does not cost a model call, and gets no reply. In a group it is still kept with the room's other
messages: when an agent is tagged there, the last `[agents] group_context_messages` (20) messages are
replayed to it as context, a stranger's included. Overhearing is not obeying.

**The queue is keyed by chat, not by agent.** In a one-to-one chat one turn runs at a time, so each
answer is context for the next. In a group each agent has its own conversation, so several turns run
at once, but never two for the same agent: a message to an agent still working there is refused with a
note rather than queued behind it. Across chats, turns run in parallel up to
`[queue] max_concurrent_turns` (8). That is why memory scales with concurrent *turns* rather than with
agents. Slash commands skip the line, so `/stop` and `/approve` answer while a turn is running.

Four things happen outside that path:

- **The scheduler** runs a due job. A job that runs in a chat's own conversation goes through the
  queue like a message. Any other job's result is delivered by the scheduler itself, to a chat, a
  webhook, or nowhere, because the run record needs the text either way.
- **A background job** wakes the agent that started it when it finishes, and while it has been quiet
  for a while, through the same queue.
- **Agents reach each other** by mention in a shared chat, routed like any message within a hop
  budget (`[agents] mention_max_hops`, 5), or through `ask_agent` in a one-to-one chat, which runs the
  other agent behind the conversation and hands its answer back, or, when that takes more than a
  minute, lets it work on as a background job whose answer wakes the agent that asked.
- **The approval gate** parks a tool call until a human answers, in chat or on the dashboard. The
  question is a row in SQLite, and a restart expires it rather than leaving the call to guess.

## A restart loses nothing

Every step of a turn is written to SQLite as it happens: the question, each model reply with the
tool calls it asks for, each result. The start of a tool call is written just before it runs.

- **On a shutdown** (`systemctl stop`, an update) running turns stop at their next step, close with
  what they did, and say so in their chat before the daemon goes.
- **After a crash** or a power cut, the next boot closes each turn that was left open: every call
  that finished keeps its result, the one that was running is marked as cut off (it may have partly
  run), and the agent tells the chat.
- **A cut-off turn carries on** by itself, once, if the daemon is back within 15 minutes: the agent
  checks what a cut-off step did before repeating it. Back after longer than that, nothing runs by
  itself, and "continue" picks up from there.
- **Messages are written down on arrival.** One sent while the daemon was down is answered once it is
  back, if it was sent in the last 15 minutes; an older one gets a note instead of a late answer. A
  message a platform delivers twice is answered once.
- **A reply written just before a crash** is sent after the restart.

A restart or an update waits until nothing is running: a turn or an approval for ten minutes at
most, a background job until it finishes. [Updating →](/en/docs/deployment/updating/)

## What else is in the process

- **The dashboard and the CLI** talk to the daemon through the same HTTP control API, so anything the
  dashboard does can be scripted. A few commands, such as `nouride db`, `doctor` and `service`,
  work with the daemon down.
- **Providers** are endpoints speaking one of two wire formats, Anthropic's or OpenAI's. Anything that
  speaks one of them works: a vendor's API, a local model server, a gateway.
- **Secrets by reference.** `api_key = "nougate"` means "the secret called nougate", resolved at use
  from the environment or the secret store. That is why a `config.toml` is safe to commit, print, and
  render in the dashboard.

Two parts that look like they want their own process run inside this one by default:

| | |
|---|---|
| **The WhatsApp bridge** | Hosted in the daemon. It still speaks newline-delimited JSON, only the pipe is memory. One WhatsApp number per daemon |
| **The LLM gateway (nougate)** | Optional. Reached over HTTP, or hosted in the daemon by the Router edition (`[nougate] in_process`, port 18256) |

A second process cannot share the Bun runtime, so it pays about 36 MB again. Hosting them here is
what saves it.

[Editions and downloads →](/en/docs/deployment/binaries/)

## Why one daemon at all

The alternative, a container per agent, or a microservice per capability, buys isolation nobody
asked for and pays for it in memory, in operational surface and in the thing that actually matters
here: an agent is a directory of Markdown, not a program. Assembling a prompt does not need a
process.

The numbers back it up. Six agents cost 2.1 MB more than one. The heap is flat in the number of
agents because the prompt is assembled per turn and not held resident.

An external agent is the exception: its CLI is a program of its own, and idle with a session open it held about
330 MB for Claude Code and 190 MB for Codex. So one is offered only where the agents' commands have 512 MiB.

[Footprint and measurements →](/en/docs/architecture/performance/)

## Where the boundaries actually are

Worth being clear about, because the approval gate is easy to mistake for one.

| | |
|---|---|
| **The service account** | The daemon does not run as root: `nouride service install` refuses to generate a unit that does, unless you pass `--privileged`, which also drops the hardening below |
| **The launcher** | On a binary install, root typing `nouride` runs it as the service account, through a root-owned launcher, so root never runs a file the agents' account could have changed |
| **The unit hardening** | `ProtectSystem=strict`, `ProtectHome=read-only`, a private `/tmp`, `NoNewPrivileges`, `RestrictSUIDSGID` |
| **Each agent its own user** | On a Linux service with the helper, an agent's commands, its coding CLI and its stdio MCP servers run as its own user and reach its own folders, not another agent's or the daemon's ([below](#each-agent-its-own-user)) |
| **Workspace roots** | An agent's file tools write only to its own pack and the workspace, unless you list more. An agent with a shell may also read its `HOME` and the installed programs. `exec` starts in the workspace, but a command reaches whatever its user can: the agent's own where it has one, the service account's otherwise |
| **The access gate** | Who may reach an agent at all |
| **The command classifier** | Which commands ask before running, and which writes into the daemon's own install are refused. **Not** a security boundary: a determined model routes around any classifier |

The classifier exists so that ordinary work does not surprise you. The rest are what hold.

## Each agent its own user

On a Linux service installed with `install.sh`, each agent's commands run as a user of its own, `nr-<agent>`, through
`nouride-run`, a small root helper the installer puts in `/usr/local/lib/nouride-run/`. The daemon runs with
`NoNewPrivileges` and cannot change user; the helper does that one thing, by fixed rules, and only for the users it
made. Every agent's user is in the group `nr-agents`; one whose pack grants the credentials directory
(`[security] credentials`, on unless it says `false`) is in `nr-creds` too.

What runs as the agent:

- its commands: `exec`, background jobs, `session`, scheduled commands;
- an [external agent](/en/docs/manual/external-agents/)'s coding CLI, and its sign-ins;
- the stdio MCP servers it uses, with its HOME and installs, starting in its folder unless the server names a `cwd`.

What stays the daemon's: the `nouride` tool, which runs this install's own CLI, and `nouride tools run`.

An agent's HOME is its own folder, `workspace/private/<id>/`, seeded once from the shared `home/` with its logins and
settings, not its caches. What it installs itself lands in its own `~/.local`, first on its `PATH`. The programs every
agent runs, in `.nouride/bin`, `lib` and `opt`, are every agent's to run and change only through `nouride tools run`,
which the orchestrator reaches and a person approves. An agent's commands reach `workspace/shared/`, its own folder,
its declared roots, its pack, and its own job logs, attachments and long tool output, nothing of another agent's, and
nothing in `data/`. `[security.exec] landlock` adds Landlock where the kernel has it.

On Docker, on macOS, or on Linux without the helper (no systemd, or no `useradd`, as on Alpine without `shadow`),
everything runs as the daemon's user, as before: one agent's command can read another's folder and the daemon's own
files, and `home/` is every agent's HOME. Boot and `nouride doctor` say which it is, and why. There an external
agent's *Free in its folder* asks as *Ask when risky* does, and a shell or file MCP server reads what the daemon reads.
