---
title: Footprint & performance
description: What Nouride actually costs to run, measured, with the provenance for every figure.
---

Every number on this page was **measured**, not estimated. Anything reasoned rather than measured is
labelled as such.

:::note[Provenance]
The idle, floor and agent figures were measured again on 2026-10-17, on the 0.7.11 branch: a
`linux-arm64` binary running inside `debian:12-slim` on an Apple M1 host, and the live daemon on one
`linux-x64` box, read without changing anything. The edition figures were measured on one `linux-x64`
box, the `--smol` before/after figures on two live boxes, and the database figures on one live install
during its upgrade to 0.7.0. Those are older and have not been taken again.

Sizes move with the runtime. Re-measure before trusting these against a much newer build; the
*differences* between rows are the durable part.
:::

## The short answer

| | |
|---|---|
| **Floor** | 64 MB of RAM, a first start included, measured 2026-10-17, `linux-arm64`, from a cold page cache. A start there takes tens of seconds |
| **Comfortable** | 512 MB. 1 GB if the agent does real work through `exec`. Reasoning, not a measurement |
| **External agents** | One coding CLI per agent on top, idle 324 MB for Claude Code and 187 MB for Codex ([below](#external-agents)); none below 512 MiB for the agents' commands |
| **Disk** | 95 MB installed, a 40 MB download. A fresh `data/` is 364 KB (2026-08-14), and it grows with what is remembered |
| **CPU** | Any. 0.17% of one core at idle on an x64 box with nine gateways connected, and 0.18% with fifteen (measured again 2026-11-08, over two minutes); it waits on the network almost all the time |
| **Needs no** | Postgres, Redis, vector database, GPU, or local model |

There is no minimum-viable-model requirement, because Nouride does not host one. Providers are remote
endpoints, so RAM is unaffected by which model an agent uses.

## Idle

The daemon at rest, gateways connected, no turn in flight. Resident memory is the binary's pages,
which the kernel drops and reads back under pressure, and anonymous memory, which it cannot: size
against the second.

| Shape | Resident idle | of it, anonymous | Peak during boot | Artifact |
|---|---|---|---|---|
| Compiled binary, `linux-arm64`, 1 agent (2026-10-17) | 59.0–67.5 MB | **27.3–27.5 MB** | 145.6 MB | 94 MB installed |
| Live daemon, `linux-x64`, 6 agents, 9 gateways (2026-10-17) | 117–128 MB | 87–98 MB | not measured | not measured |
| Compiled binary, macOS, 0 agents (2026-08-14) | 63.7 MB | not measured | not measured | 58 MB |
| Docker image (2026-08-14) | 69 MB process / 96 MB container | not measured | 166 MB | 85 MB image |

Sampled every 15 s for a minute after `ready`: anonymous memory flat, 16 threads settling to 5, no child
processes. The live daemon carries six Discord bots, WhatsApp's session in-process, Telegram and a
41 MB database. The same box read 65.6 MB on 2026-09-02 (the `--smol` table below); WhatsApp's bridge
has moved into the daemon since, and the memory index and the event stream arrived.

**The boot peak is roughly double the resting figure**, and it is what a memory limit has to
accommodate, not the resting number. On a first start part of it is the password hash, 19 MiB since 0.7.11. A limit
below it produces an OOM kill during startup, which reads as a crash loop with no error in the daemon's
own log: the process never gets far enough to write one.

The binary and the image land within ~10 MB of each other, so **do not choose between them on memory
grounds**. Choose on whether the agent should be able to act on the host.

## The floor

Run under a hard cgroup limit, checking whether the daemon reaches `ready`, on a first start, which
creates the dashboard's account, and on a later one. `linux-arm64`, 1 agent, the dashboard on,
2026-10-17, every start a cold one: the binary's pages were dropped from the page cache before each run,
so everything it read was charged to the container under the limit.

| Limit | First start | Later start |
|---|---|---|
| 128 MB | ready, 2–5 s | ready, 1–3 s |
| 72 MB | ready, 4–11 s | ready, 3–14 s |
| **64 MB** | **ready**, every run, 9–68 s | **ready**, every run, 16–22 s |
| 56 MB | ready 2 of 4, killed 2 | ready, 19–22 s |
| 48 MB | killed, or not ready in 90 s | ready, 60–89 s |

**64 MB, a first start included.** Until 0.7.11 a first start needed 112 MB: the new account's password
was hashed with argon2id at Bun's cost, 64 MiB at once, and every kill came at that hash. It is OWASP's
cost now, 19 MiB, and an account made before is hashed again at it the first time it signs in.

**The runtime adapts to the limit rather than demanding a fixed budget.** A later start runs its
anonymous memory in 25–28 MB under every limit from 48 to 128 MB. What a tight limit costs is time: the
binary's pages are read again and again, so at 64 MB a start takes tens of seconds where 128 MB takes a
few.

Do not deploy at the floor. It is the number that proves the daemon is small, not a recommendation:
at 64 MB there is nothing left for a turn.

## Agents are almost free

| Agent packs loaded | Anonymous, idle | Boot peak |
|---|---|---|
| 1 | 27.3–27.5 MB | 145.6 MB |
| 3 | 28.2–28.4 MB | 146.8 MB |
| 6 | 29.1–29.2 MB | 146.9 MB |

**Roughly 0.4 MB per idle agent** (`linux-arm64`, 2026-10-17). An agent is a directory of Markdown, not a process: the prompt is
assembled per turn and not held resident, and every agent shares one process, one database and one
HTTP server. An external agent is the exception: its coding CLI is a process of its own ([below](#external-agents)).

This is the number to size against when adding agents. It is the **wrong** number for sizing
concurrent work.

## A turn under load

Not measured, it needs a live provider key and a real conversation. What bounds it is configuration,
so the ceiling is at least knowable:

| Setting | Default | Why it drives memory |
|---|---|---|
| `max_concurrent_turns` | 8 | Turns running at once, across every chat. The rest wait |
| `tool_max_output_bytes` | 100 MB | One tool call's output. A large one is streamed to disk and only its two ends are held |
| `max_tool_iterations` | 250 | Tool calls in a single turn |
| `max_conversation_turns` | 200 | Stored history per conversation |
| `max_context_ratio` | 0.8 | Share of the model's context window that gets filled |
| `max_tokens_per_turn` | 32000 | Response size |

**Memory scales with concurrent turns, not with agents.** The queue runs chats in parallel, up to
eight turns at once by default, so eight busy chats are eight contexts assembled at once. One agent in
ten busy channels costs more than ten agents in one quiet one.

*Reasoning, not measurement:* a single turn reading a large file or running an `exec` that prints
megabytes is the realistic worst case. That is why the recommendation is 512 MB rather than 128 MB.

## The database

One SQLite file, opened with a 16 MB page cache where SQLite's default is 2 MB. The cache fills only
as pages are read, so a small database never costs all of it. Temporary sorts are kept in memory,
because a hardened unit has almost nowhere on disk to write them.

How big the file gets depends on how much is remembered. On one live install with 895 remembered
conversations it was **31 MB** after the 0.7.0 upgrade, of which the keyword index was 4.7 MB. Before
it, the same data took 76 MB: two thirds of the file was a word index kept in ordinary tables, which
SQLite's own full-text engine replaced. Every weekly snapshot is a copy of that file, so
`daemon.backup_keep` multiplies it on disk.

## `--smol`

The released binary is compiled with `--smol` baked into its `execArgv`, so it runs a smaller heap and
collects more often. Measured on two live boxes, before and after the same build otherwise:

| | RSS before | RSS after | heap before | after |
|---|---|---|---|---|
| 6 agents, 9 gateways | 76.5 MB | **65.6 MB** | 48.6 MB | 41.4 MB |
| 1 agent, 2 gateways | 95.4 MB | **79.3 MB** | 46.4 MB | 33.2 MB |

The cost is CPU: an allocation-heavy benchmark shaped like a turn runs 21% slower. That is the right
trade here, because a turn's wall time is dominated by waiting on a model rather than by local
allocation, but `bun run build:binary --no-smol` builds without it for a host with memory to spare.

## Editions

One edition is published, Community, and it carries WhatsApp and Nougate in the binary.

| Build | Binary | Tarball | RSS idle | |
|---|---|---|---|---|
| Without Nougate | 88.6 MB | 40.0 MB | 58.0 MB | The daemon on its own |
| With Nougate, off | 88.9 MB | 40.2 MB | 59.7 MB | Community since 0.8.29 |

`RSS idle` here is the daemon carrying the code with the feature switched **off**: what it costs to
have the option.

Binary and tarball are `linux-x64` builds, taken at 0.7.0 and 0.6.0, when the second row was the Router edition.
The RSS figures were taken on the same build shapes and have not been re-measured since. Sizes drift with the Bun
runtime, so take them again before relying on them. Measured again for Pro in 0.7.20, in Docker on arm64: carrying
the gateway off costs about 1.3 MB of heap, and switching it on about 3.6 MB more at idle.

**A bundle you do not switch on is not free.** The dynamic import means the code is never
*evaluated*, but a bundled module graph is registered either way: that is the 1.7 MB between the two rows, the
price of offering Nougate to everyone who might choose it.

[Builds & downloads →](/en/docs/deployment/binaries/)

### Separate process versus bundled

| Component | Its own process | Bundled | Saved |
|---|---|---|---|
| WhatsApp bridge | 62.2 MB | +21.3 MB | **40.9 MB** |
| LLM gateway (nougate) | 44.6 MB | +6.0 MB | **38.6 MB** |
| both | 106.8 MB | +27.3 MB | **79.5 MB** |

This is why the bridge runs inside the daemon, and why Nougate is hosted the same way. Why the saving is roughly 36 MB either way: a separate process cannot share the
Bun runtime. Measured by running one binary twice, **~36 MB of runtime and
bundle pages are shared between processes of the same executable, and ~14.5 MB of heap is private to
each**. So a second process pays the 36 MB again; a second listener or a bundled module pays none of
it.

Both separate artefacts are almost entirely Bun: a bare compiled hello-world for `linux-x64` is
78.7 MB, so nougate's own code is **0.3 MB** of its 79.0 MB.

:::caution[Measure on the platform you ship]
One of these comparisons read **+56.5 MB** on macOS where Linux read +6.2 MB. That is RSS accounting
rather than a real cost, and it would have been published as fact if the numbers had only been taken
once.
:::

## Sizing a box

| Target | Verdict |
|---|---|
| **Raspberry Pi 4 / 5** (1 GB+) | Comfortable. `--target linux-arm64`. A Pi 5 is more than this needs |
| **Any 512 MB VPS** | Fine, including the dashboard. The cheapest tier at most providers. No external agents: one needs 512 MiB for the agents' commands |
| **1 GB VPS** | The recommendation. Headroom for `exec` output and several concurrent chats |
| **External agents** | 512 MiB for the agents' commands before one is offered, and room for each CLI that runs at once, one per agent. `nouride doctor` says how much the commands may hold |
| **Mini PC / NUC / old laptop** | Overkill, and the right choice anyway if the agent does infra work |
| **NAS with Docker** | Fine. Check `uname -m`: several are arm64 |
| **Alpine / musl** | Needs the `-musl` build **and** `apk add libstdc++` |

For Kubernetes, a starting point rather than a tuned answer:

```yaml
resources:
  requests:
    memory: 128Mi     # twice the 64 MB floor, where a start takes seconds, not tens of them
    cpu: 50m          # 0.17% of a core at idle
  limits:
    memory: 512Mi     # accommodates the boot peak and a turn with large tool output
    cpu: "1"
```

Watch the actual peak before tightening `limits`.

## The daemon is often not the largest process in its own cgroup

Worth knowing when planning a small box. On a live install, a single Node-based MCP server measured
91.5 MB against the daemon's 73.3 MB. On a 256 MB device that one server is the difference between
fitting and not.

The same goes for what agents start. A coding agent CLI run as a background job, or the headless
browser the browser-automation skill drives, is its own process charged to the same cgroup: a few
hundred MB each while it runs, by the skills' own estimate rather than a measurement here.

## External agents

An [external agent](/en/docs/manual/external-agents/)'s coding CLI was measured with a session open and idle, before
any work, the process and everything it started (2026-10-26, macOS arm64, signed out):

| CLI | Idle with a session open |
|---|---|
| Claude Code | 324 MB |
| Codex | 187 MB |

Working holds more. Each runs one per agent, started at its first turn and stopped after five quiet minutes, so
several agents answering at once each hold their own. With less than 512 MiB for the agents' commands (rounded up
from the larger figure), not one session would open, and no external agent is offered. The same floor decides whether
a mission in a repository gets a worktree of its own.

## Why it is this small

Not tuning. Four architectural choices:

- **Bun/JSC rather than Node/V8.** Under memory pressure the measured behaviour is to shrink to fit,
  rather than to hit a heap ceiling and abort.
- **No external infrastructure.** One SQLite file. The daemon links four third-party packages: one
  for HTTP and one for each chat platform.
- **No browser in the process and no local model.** These are what push comparable runtimes into
  gigabytes.
- **Agents are configuration, not processes.** 0.4 MB each, and that is a different category rather
  than a better implementation of the same one.

Part of the gap is **scope**. A Chromium instance is 300 MB to over 1 GB, four to fifteen times the
entire daemon, so browser automation is not in the daemon. It ships as a skill instead: the agent
drives a headless browser through `exec`, out of process, so it costs memory only while it runs, and
every step goes through the same approval gate as any other command. That matters more than the
memory: a browser driven by a model taking instructions from a chat message is a general-purpose
request engine inside your network boundary.
