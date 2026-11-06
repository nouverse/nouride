# System requirements

What Nouride actually costs to run, and what to run it on.

> **Every number here was measured, not estimated**, and each says where. A figure with no measurement
> behind it is labelled as reasoning, and one extrapolated from a shorter window says so.
>
> **Re-measured on 2026-10-17**, on the 0.7.11 branch, Bun 1.4.2, release-shaped builds (`--smol`):
>
> - **linux-arm64**, the compiled binary in `debian:12-slim` under Docker on an Apple M1 host, natively,
>   by the procedure in [Keeping this current](#keeping-this-current): the idle footprint, agents, the floor.
> - **linux-x64**, the same procedure, which on that host runs under Rosetta. Translation adds about
>   31 MB of anonymous memory — 27.3–27.5 MB native arm64 against 58.0–59.8 MB emulated x64, same
>   build, same pack — so these figures are an upper bound, given for the floor's shape and nothing finer.
> - **x64, natively**, on the x64 test box (2 cores, 2 GB, a Proxmox LXC container on ZFS): the live
>   0.7.10 daemon, with 6 agents and 9 gateways connected (six Discord bots, Telegram, WhatsApp
>   in-process, the dashboard), read without changing anything from `/proc` and its service cgroup over
>   119 minutes in which it did no work: resident memory, wake-ups, bytes written, CPU.
>
> **The floor, measured again the same day** after 0.7.11 lowered the password hash to OWASP's argon2id cost
> (19 MiB where Bun's default is 64): linux-arm64 by the same procedure, and every start a cold one — the
> binary's pages dropped from the page cache before each run, so all it reads is charged to the container
> under the limit. A first start and a later one both reach `ready` at 64 MB.
>
>
> **Coding CLIs (0.8.1)** were measured apart, on macOS arm64 and not by the Linux procedure: see
> [Coding CLIs](#measured-coding-clis-081).
>
> **Still not measured:** a turn's peak memory; the bytes a day with conversations in it writes (only an
> idle window, extrapolated); the Docker image rows; a Nouride Box card, which waits for a Box running
> this build. The 2026-08-14 figures nothing re-measured (Bun 1.3.4, the tree then at `71d6ba3`) are
> marked so where they stand, and the `--smol` RSS figures in [DEPLOY.md](./DEPLOY.md) are from live boxes.

---

## The short answer

| | |
|---|---|
| **Runs in** | 64 MB, a first start and every start after it (2026-10-17, linux-arm64, cold). Slowly at that limit: tens of seconds to `ready`, where 128 MB takes a few. ([The floor](#measured-the-floor).) |
| **Comfortable** | 512 MB. 1 GB if the agent does real work through `exec`. Reasoning, not a measurement: [a turn under load](#not-measured-a-turn-under-load). An external agent's coding CLI needs 512 MiB for the agents' commands on top of that: [Coding CLIs](#measured-coding-clis-081). |
| **Disk** | 120 MB installed (the 117 MB binary, the dashboard, skills), a 56 MB download, plus the install — linux-x64 on Bun 1.4.4, measured 2026-10-22; Bun's own runtime grew by 28 MB from 1.4.2, where it was 95 MB and 40 MB. A fresh `.nouride/data/` is 364 KB (2026-08-14); `.nouride/workspace/` grows with whatever the agents build. |
| **CPU** | Any. 0.17% of one core at idle — 0.1 s of CPU a minute — on the x64 test box with nine gateways connected; the daemon waits on the network almost all the time. |
| **Needs no** | Postgres, Redis, vector database, GPU, or local model. One SQLite file (TD-005). |

There is no minimum-viable-model requirement because Nouride does not host one.
Providers are remote endpoints, so RAM is unaffected by which model an agent uses.

> **What grows (2026-10-12):** not only `.nouride/workspace/`. Three more parts of `.nouride/` grow
> with use: `memory/`, the memory vault, a file per conversation; `bin/`, `lib/`, `opt/` and `home/`,
> what the agents install and their tools' caches, which `nouride doctor` sizes; and `data/`, whose
> database now also holds the memory index, and whose `backups/` keeps daily copies of the database,
> the packs and the vault. Measured once, on the x64 test box (2026-10-17): a 41 MB database, and its
> last eight snapshots 30 to 36 MB each. Nothing else here has been measured.

---

## Measured: idle footprint

The daemon at rest, gateways connected, no turn in flight. Resident memory is two things, and only one
of them is pressure: the pages of the executable mapped from disk, which the kernel drops and reads back
when memory is short, and the anonymous memory — the heap and the runtime — which it cannot. The second
column is the one to size against.

| Shape | Resident idle | of it, anonymous | Peak during boot | Artifact size |
|---|---|---|---|---|
| Compiled binary, linux-arm64, 1 agent (Docker on M1, 2026-10-17) | 59.0–67.5 MB | **27.3–27.5 MB** | 145.6 MB | 94 MB installed, 40 MB download |
| Compiled binary, linux-x64 under Rosetta, 1 agent (2026-10-17, an upper bound) | 84–103 MB | 58.0–59.8 MB | 175–179 MB | 95 MB installed, 40 MB download |
| The x64 test box, live 0.7.10, 6 agents, 9 gateways (2026-10-17) | 117–128 MB | **87–98 MB** | 206 MB since its start, turns included | — |
| Pro Router, Linux arm64 (Pi Zero 2 W), 1 agent, LLM gateway in-process (2026-10-15) | **80.0 MB** — 33.9 MB heap, 46.0 MB binary pages | — | 86.2 MB | 90 MB binary, + dashboard and gateway frontend |
| Compiled binary, macOS, 0 agents (2026-08-14, not re-measured) | 63.7 MB | — | — | 58 MB |
| Docker image (2026-08-14, Bun running `.ts`, not re-measured) | 69 MB process / 96 MB container | — | 166 MB | 85 MB image |

Sampled every 15 s for a minute after `ready` (linux-arm64): resident 73.4 MB, then between 59.0 and
67.5 MB as the binary's pages were dropped and read back; anonymous 33.6 MB, then flat at 27.3–27.5 MB;
16 threads, then 5. The 2026-08-14 build measured 74.5 MB resident and a 139.7 MB peak the same way.

**The live box carries what a quiet test does not:** six Discord bots and WhatsApp's session held
in-process, nine connections' buffers, a 41 MB database and the caches a day of turns leaves. Read from
`/proc/<pid>/status` once a minute for 119 minutes in which it did no work: resident 117.1–128.1 MB,
anonymous 87.2–98.2 MB, the binary's pages about 30 MB; its service cgroup, page cache included, a median
of 109.2 MiB. Flat but for one step: about 10 MB more anonymous memory and up to three more threads
over three minutes, an hour in, settling about 5 MB above where it began — nothing the database, the log
or the event stream recorded explains it. The same box measured 65.6 MB resident and 41.4 MB anonymous on
2026-09-02, with `--smol` ([DEPLOY.md](./DEPLOY.md)); since then WhatsApp's bridge moved into the daemon
(2026-09-16), and the memory index and the event stream arrived.

**How the difference divides (2026-10-17), and no leak in it.** The engine's own idle baseline grew
5–6 MB from v0.1.0 (2026-09-10) to the 0.7.11 branch — measured: each tag's linux-arm64 `--smol`
binary, Bun 1.4.2 for all, the same config with no gateways, 16.2–17.8 MB anonymous then against
22.3–22.6 MB now with one agent; its JS heap after a full collection is 3.4 MB at v0.6.0 against 4.2 MB
now, more modules and functions and no more data. WhatsApp's bridge in the daemon is +21.3 MB
(measured: the site's performance page, separate process versus bundled). The
rest is reasoned, not measured: SQLite's page cache, 2 MB until 2026-10-11 and 16 MB since, fills
with use on a 41 MB database — up to 14 MB; the Pro edition's code; and what a day of turns leaves —
compiled code, allocator pages kept after a 206 MB peak, six Discord bots' guild and channel caches
(their message, user and member caches are 0). The 10 MB step is not explained: no log line in that
window, and the Discord adapter does not log a resume. Two maps that grew with every conversation
ever seen — the activity view and the late-message notices — are bounded since 0.7.11.

**The Pro Router row is two numbers, and only one of them is pressure.** Measured on a Nouride Box on
2026-10-15, with its Telegram and dashboard gateways connected and `--smol` as every release is built:
of the 80 MB resident, 46 MB is pages of the 90 MB executable mapped from disk, which the kernel drops
and re-reads when memory is short — and 34 MB is the heap, which it cannot. The same box read 100 MB
right after a reboot and 80 MB seven hours later with nothing changed: the difference was binary pages
that had not been dropped yet. Hosting the gateway in the same process (`[nougate] in_process`) costs a
few megabytes of heap — 33.2 MB for the plain Pro edition on the same board ([DEPLOY.md](./DEPLOY.md)),
33.9 to 39 MB here — where a second process would cost a second Bun runtime. The LLM Gateway page (the
gateway's dashboard inside this one) adds nothing measurable at rest: 80.2 MB before it, 80.0 MB after.
Flat, with no drift, 12 threads and no child processes.

The boot peak is roughly double the resting figure, and it is what a memory limit has to accommodate,
not the resting number. On a first start most of the difference used to be one allocation: the
dashboard's account is created and its password hashed with argon2id, and at Bun's parameters —
`m=65536,t=2,p=1`, 64 MiB — anonymous memory went from 29 to 95 MB in the 20 ms after "persona packs
backed up" (traced through boot every 10 ms, before 0.7.11). Since 0.7.11 the hash is OWASP's
`m=19456,t=2,p=1`, 19 MiB for about 20 ms, and a sign-in verifies at whatever cost its stored hash
records: an account made before that pays the 64 MiB once more, at its first sign-in, and is then
hashed again at 19 MiB.

The compiled binary and the image land within ~10 MB of each other.
The image runs TypeScript through Bun directly rather than a compiled bundle, which costs a little more
at boot; neither difference is large enough to choose between the two shapes on memory grounds.

> **2026-10-12:** the image now runs one bundled `nouride.bundle.js` built from the same source, not
> the `.ts` files. The Docker row above was measured before that change and has not been re-measured.
Choose on the grounds in [DEPLOY.md](./DEPLOY.md) instead — whether the agent should be able to act on
the host.

## Measured: the floor

Run under a hard cgroup limit with swap off, checking whether the daemon logs "nouride ready" — twice,
because the two starts are not the same: the **first start** creates the dashboard's account and hashes
its password, and a **later start** finds it there. linux-arm64, 1 agent, the dashboard on, 2026-10-17,
on the 0.7.11 branch with the password hash at OWASP's cost (19 MiB, above). **Every start a cold one:**
the binary's pages dropped from the page cache before each run, so everything it reads is charged to
the container under the limit. "Killed" is the cgroup's OOM killer; the times are to `ready`, on a
loaded Docker host.

| Limit | First start | Later start |
|---|---|---|
| 128 MB | ready, 2/2 — 2–5 s | ready, 2/2 — 1–3 s |
| 96 MB | ready, 2/2 — 3–5 s | ready, 2/2 — 1–4 s |
| 80 MB | ready, 2/2 — 5–8 s | ready, 2/2 — 2–8 s |
| 72 MB | ready, 2/2 — 4–11 s | ready, 2/2 — 3–14 s |
| **64 MB** | **ready, 4/4** — 9–68 s, 26–30 MB anonymous | **ready, 2/2** — 16–22 s, 25 MB anonymous |
| 56 MB | ready 2/4, killed 2/4 | ready, 2/2 — 19–22 s |
| 48 MB | killed 1/2, not ready in 90 s 1/2 | ready, 2/2 — 60–89 s |

**64 MB is the floor, for a first start and every start after it.** Below it a first start is a coin
toss, and a later one gets there only after a minute or more of reading the binary again and again.
At 64 MB a start pages for tens of seconds; at 128 it takes a few. With no limit, a first start's
resident peak was 98 MB and its anonymous memory 37 MB five seconds after `ready`.

Before 0.7.11 the floor of a first start was 112 MB, with a later start at 64: the account's password
was hashed at Bun's 64 MiB, and every kill came at that hash (killed at 96 MB, ready at 112 MB with a
100.7 MB peak — the same day, by the same procedure but with the binary's pages left cached). With the
dashboard turned off (`[dashboard] enabled = false` — no account, so no hash), a first start reached
`ready` at 48 MB then too. Under Rosetta, linux-x64 moved the same way and higher, and has not been run
again since the hash changed.

The 2026-08-14 build was recorded reaching `ready` at 64 MB and killed at 48 MB. Its boot also created
the account (`ensureInitialAdmin`, in the tree then at `71d6ba3`); why it fit then is not known — that
run's limits and data directory were not recorded beyond the table, and it has not been repeated.

**The runtime adapts to the limit rather than demanding a fixed budget.** Given 256 MB the old first
start peaked at about 145 MB, and a later start runs its anonymous memory in 25–28 MB under any limit
from 48 to 128 MB. So the boot peak is not the floor; the floor is where the binary's pages, the
runtime and the password hash stop fitting at once.

Do not deploy at the floor.
It is the number that proves the daemon is small, not a recommendation: at 64 MB a start takes tens of
seconds, and there is nothing left for a turn.

## Measured: agents are almost free

| Agent packs loaded | Anonymous, idle | Boot peak |
|---|---|---|
| 1 | 27.3–27.5 MB | 145.6 MB |
| 3 | 28.2–28.4 MB | 146.8 MB |
| 6 | 29.1–29.2 MB | 146.9 MB |

linux-arm64, Docker on M1, 2026-10-17, from 30 s to a minute after `ready`. Under Rosetta, linux-x64:
58.0–59.8, 59.4–59.5 and 62.6 MB.

**Roughly 0.4 MB per idle agent** — 0.34 MB from one to six here, about 0.4 on 2026-08-14. An agent a model answers is a directory of markdown, not a process: the prompt is
assembled per turn and not held resident, and every agent shares one process, one database and one
HTTP server.

This is the number to size against when adding agents, and it is the wrong one for sizing concurrent
*work* — see below.

An external agent (0.8.1) is not: a coding CLI answers it, a process of its own from its first turn until five quiet
minutes after its last — a few hundred MB each, below.

## Measured: coding CLIs (0.8.1)

What one coding CLI held with a session open and idle, before it had done any work — the process and every process it
started. Measured 2026-10-26 on macOS arm64, signed out, while 0.8.1 was built (`CLI_SESSION_BYTES` in
`apps/engine/src/modules/external-agents/index.ts`); not by the Linux procedure under [Keeping this
current](#keeping-this-current), and whether the figure was resident or anonymous memory was not recorded.

| CLI | Held, idle |
|---|---|
| Claude Code (`claude-agent-acp`) | 324 MB |
| Codex (`codex-acp`) | 187 MB |

A working session holds more, and that has not been measured. **512 MiB is the floor, rounded up from the larger**:
with less room than that for the agents' commands — their cgroup's limit where they have one, else the machine's
memory — `nouride agents scan` says so and no CLI is offered. Where the agents' commands have a cgroup of their own,
the daemon keeps a fifth of the machine for itself, at least 256 MiB and at most 512 (`process-cgroup.ts`), so the
floor needs a 768 MiB machine — derived from those rules, not measured. Each external agent runs its own CLI, so two
that work at once hold two of these.

**A mission in a repository** (0.8.1) works in a worktree of its own only where the agents' commands have that same
512 MiB, and the free disk is at least twice the repository's checked-out files — one copy, and as much again for what
installing its dependencies into it adds. Below either it works in the repository itself, and the missions in one
repository run one at a time.

## Measured: what an idle daemon does to the box

On the x64 test box, the live daemon (6 agents, 9 gateways), read once a minute from `/proc/<pid>/io`,
`/proc/<pid>/task/*/status`, `/proc/<pid>/stat` and the interface's counters over 119 minutes —
2026-10-17, 09:45 to 11:44 UTC, in two runs — in which it took no turn, made no model call, saw no room message and
wrote no log or event row, checked against its own database afterwards. Nothing on the box was changed
to measure it: `perf`, `strace` and `fatrace` are not installed there, so context switches stand in for
`sched_wakeup`, and bytes written are the kernel's per-process count.

| What | Measured | Per day |
|---|---|---|
| Bytes written (`write_bytes`; `wchar` about the same) | 30 KiB in 119 minutes, 6.7 write calls a minute | **about 0.35 MiB, extrapolated** from an idle window |
| Wake-ups (voluntary context switches, all threads) | median 635 a minute | — |
| … the event loop's thread | median 236 a minute — the container's interface received a median 255 packets a minute, nearly all of them the daemon's connections | — |
| … JavaScriptCore's GC helper; mimalloc's scavenger | median 240; median 142 a minute | — |
| CPU | 10 ticks a minute (0.1 s) — 0.17% of one core | — |

**Writing, the daemon does almost nothing while nobody talks to it**: its log and audit buffers arm a
flush only when they hold something, and nothing was written to the database. What a day with
conversations writes is not in this table: each turn's rows, the nightly memory pass and the day's
database snapshot, which is taken only on a day something was written — on this box a copy of 30 to
36 MB (the last eight in `data/backups/db`). That day's figure needs a day with turns in it, sampled the
same way.

**Waking, it is the runtime and the network, not the daemon's timers.** The event loop's thread woke
about as often as packets arrived — six Discord bots' gateways, WhatsApp and Telegram — and two runtime
threads, the garbage collector's helper and the allocator's scavenger, woke about as often again
between them. The daemon's own timers — a health check per gateway every 30 s, the cron sleep, the
heartbeat, the memory pass's clock — come to about twenty a minute here by their intervals (derived, not
measured), a tenth of the event loop's figure. A box with one Telegram bot and no dashboard tab open
would see far fewer packets; it has not been measured.

---

## Not measured: a turn under load

Everything above is idle, with no LLM traffic.
Per-turn peak memory has **not** been measured, because it needs a live provider key and a real
conversation.

What bounds it is configuration, so the ceiling is at least knowable
(`config.example.toml`):

| Setting | Default | Why it drives memory |
|---|---|---|
| `tool_max_output_bytes` | 100 MB | Disk, not memory: what one `exec` may write to its spill file. In memory it holds at most ~64KB plus a ~96KB head and tail per call, whatever the command prints. |
| `max_tool_iterations` | 250 | Tool calls in a single turn. 5–9999. An agent's own `[llm]` table overrides it. |
| `max_conversation_turns` | 200 | Stored history per conversation. |
| `max_context_ratio` | 0.8 | Share of the model's context window that gets filled. |
| `max_tokens_per_turn` | 32000 | Response size. |

**Memory scales with concurrent turns, not with agents.** The queue is ordered per conversation and
parallel across conversations, so ten chats being answered at once is ten contexts assembled at once.
One agent in ten busy channels costs more than ten agents in one quiet one.

*Reasoning, not measurement:* a single turn reading a large file or running an `exec` that prints
megabytes is the realistic worst case, and 10 MB of tool output plus an assembled context is the
shape of it. This is why the recommendation is 512 MB rather than 128 MB, and it should be replaced
with a measurement the first time a real workload runs.

---

## Sizing a box

| Target | Verdict |
|---|---|
| **Raspberry Pi 4 / 5** (1 GB+) | Comfortable. Use `--target linux-arm64`. A Pi 5 is more than this needs. |
| **Any 512 MB VPS** | Fine, including the dashboard. The cheapest tier at most providers. Not for an external agent: a coding CLI needs 512 MiB for the agents' commands alone ([Coding CLIs](#measured-coding-clis-081)). |
| **1 GB VPS** | The recommendation. Headroom for `exec` output and several concurrent chats. |
| **Mini PC / NUC / old laptop** | Overkill, and the right choice anyway if the agent does infra work — a native install can act on the host. |
| **NAS with Docker** (Synology, QNAP, Unraid) | Fine. Check `uname -m` for the target: several are arm64. |
| **Alpine / musl anything** | Needs the `-musl` build **and** `apk add libstdc++`. See [DEPLOY.md](./DEPLOY.md). |
| **Kubernetes** | See below. |

For Kubernetes, a starting point rather than a tuned answer:

```yaml
resources:
  requests:
    memory: 128Mi     # twice the 64 MB floor: a start there pages for tens of seconds, at 128 for a few
    cpu: 50m          # 0.17% of a core at idle, on the x64 test box
  limits:
    memory: 512Mi     # accommodates the boot peak and a turn with large tool output
    cpu: "1"
```

Watch the actual peak before tightening `limits`.
A limit below the boot peak produces an OOM kill during startup, which reads as a crash loop with no
error in the daemon's own log — the process never gets far enough to write one.

---

## Compared to other self-hosted agent runtimes

Only the **API-only** configuration is a fair comparison: Nouride has no browser automation and no
local-model support, so any figure that includes either is measuring a different system.

| | Minimum | Notes |
|---|---|---|
| **Nouride** | 64 MB, a first start included, measured (2026-10-17); 512 MB recommended | Bun/JSC, one process, SQLite |
| **Hermes Agent** (API-only) | 1–2 GB | 4 GB with browser automation active |
| **OpenClaw** | 2 GB, 4 GB recommended | 2–3 GB *per agent* in multi-agent setups; 16 GB for production |

The gap is roughly 20–30×, and it is architectural rather than the result of tuning:

- **Bun/JSC against Node/V8.** OpenClaw runs on Node, where V8's default heap ceiling is around
  1.5–2 GB and the failure mode is `JavaScript heap out of memory` — an instant crash rather than
  degradation. Nouride's measured behaviour under pressure is the opposite: given 64 MB, a first start
  included, it shrinks to fit, running its anonymous memory in 25–30 MB.
- **No external infrastructure.** No Postgres, no Redis, no vector database — one SQLite file. The
  engine's only non-workspace dependency is `hono`.
- **No browser and no local model.** These are what push the other two into gigabytes, and Nouride
  does neither.
- **Agents are configuration, not processes.** Measured at ~0.4 MB per idle agent against OpenClaw's
  documented 2–3 GB. Different category, not a better implementation of the same one. An external agent (0.8.1) is
  the exception: its coding CLI is a process, 187–324 MB idle ([Coding CLIs](#measured-coding-clis-081)).

**Two caveats, both important.** The Nouride figures are first-party measurements on the hardware named
above; the comparison figures come from third-party setup guides of varying quality, and while they
agree on the scale — gigabytes, not tens of megabytes — no single one of them should be treated as
authoritative. And part of the gap is **scope**: adding browser automation or local models would put
Nouride in the same class immediately.

Sources: [Cherry Servers](https://www.cherryservers.com/blog/openclaw-hardware-requirements) ·
[TechRadar](https://techradar.com/pro/how-to-self-host-your-openclaw-environment-on-a-vps-server) ·
[Contabo](https://contabo.com/blog/how-to-install-hermes-agent-on-a-vps-2026-step-by-step-guide/)

---

## Browser automation would change every number here

Not planned, and the resource profile is only the third reason.

**It would erase the measured advantage.** A Chromium instance is 300 MB to over 1 GB, which is four
to fifteen times the entire daemon. The 512 MB recommendation becomes 2 GB, and the Raspberry Pi row
in the table above stops being true.

**It fights TD-001 and the image's minimalism.** A driven browser means platform-specific binaries
fetched at install time, and the container runs as uid 1000 precisely so that nothing can install
anything at runtime — a decision already verified by watching `apk add` fail.

**It is the security reason that actually decides it.** A browser driven by a model that takes its
instructions from a chat message is a general-purpose request engine inside the network boundary. The
`web_fetch` SSRF guard exists because that tool once read a loopback service and handed the body to
the model, and `allow_private_urls` defaults to `false` because on a server an agent that can reach
`127.0.0.1` can read every internal service on the box. Browser automation is that hole reopened by
design, and a headless browser has no equivalent of the exec approval gate.

**If it is ever wanted, it belongs out of process.** An MCP server owning the browser keeps it out of
the daemon's footprint, out of its dependency graph and behind a tool boundary that can be refused per
agent — and the MCP client is already the next phase, so this needs no new architecture.

> **2026-10-12:** two statements above no longer hold. A built-in skill, `browser-automation`, now
> drives a headless browser out of process — Playwright through `exec`, installed on demand where Node
> is — and none of the figures in this file include it: while it runs, the browser is the 300 MB to
> 1 GB described above, on top of the daemon. And the container's user can now install programs at
> runtime without root, into `.nouride/bin` on the volume. The MCP client this section calls the next phase has
> shipped.
>
> **2026-11-03 (0.8.15):** system packages too. The daemon's user still cannot `apk add`: a root service the
> entrypoint starts installs a package by name, under fixed rules and asking a person first unless the agent is
> `trusted`, and what agents installed is kept on the volume and installed again when the container is recreated.

What covers most of the real need today: `web_fetch` for reading pages, and
`allow_private_urls = true` for checking a service the agent just started. The genuine remaining gap
is pages that render their content in JavaScript, which a fetch cannot see. That is narrower than
"we need a browser" and worth confirming against a real task before spending anything on it.

---

## Keeping this current

**This document goes stale silently.** Nothing fails when a dependency, a runtime upgrade or a new
resident cache moves these numbers — the daemon keeps working and the file keeps claiming 64 MB, as it
did after the first start began creating an account and needing 112 until 0.7.11. So the provenance note at the top
carries the date and what was measured where, and re-measuring is a documented procedure rather than a
research task.

**Re-measure when any of these changes:**

- The Bun version, or any dependency that loads at boot.
- Anything held resident per agent, per conversation or per gateway — a cache, a registry, an index.
- Anything a start or a sign-in allocates at once — a password hash's parameters above all.
- The ceilings in the table above, particularly `tool_max_output_bytes`.
- Anything that adds a process: a browser, a local model, a sidecar, an MCP server.
- A built-in coding CLI, or the adapter it runs behind, at a new version — for its row under Coding CLIs, and the
  512 MiB floor rounded up from the larger of them.

Then update the numbers **and** the provenance note, in the same commit as the change that moved them.

A running daemon says its own memory: `/health` carries `memory.rssBytes` and `memory.heapUsedBytes`,
and `nouride doctor` prints them. That reads a live box without a shell on it; the procedure below is
what makes two builds comparable.

```bash
# 1. Build the Linux artifact.
bun run build:binary --target linux-arm64        # or linux-x64 — under Rosetta on an Apple host: see the provenance

# 2. Idle footprint with one agent pack, inside a real Linux container.
#    Not on macOS: the host figures differ, and the deploy target is Linux.
#    The example pack is a disabled template naming the `anthropic` profile, and there are no built-in
#    profiles: enabled and given one, it loads; as it ships, the run measures no agent at all.
docker run --rm --platform linux/arm64 \
  -v "$PWD/dist:/art:ro" -v "$PWD/content/agents:/packs:ro" debian:12-slim sh -c '
    mkdir -p /srv/nouride && cd /srv/nouride && tar -xzf /art/nouride-linux-arm64.tar.gz
    mkdir -p .nouride/agents && cp -R /packs/example .nouride/agents/example1
    sed -i -e "s/^name = \"example\"/name = \"example1\"/" -e "s/^enabled = false/enabled = true/" .nouride/agents/example1/config.toml
    printf "[providers.anthropic]\nkind = \"anthropic\"\nbase_url = \"https://api.anthropic.com/v1\"\napi_key = \"ANTHROPIC_API_KEY\"\n" > .nouride/config.toml
    ./nouride start > run.log 2>&1 & PID=$!
    sleep 12
    grep -o "\"count\":[0-9]*" run.log | head -1
    awk "/VmRSS|VmHWM|RssAnon|RssFile|Threads/{print \$1, \$2}" /proc/$PID/status'

# 3. The floor: the same command with --memory=<limit> --memory-swap=<limit>, checking for
#    "nouride ready" in run.log. Bisect downward — the runtime shrinks to fit, so the floor is where boot
#    fails, not where RSS lands. Twice: on a fresh data directory (the first start, which creates the
#    dashboard's account), and on one a first start has already made (a later start). Extract into a
#    volume from an unlimited container first, so the limited one holds the daemon and not the page
#    cache of a 95 MB tarball it just wrote. And drop the binary's pages from the page cache before
#    each limited run — otherwise they were read, and are charged, by an earlier container, and a limit
#    looks roomier than a cold start finds it (`fincore` says how many are cached; 0 before each run):
docker run --rm -v <the volume>:/srv debian:12-slim dd if=/srv/nouride/nouride iflag=nocache count=0
docker run --rm --platform linux/arm64 --memory=64m --memory-swap=64m ...
```

`VmHWM` is the peak and `VmRSS` the current figure; both are in kB in `/proc/<pid>/status`, and
`RssAnon` is the part the kernel cannot drop. Sample for at least a minute before calling the resting
number flat — the point of the sampling is to catch drift, and one reading cannot.
