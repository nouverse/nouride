# Nouride — Specification Document

> Lightweight, multi-agent AI engine. One process, many agents, zero bloat.

**Author:** Nouverse Technologies

---

## 1. Overview

Nouride is a single-daemon, multi-agent AI runtime built on **Bun** that routes messages from multiple chat platforms (Discord, Telegram, WhatsApp) to isolated AI agents — each with their own persona, skills, tools, and channel bindings. Agents share a single process but maintain strict identity and capability boundaries.

### Design Principles

1. **Single Process, Multi-Agent** — One daemon handles all agents. No container-per-agent overhead.
2. **Zero Bloat** — Minimal dependencies. Bun-native APIs over npm packages wherever possible.
3. **Persona-First** — Each agent has its own identity (SOUL.md, IDENTITY.md) and its own selection from the shared skill pool. Who the people are is the daemon's (`[[people]]`), shared by every agent.
4. **Gateway-Agnostic Internally** — Agents don't know about Discord/Telegram/WhatsApp. A unified message envelope abstracts the transport.
5. **Security by Default** — Tool execution is sandboxed, approval-gated, and auditable.

---

## 2. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Bun (native) | Built-in HTTP, SQLite, spawn, test, fast startup |
| Database | SQLite (`bun:sqlite`) | Sessions, turns, jobs, memory index, auth, audit log. Zero external deps (TD-015) |
| HTTP Server | `Bun.serve()` + Hono | Web dashboard, control API, webhook receivers |
| Process Exec | `Bun.spawn()` | Tool execution with no-shell default |
| Crypto | `node:crypto` (through `@nouride/runtime`) / `Bun.password` | Auth hashing, token generation |
| Test | `bun:test` | Native test runner |

### External Dependencies (Hard)

| Package | Purpose | License | Notes |
|---|---|---|---|
| `discord.js` | Discord gateway | Apache-2.0 | Mature, stable |
| `grammy` | Telegram Bot API | MIT | Lightweight alternative to Telegraf |
| `@whiskeysockets/baileys` | WhatsApp Web | MIT | Large dependency tree — kept in its own module, see §16.1 |
| `whatsapp-rust-bridge` | Signal protocol, behind the `libsignal` shim | MIT | Already a dependency of Baileys; see `packages/wa-bridge/README.md` |
| `hono` | HTTP routing for the dashboard and control API | MIT | Routing only — the server is `Bun.serve()` (TD-002) |

### Explicit Non-Dependencies

- ❌ LangChain / LangGraph — unnecessary abstraction for our routing model
- ❌ Express / Fastify — `Bun.serve()` sufficient
- ❌ External DB (Postgres/Redis) — SQLite covers all persistence needs
- ❌ External LLM SDKs — raw `fetch()` to provider APIs (OpenAI-compatible format)

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Nouride Daemon                       │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Discord  │  │ Telegram │  │ WhatsApp │   Gateways    │
│  │ Gateway  │  │ Gateway  │  │ Gateway  │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │              │                    │
│       └──────────────┼──────────────┘                    │
│                      ▼                                   │
│            ┌─────────────────┐                           │
│            │  Message Router  │  ← Unified envelope      │
│            └────────┬────────┘                           │
│                     ▼                                    │
│       ┌─────────────────────────┐                        │
│       │    Agent Registry       │                        │
│       │  ┌───────┐ ┌───────┐   │                        │
│       │  │ Nox   │ │ Nouva │   │  Isolated agents       │
│       │  │SOUL.md│ │SOUL.md│   │  with own persona,     │
│       │  │skills │ │skills │   │  skills, channels      │
│       │  └───────┘ └───────┘   │                        │
│       └─────────┬───────────────┘                        │
│                 ▼                                        │
│       ┌─────────────────┐                                │
│       │  LLM Executor   │  ← fetch() to provider API    │
│       └────────┬────────┘                                │
│                ▼                                        │
│       ┌─────────────────┐                                │
│       │  Tool Executor  │  ← Sandboxed Bun.spawn()      │
│       │  + Approval Gate│                                │
│       └────────┬────────┘                                │
│                ▼                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │  Cron    │  │  Hooks   │  │  SQLite  │   Services    │
│  │ Scheduler│  │  System  │  │  Store   │              │
│  └──────────┘  └──────────┘  └──────────┘              │
│                                                         │
│  ┌──────────────────────────────────────┐               │
│  │         Web Dashboard (Bun.serve)    │               │
│  │  Login • Agent Config • Logs • Cron  │               │
│  └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Multi-Agent System

### 4.1 Agent Definition

Each agent lives in a directory under `[daemon] agents_dir` (`.nouride/agents/` by default):

```
agents/
├── nox/
│   ├── SOUL.md          # Persona, behavior, tone
│   ├── IDENTITY.md      # Name, headline, emoji, bio
│   ├── AGENTS.md        # Awareness of other agents (who they are, how to reach them)
│   ├── MEMORY.md        # The agent's own notes (§12.1) — what it remembers about people lives in the vault
│   ├── config.toml      # Agent-level config (channels, LLM provider, model, tools)
│   └── skills.toml      # Which pooled skills this agent has switched OFF (absent = all on)
├── nouva/
│   ├── SOUL.md
│   ├── ...
└── skills/              # The pool: every agent draws from it, on by default
    ├── security-audit/
    │   └── SKILL.md
    ├── web-search/
    │   └── SKILL.md
    └── ...
```

### 4.2 Agent Config (`config.toml`)

```toml
[agent]
display_name = "Nox"
emoji = "🌌🦉"
enabled = true

[llm]
provider = "anthropic"        # a [providers.<name>] profile in the daemon config — it owns the
                              # endpoint, the wire format and the credential
model = "claude-sonnet-4-20250514"
# small_model = "claude-haiku-4-5"        # its small and high model tiers (§20); unset, the install's while
# high_model = "claude-opus-4-1"          # it runs on the install's provider, else `model`
max_tokens = 8192
temperature = 0.7

[channels]                                # keyed by gateway INSTANCE id (<platform>:<name>); each value is a
"discord:main" = ["1234567890123456789"]  # chat id as that gateway reports it: a Discord channel id,
"telegram:nouva" = ["-100123456"]         # a Telegram chat id,
"whatsapp:main" = ["abc@g.us"]            # a WhatsApp JID

[tools]
enabled = ["exec", "web_search", "web_fetch", "read", "write"]
approval_required = ["exec", "write"]     # Needs approval. For exec this is a *floor*:
                                         # the ceiling and ask mode live in [security.exec].
blocked = ["rm", "shutdown"]              # Blocked command patterns

[delegate]
max_background = 1                        # helpers this agent may have in the background at once (§13.3);
                                          # absent follows the daemon's [delegate], 0 is off

# Skills are not configured here — see §6.3. One pool (`agents/skills/`), every agent gets all of
# it, and this pack's exceptions live in `agents/nox/skills.toml`:
#
#   [skills]
#   document-authoring = false            # off for this agent only
```

The id is the directory's name. A key the pack does not read — a typo, a table no release reads — is named in a
warning when the pack loads (`unknown pack config key ignored`, with its file, table and key; `nouride config check`
lists it), and the agent loads: the daemon's config has always done the same (§20). A key whose loss would change
what the agent does is refused instead, naming what replaced it.

### 4.3 Inter-Agent Communication

There is no separate message bus: agents reach each other two ways.

- **In a room, by mention.** When Agent A mentions Agent B in a chat they are both in, the message is routed to B like any other, in front of the people in it.
  `[agents] mention_max_hops` (default 5) bounds a chain of agents answering each other, and a human speaking resets it (`ARCHITECTURE.md` §12); the notice that says a chain stopped carries Continue (§ the room's busy check, `way-on.ts`).
- **Behind the chat, with `ask_agent`.** In a one-to-one chat a mention reaches nobody, so the agent asks the peer directly.
  The peer runs a turn as itself — its own tools, memory and permissions — and its answer comes back as a tool result.
  Its approval level is its own posture, else the daemon's: never the asking person's (S14, since 0.7.10). A person's `/auto` was said to the agent they talk to, and the peer's task was written by that agent's model — so an agent could have work its own tools cannot do done unasked by handing it over. The person is still the one asked, in their own chat.
  While it runs the peer is at work in that chat (`TurnContext.holdPeer`): a person addressing it there is told it is busy, without the task, which the chat never saw; a scheduled turn and a job's wake-up wait for it; and asking it again there — its own turn running, or a second ask — is refused, said to the asker as the peer's reason.
  An ask does not hold the asking turn hostage (0.7.19, §13.4): it waits for the answer up to 45 seconds, then the peer's turn carries on as a job of the asking agent's and the answer wakes it in the chat when it comes; `background: true` returns at once.
- **Awareness:** Each agent's `AGENTS.md` describes who the other agents are and their roles, and the prompt lists the peers it can reach.
- **Isolation:** An agent's file tools reach its own pack and its workspace roots only, so another agent's SOUL/IDENTITY/MEMORY is out of their reach.
  Through `exec`, the agents directory is a sensitive path (§17.4) and asks first.

### 4.4 External Agents (0.8.1)

An external agent is a Nouride agent whose turns a coding CLI answers over the Agent Client Protocol: Claude Code
(`claude-agent-acp`) and Codex (`codex-acp`) are built in, and a person adds others as `[[external_clis]]` rows in
`config.toml`. A pack says which:

```toml
[external]
cli = "claude-code"
profile = "work"           # its sign-in folder; absent: "default"
permissions = "risky"      # folder | risky | all; absent: folder where agents are their own users, risky elsewhere
model = "sonnet"           # as the CLI names it; absent: the CLI's default
```

- **From the outside it is any agent:** its channel, rooms, schedules, missions, status and `ask_agent` are the same.
  Inside, the CLI keeps its own model, context, compaction and system prompt; Nouride keeps the transcript, the
  approvals and memory. Its `[llm]` stays, for Nouride's own work for it — a mission's review, the nightly memory
  pass — and for a turn the CLI cannot answer (signed out, at its account's limit, gone): the agent's own model answers
  that turn, its reply opening with a line that says so. Not a turn the CLI had begun to answer, nor one a person
  stopped (`pipeline/brain.ts`).
- **Run as the agent:** one CLI process per agent, started at its first turn and stopped after five quiet minutes —
  not while a command it left running in the background still runs (0.8.6, `commandsRunningUnder`), which a restart
  waits for as for a background job (§14.2) — as the agent's own user, from its own folder. A profile is a folder in it (`.cli/<cli>/<profile>`), pointed at by the
  CLI's own variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …) — two agents can hold two accounts of one CLI. Each
  conversation keeps its session, reopened after a restart where the CLI can.
- **A mission is one session (0.8.7):** a mission's turns are one conversation, `web:mission` and the mission's id
  (`cliSessionKey`), so its first turn opens one ACP session in the mission's folder and every later turn prompts that
  same session — kept beside the database (`keepSession`) and reopened after a restart with `session/load` where the
  CLI offers it; a CLI without `loadSession` starts a new one then. It is let go when the mission ends (`letGoCli` →
  `forgetSession`). Such a mission is held to time and tokens, not turns: one turn is a whole prompt the CLI may work
  on for an hour or more, and it is stopped after the turn's time *without a step* (`pipeline/turn-clock.ts`), not
  after the turn's time. Its tokens are what the CLI reports in `PromptResponse.usage` — unstable in ACP — and its
  helpers' metered tokens; where the CLI reports none, its page and `show` say "tokens unknown", never 0.
- **Accounts:** an agent's account is its `profile`. **Models → Coding CLIs** lists each CLI's accounts and the agents
  on each; the names added there are kept in the database (`daemon_state`, `cli-accounts.json` before 0.8.18). A Claude Code account is shared:
  it signs in once, there, with Claude Code's own `setup-token`, run as the daemon's user in a folder of its own that
  is removed when the sign-in ends. Only the long-lived token it prints is kept — in the secret store as
  `cli-<cli>-<account>`, never shown on the page — and each agent's CLI on that account is started with it. Codex has
  no token to share: one sign-in copied into several folders would be refreshed out from under the others, so each
  agent on a Codex account signs in once, in its own profile (`external-agents/accounts.ts`).
- **Sign-in** of an agent's own profile runs the CLI's login words in a terminal on the box, as the agent: the
  agent's Brain tab on the dashboard and `nouride agents login <id>` show the link and code, and send a typed line
  back.
- **Permissions:** the preset is the CLI's own mode; what the CLI still asks is a Nouride approval (`<cli>:<tool>`),
  parked inside a mission as any is. *Free in its folder* (`folder`) asks nothing — a push, a POST, `ssh` included —
  and is free only where each agent is its own user: in a container, on macOS or without the helper the CLI runs as
  the daemon's user, which reads the database and the secret store, so there it asks as *Ask when risky* does,
  whatever the pack says (`ExternalAgents.preset` in `external-agents/index.ts`).
- **Nouride's tools, lent over MCP** while a turn runs: a CLI that speaks MCP over HTTP is given `/mcp/agent` with a
  token of its session — or, for a CLI that fills its MCP headers from its environment (Claude Code), the agent's token
  in that environment and the conversation named in a header, so no token is in a command line another user on the
  box can read — and lists `ask_agent`, `delegate`, memory, people, `plan`, `notes`, `schedule`, `mission`, `work`,
  `send_message`, `send_file`, `agent_configure`, `persona`, `skill_root`, `agent_create`, the skill tools, `mcp_search`,
  `secret_save`, `attachment_read` and the agent's own MCP servers — each call run through the executor's own path,
  gated and audited, and marked lent (`ToolContext.lent`): `attachment_read` answers it with a path in the agent's own
  folder, since the reply carries text alone. Its files, shell and web are the CLI's; `nouride`, `update` and
  `session_status` stay a Nouride agent's (0.8.11). Its shell keeps the environment its process started with: a
  credential's handle is not in it, and the CLI is started again at a turn where the secrets it starts with changed
  and nothing else of the agent is at work.
- **What it reads about itself:** a block between Nouride's markers in the CLI's instruction file — in its profile where
  it reads one there in any folder (Codex's `CODEX_HOME/AGENTS.md`, so a mission in a person's repository has it too;
  0.8.4), else in the agent's folder (Claude Code's `CLAUDE.md`) — its name and the CLI, how a message says where it came from and who sent it, which of its tools stand for the ones
  its persona names, and its persona pack (`IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `MEMORY.md`), written when a session
  opens. One pack whoever answers; the person's lines stay. A turn's first prompt opens with where it came from — the
  platform, a DM or which group, the agents `ask_agent` reaches there — as a model's prompt says it.
  The block is written in the agent's own folder only, never in a mission's folder, which may be a person's
  repository (`external-agents/runner.ts`). Whether the CLI reads it in a session that works elsewhere is the CLI's
  own lookup, as each documents it (checked 2026-10-27): Claude Code reads the `CLAUDE.md` in the folder it works in
  and in every folder above it, so it reads the block in any session under the agent's folder — a mission's own folder or its
  worktree (§13.5) too. Codex reads `AGENTS.md` from its project's root — a repository's top, else the folder it works
  in — down to that folder, so it reads the block only in a session that works in the agent's folder itself: not in a
  mission. A mission that works in a folder outside the agent's reaches neither.
- **Its skills:** the ones switched on, where the CLI reads its own; not one that needs a tool the CLI neither has nor
  is lent. A claude.ai account's connectors stay off in Claude Code: they reach outside the gate.
- **The models it offers:** the CLI's model option, as a session that opened listed it, kept per agent across a
  restart (`daemon_state`; `external-models.json` before 0.8.18) and suggested on the Brain tab.
- **Never the orchestrator:** `setOrchestrator` refuses one, and a save of a pack that would make the orchestrator
  external is put back, saying why. A start that finds one anyway — a hand edit — runs with no orchestrator and says
  so, rather than refusing to start (`boot/preflight.ts`).
- **Unavailable, saying why:** not installed (with how to install it), not signed in, failing to start — on its status.
  A CLI at a version that has not passed yet answers a one-line prompt first ("OK"); one that does not makes the agent
  unavailable naming the version, the other agents untouched.
- **Only where the machine can hold one:** with less than 512 MiB for the agents' commands — their cgroup's limit
  where they have one, else the machine's memory — the scan says so and lists none. Measured with a session open and
  idle, on macOS arm64 and signed out: Claude Code 324 MB, Codex 187 MB (`docs/SYSTEM_REQUIREMENTS.md`).
- **What it says by itself, between turns (0.8.6):** a CLI can go on with no prompt running — Claude Code does when a
  command it left running in the background ends: it reads the output and says what came of it. That reaches the chat:
  the agent's chat is woken through its queue, as a job's end wakes it, and a turn there reads what the CLI said and
  what it says on, until it has been quiet ten seconds with no step open, prompting nothing; its record is headed "its
  coding CLI went on by itself". A prompt that opens first reads those words before its own answer, as a message of
  their own. A session another agent asked it in, or a mission's, wakes nothing — its words wait for its next prompt —
  and a reopened session's replayed history is not taken for new words (`external-agents/own-words.ts`). A prompt that
  leaves a new command running in the background is written down by chat (`daemon_state`, `cli-left-running` row), and let go once
  the command ends or the CLI says what came of it; what is still there at a start — the last process was stopped at
  once, or crashed — wakes the chat with a prompt to the CLI to check and say so, as a job a restart killed wakes its
  agent (`external-agents/left-running.ts`).
- **In a mission** the CLI keeps one session the mission long, works in the mission's folder — in a repository, a
  worktree of its own where the box has room for one (§13.5) — and finishes with the mission's own tool over MCP; its
  plan is the mission's checklist.

Nouride is also an ACP agent for an editor: `nouride acp [--agent <id>]` (`docs/CLI.md`) serves an agent to Zed and
the editors that copied it, the agent running in the daemon as always.

---

## 5. Gateway System

### 5.1 Unified Message Envelope

All gateways normalize incoming messages into a standard envelope:

```typescript
interface MessageEnvelope {
  id: string;                          // The platform's message ID
  timestamp: number;                   // Unix ms, by the platform's clock
  gateway: "discord" | "telegram" | "whatsapp" | "web";
  gatewayId: string;                   // The connection it arrived on: <platform>:<name>
  chatId: string;                      // Normalized chat identifier
  chatType: "dm" | "group" | "channel";
  senderId: string;                    // Platform-specific sender ID
  senderName: string;                  // Display name — untrusted, never matched on
  text: string;                        // Message content
  replyTo?: string;                    // Reply-to message ID
  quotedText?: string;                 // The message it replied to, joined in for the model only
  mentions?: string[];                 // Mentioned agent IDs
  attachments?: Attachment[];          // Media attachments
  raw: unknown;                        // Original platform payload
}
```

`web` is the dashboard's own chat and `nouride chat`, which travel the same path as a platform message.
The full type, with the fields for agent-to-agent hops and merged bursts, is `packages/shared/src/types/envelope.ts`.

### 5.2 Attachment Types

```typescript
interface Attachment {
  type: "image" | "audio" | "video" | "file" | "voice";
  url?: string;                        // Remote URL inbound before download, local path once stored
  buffer?: Uint8Array;                 // Raw bytes (for inline processing)
  mimeType: string;                    // e.g. "image/png", "audio/ogg"
  filename?: string;                   // Original filename if available
  size?: number;                       // Bytes
  duration?: number;                   // Seconds (audio/video)
  caption?: string;                    // Media caption (Telegram/WhatsApp)
  forwarded?: boolean;                 // Somebody else's words, not the sender's
  recordedBySender?: boolean;          // A video note: the sender talking, like a voice note
}
```

**Attachment Handling:**

- **Inbound:** Media is stored under `data/attachments/<agent>/<conversation>/<date>/`, one directory per conversation, and indexed in `chat_attachments` so every agent in the room can open it by ref (§7.6).
- **Outbound:** An agent sends a file with `send_file` (§7.2); the gateway handles the platform-specific upload.
- **Size limit:** `[attachments] max_size_mb` (default 50), checked before a byte is written: against the size the platform reports, before asking for the file; against the length the server declares, before reading its body; and against the bytes as they arrive, which the adapter hands over unread and the store counts onto disk, into `<name>.part` renamed once whole. No file is held whole in memory, whatever it said its size was (G9, 0.7.3).
- **Deadline:** 30 seconds per file, from asking for it to its last byte, for the platform's lookup as well as the download. A file that takes longer is reported to the agent as not downloaded, and the chat's queue is not held behind it.
- **Cleanup:** Attachments are swept with the conversation that mentions them, on `[retention] session_days` (default 30), at boot and daily — not by the cron scheduler, which schedules *user* work.
- **Voice notes:** heard by the model when it takes audio, otherwise transcribed through `[media] transcribe_provider` when one is set.

### 5.3 Outbound Message

```typescript
interface OutboundMessage {
  gatewayId: string;                   // The connection to send through: <platform>:<name>
  chatId: string;
  text: string;
  replyTo?: string;
  mentions?: string[];
  attachments?: Attachment[];
  suppressPreview?: boolean;
  onDelivered?: () => void;            // Called once the platform has accepted it
}
```

<a id="53-gateway-lifecycle"></a>

### 5.3b Gateway Lifecycle

Each gateway implements:

```typescript
interface Gateway {
  readonly id: string;                 // <platform>:<name>
  readonly platform: "discord" | "telegram" | "whatsapp" | "web";
  readonly status: "disconnected" | "connecting" | "connected" | "reconnecting" | "dead";
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<string[]>;   // the platform's ids for what was sent
  setTyping(chatId: string): Promise<void>;
  onMessage(handler: (env: MessageEnvelope) => void): void;
  onEvent(handler: (event: GatewayEvent) => void): void;  // status, dead, session_expired, delivery_refused
}
```

Optional capabilities — editing a message, marking it read, publishing the command menu, fetching an attachment again — are methods a gateway may leave out (`packages/shared/src/types/gateway.ts`).

### 5.4 Platform-Specific Notes

**Discord:**
- Use `discord.js` with gateway intents: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`
- Support slash commands for hooks (e.g., `/new`, `/reset`)
- Thread support: agent sessions can be scoped per-thread (see §6.4)
- Typing indicator while LLM is generating
- Chunked send: split responses >2000 chars into sequential messages
- ⚠️ **A bare tag counts as a message.** `worthDelivering()` — an empty body plus a mention of us is a
  turn, because `@Bot` with nothing behind it is how people point at the line above. Discord strips the
  tag from the text, so without this the message would be dropped as empty.

**Telegram:**
- Use `grammy` with long polling; `mode = "webhook"` is refused at start. A poll asks for messages only (`allowed_updates: ["message"]`): edits, channel posts and member changes were fetched only to be dropped
- Support bot commands (`/new`, `/reset`, etc.), published to the bot's command menu
- Typing indicator (`sendChatAction("typing")`) during LLM generation
- Reply-to threading: in a group, a reply quotes the message that triggered it; a DM does not quote
- Rendered as Telegram HTML, chunked as Markdown first so no chunk ends inside a tag
- What was sent while the daemon was down is fetched, not dropped; the inbox decides what is still worth answering (§10.1)
- ⚠️ **One `getUpdates` per token, and Telegram holds the session ~30s after the client leaves.** So a
  reconnect has to tear the previous poll down *and* wait out that window; `attemptConnect` does the
  first and `CONFLICT_SETTLE_MS` (35s) the second. Doing neither turned one failed `sendPhoto` into an
  hour of dead inbound: the retry's poll terminated the old one, Telegram answered it 409, that read as
  another dropped connection, and each attempt killed the poll that had just replaced it — with the log
  blaming "another bot instance" that was this daemon's own previous poll.
- ⚠️ **Privacy mode gates group context.** With it on (the default), the Bot API delivers only messages
  that tag the bot or are commands, so `[agents] group_context_messages` has nothing to remember.
  Disable it in @BotFather (`/setprivacy` → Disable) or make the bot a group admin. Nothing in a log
  can report this: the daemon cannot tell "the room was quiet" from "the room was not delivered".

**WhatsApp:**
- Use `@whiskeysockets/baileys` with QR auth
- Session credentials stored encrypted (AES-256-GCM, through `@nouride/runtime`)
- Kept in its own module, `packages/wa-bridge` — see §16.1
- Typing indicator (composing presence) during generation
- No live progress message: one closing line instead (`progressStyle = "summary"`, §6.5)
- Voice note support: download → STT if configured, otherwise attach as audio

### 5.5 Gateway Reconnection & Resilience

All gateways must implement reconnection logic:

```typescript
interface GatewayResilienceConfig {
  maxReconnectAttempts: number;        // Default 10 (WhatsApp 5)
  reconnectBackoffMs: number;          // Base backoff, default 1000ms (WhatsApp 2000ms)
  reconnectBackoffMaxMs: number;       // Max backoff cap, default 60000ms (WhatsApp 120000ms)
  reconnectBackoffMultiplier: number;  // Exponential factor, default 2
  healthCheckIntervalMs: number;       // Periodic liveness ping, default 30000ms
  connectionStableAfterMs?: number;    // A connection must hold this long before the retry budget is reset, default 60000ms
}
```

**Reconnection strategy:**
1. On disconnect → exponential backoff with jitter: `capped = min(base * multiplier^attempt, max)`, waiting between half of `capped` and all of it
2. During reconnect → queue outbound messages (bounded buffer, 100 messages max, oldest dropped first)
3. On reconnect success → flush queued messages in order; the attempt counter resets once the connection has held for `connectionStableAfterMs`
4. On max attempts exceeded → the gateway is `dead`, and the operator is alerted through `[alerts]` (§15)
5. Periodic health check: each gateway pings its upstream every `healthCheckIntervalMs`. If 3 consecutive health checks fail, trigger reconnect cycle.
6. **WhatsApp-specific:** Session expiry (QR re-auth needed) marks the gateway `dead` with a `session_expired` event → the operator is alerted, and the number is linked again from the dashboard.
7. **Credentials refused** (0.7.4): a connect the platform answers with a refused token — Telegram's 401 or 404 on `getMe`, Discord's `TokenInvalid` or 401 at login — throws `GatewayAuthError`. One more connect is tried, since Telegram answers a 401 now and then for a token that is fine; a second refusal marks the gateway `dead` with `auth_failed` at once, and the alert says the token was refused rather than that reconnecting gave up.

**Outbound pacing** (0.7.4, `commons/pace.ts`): every part of an answer — each chunk of text, each file — waits its turn in a token bucket per chat, and per bot where the platform has a limit of its own, so a long answer does not run into the platform's limit part-way. Telegram: one message a second in a chat, twenty a minute in a group, thirty a second in all; a 429 is waited out for the `retry_after` it names and the same message sent again, twice at most, rather than resent as plain text into the same limit. Discord: five messages in five seconds in a channel, its client already waiting out a 429 itself. WhatsApp's bridge paces its own chunks. Edits are not paced: the progress line is edited in place, and sharing a bucket with the answer would starve it.

**Not configurable** (since 0.8.0): each adapter keeps its own pacing — ten attempts from one second, doubling to a
minute; WhatsApp five, from two seconds to two minutes, its login being the flakiest — and a health check every thirty
seconds. A gateway's `[resilience]` table set these until 0.8.0; nobody tuned it, and one still in a file is named in a
warning and ignored.

---

## 6. LLM Executor

### 6.1 Provider Abstraction

No SDK. Raw `fetch()` to OpenAI-compatible and Anthropic Messages endpoints (TD-004, TD-006).
A provider is a `[providers.<name>]` profile — its wire format, base URL and the *name* of its credential — and an agent names the profile it runs on.

```typescript
interface LLMProvider {
  readonly kind: "openai" | "anthropic";
  readonly baseUrl: string;

  chat(params: ChatParams): Promise<ChatResponse>;
  stream(params: ChatParams): AsyncIterable<StreamChunk>;
  embed?(params: EmbedParams): Promise<EmbedResponse>;   // OpenAI-style /embeddings, for §12.3
}

interface ChatParams {
  model: string;
  messages: ChatMessage[];
  system?: string | SystemBlock[];     // blocks carry the cache boundaries (§6.3)
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
}
```

### 6.2 Tool Call Loop

```
User message
  → Build system prompt (§6.3)
  → Manage context window (§6.4)
  → Send to LLM with tool definitions
  → Start streaming response to gateway (§6.5)
  → If response has tool_calls:
      → For each tool call:
          → Check approval gate
          → If approved or auto-approved: execute tool
          → Collect result
      → Re-submit messages + tool results to LLM
      → Repeat until no more tool_calls or max_tool_iterations (default 250)
  → Return final text response to gateway
  → On max_tool_iterations hit: inject system message "Tool call limit reached.
    Summarize progress and ask user how to proceed." → one final LLM call
```

A turn is also bounded in time: `[llm.limits] max_turn_duration_ms` (default one hour, which is also the most allowed), wrapped up the same way.
Both limits are large on purpose, so one turn can carry a long piece of work through the way a coding agent does: the conversation is compacted as it grows (§6.4), and `/stop` ends a turn at once.
Work that waits on something slow — a build, a coding agent's run — still belongs in a background job, which wakes the agent when it is done.
Both limits can be set per agent (`nouride tool-budget`, `nouride turn-budget`).
Every message of a running turn is journaled as it happens, so a restart closes the turn with what it did rather than losing it, and a daemon back soon enough takes it up again (§14.2).

**Error handling in tool loop:**
- Tool execution error → include error text in tool result, let LLM decide recovery
- LLM API error that waiting can fix (429, overload, 5xx, timeout, dropped connection) → retry with exponential backoff (6 attempts, 1, 2, 4, 8, 16 s apart: ~30 s), then surface error to user and try the turn again once (below)
- Tool timeout → kill process, return timeout error to LLM
- Approval denied → return denial to LLM as tool result, let it adapt
- Approval expired → same as denied

**Provider retries** (`packages/llm/src/http.ts`): a longer wait the provider names (`Retry-After`, `retry-after-ms`) is honoured, up to 60 s each and 90 s of waiting in all; asked for more — a spent quota — the request fails at once rather than hold the chat.
At most 2 attempts may end in a timeout, since each can take 2 min. A wait ends at once when the turn is aborted (`/stop`, shutdown). A provider URL `fetch` cannot parse fails at once: configuration, not a network blip.

**Fallbacks** (0.8.0, which replaced 0.7.13's `fallback_model`): an agent's `[llm] fallbacks` — or, when its pack
names none, `[llm.defaults] fallbacks` — is a list of `{ provider, model }` pairs, tried in order when the model the turn
is on cannot answer after those retries (`executor/provider-caller.ts`). A pair on the same profile answers a rate limit,
an overloaded provider or a model not served (`model_not_found`); a pair on another profile also answers an endpoint
that is down — a 5xx, a refused connection, a timeout, a stream dropped before its reply began — out of credit or
refusing its key. A refused request, a content policy or an overflowed window is never fallen back on, nor is a stream
that fails after its reply began: the person has already read part of the answer. Each pair is tried once; the rest of
the turn stays on the one that answered, and its usage is charged to that profile. The turn's closing call — the one
that asks for a last word at its limit — goes through the same list. The operator is told once an outage — the first
fallback from a model in an hour (`pipeline/fallback-alert.ts`), with the fix when it is theirs. 0.8.0 rewrote a pack's `fallback_model`
on disk into one pair on its own provider at its first boot; since 0.8.1 one met again is refused for that agent, naming
the `fallbacks` line to write (`packages/persona/src/fallbacks.ts`).

**A turn its provider ended** is tried again once (`pipeline/provider-resume.ts`): ~3 min later, plus up to 1 min so a burst of failed chats spreads out, carrying on from where it stopped. Its error reply ends "…I'll try again in a few minutes, or say "continue"."
Not when a turn has started in that chat since (the person moved on), for a cron run, for a turn that was itself a resumption, or for a failure waiting cannot fix: an expired or refused key, an empty balance, a bad request — the operator's to fix.
The timer is in memory; the promise is a mark on the turn's record (`turn_records.retry_promised`), written as the turn tells its person. At boot, a turn that failed within the timer's window (4 min) with that mark, and was not taken up yet (`resume:<turn>`), is set again from when it failed (`providerResumesOwed`, `boot/durable.ts`). The mark, not the reply's last sentence, which the boot used to read: a promise made before that sentence was reworded would not have been found. A turn closed before the mark existed is still found by the sentence it was told in, kept as it was for that (`RETRY_PROMISE_BEFORE_THE_MARK`). "Continue" still picks the turn up.

### 6.3 System Prompt Builder

The system prompt is assembled in a deterministic order with clear section boundaries:

```
[1] Agent Identity Block
    ├── IDENTITY.md contents (name, headline, emoji, bio)
    └── SOUL.md contents (personality, behavior rules, tone)

[2] User Context Block
    └── (USER.md until 0.7.0 — who is speaking, and the operator's notes about them from
        `[[people]]`, are said in the runtime block instead, and only for that person)

[3] Agent Awareness Block
    └── AGENTS.md contents (other agents, their roles, how to reach them)

[4] Skills Block
    ├── Available skills listing (name, description, location)
    └── Active skill SKILL.md content (loaded on-demand when task matches)

[5] Memory Block
    └── MEMORY.md contents (the agent's own notes, §12.1)

[6] Harness Block
    └── How Nouride works, written by Nouride: files and roots, tools and what asks,
        where installed programs go, memory, the `nouride` CLI, large output; the machine
        (its cores and memory, as read at boot) and how much this agent may run on it at once

[7] Recall Block (RECALL)
    └── What is remembered about the people in this chat, in the order of their keys,
        shared.md, what is coming up, and the latest conversations this chat may see (§12.3)

[8] Runtime Context Block
    ├── Current date and timezone (the time itself rides on the message)
    ├── Agent name, model identity, platform, gateway instance and chat
    ├── Available tools listing, and the programs installed in `.nouride/bin` for an agent with `exec`
    └── Platform-specific instructions (Discord formatting, etc.)

[9] Dynamic Context Block (optional)
    └── Who is speaking: the sender's `[[people]]` entry, or that they are unverified
```

Each block is fenced with a delimiter the engine controls, so a persona file cannot impersonate a section (§17.1).
The order is the prompt cache's, and each tier ends in a cache boundary: blocks 1–5 change only when the pack does; the harness when the toolset or the exec posture does; recall when memory does — a fact written now, a cut, the nightly pass, midnight — and in a group when somebody new has spoken, never with who is speaking now (since 0.7.11); runtime and dynamic come last, because a new day, an install and a change of speaker move them.
On Anthropic that is three system breakpoints and the conversation's, the four the API allows; on an OpenAI-compatible endpoint, whose cache matches the longest unchanged prefix, it is the same order doing the same work.
`/prompt` prints the operator's own blocks and elides Nouride's.
How many helpers and missions are running now moves by the minute, so it is said on the message, beside the clock, and only while something runs: the harness block is byte for byte the same from turn to turn.

**Priority order:** If the prompt is over its ceiling, blocks are dropped in this order: Dynamic Context, Recall, Memory, Skills. Identity, User, Agent Awareness, Harness and Runtime are never trimmed.

**Token budget:** The prompt may use at most half the usable window (`[llm.context] max_context_ratio` of the model's window); past that, blocks are dropped in the order above and the drop is logged.

### 6.4 Conversation Context & Session Management

Each agent maintains independent conversation context per chat (keyed by `agent_id + chat_id + gateway`).

**Context window management:**

```toml
[llm.context]
max_context_ratio = 0.8              # share of the model's window a request may fill
truncation_strategy = "summary"      # summary | sliding_window
# summary_model = "…"                # model for the summaries (can be cheaper); unset uses [memory] pass_model when set, else the agent's
preserve_recent_turns = 4            # always keep the last N turns verbatim
compact_at_ratio = 0.8               # start making room at this fraction of the budget
# compact_at_tokens = 64000          # or at a fixed size; also settable per agent in [llm]
preserve_recent_tool_results = 3     # tool results kept verbatim mid-turn
```

The system prompt is never truncated here; it has its own ceiling (§6.3).

`compact_at_ratio` is a token ratio and not a turn number on purpose: one turn can be fifty tokens or
sixty thousand — a single `read` at the 256KB tool cap — so a turn-numbered threshold is sometimes early
and sometimes several turns late.

**Making room inside a turn:** the steps below run once, before the tool loop. A long turn also grows
*during* the loop, with an assistant message and a tool result per iteration, so before each provider
call the working set is measured again and, once it is over the line, older tool results are replaced
with a short marker, keeping the most recent `preserve_recent_tool_results` verbatim. A trim goes down to
three fifths of the line in one go (`TRIM_TO_SHARE`, a starting value), not only back under it: stopping
the moment the set fit trimmed one more result on every round after, each rewriting the start of the
conversation, so a provider's prompt cache read nothing back for the rest of the turn. Now the rounds
after a trim send the same prefix until the set has grown back to the line. The message is never removed —
only its content — because an orphaned `tool_use` is rejected outright by Anthropic. No provider call is
involved: this runs inside a turn somebody is waiting on. The content is not lost (0.7.25): it is written
whole to the conversation's spill directory first (`ToolOutputSpill.keepCleared`; a result already
spilled points at its existing file), and the marker names the path for `read`. Only a failed write
falls back to the old "read it again" marker, with a warning in the log. When the older results are not
enough, the text old calls carried goes next, oldest first: the arguments a tool declares as a file's
text (`Tool.bulkArguments`: `write`'s content, `edit`'s and `multi_edit`'s strings), each long one
replaced by a line giving its size and saying the call ran. Only a call already answered and older than
the latest round; the call, its id and its result stay. A call that sends that line back as its text is
answered with an error and not run.

**Sliding window:**
1. Token count all messages (system + conversation history + current user message)
2. If total exceeds the budget:
   a. Keep system prompt (always)
   b. Keep last `preserve_recent_turns` turns (always)
   c. Drop whole turns, oldest first, until under budget
3. The stored conversation keeps up to `[security] max_conversation_turns` (200) turns; what the window drops is only left out of the request

**Summary mode (the default):**
1. Clear old tool output first — no model call, and often enough on its own
2. Keep the newest turns verbatim, counted in tokens
3. Summarize everything older that is not summarized yet into a new part, with `summary_model`; a part is written once and never summarized again
4. When the parts together outgrow their budget, archive the oldest: each becomes one line with the range `memory_read` reads the exact exchanges back from
5. The result replaces the compacted turns in the stored session; a failed summary leaves the history as it was, and three failures in a row pause compaction for that conversation

`/compact` runs the same pass on demand (§9.1).

**Work notes (0.7.26):** what an agent writes with `notes` — a section per task, in a file per conversation under
`data/notes/` — is sent after everything else in every request (`ChatParams.tail`): after the conversation's cache
breakpoint, read fresh at every step, never part of the history. So compaction, the sliding window, the daily rollover,
`/new` and a restart never touch it, and a change to it costs no cache. 8 KB at most; a write holding a credential's
value is refused. `plan` keeps its steps with a task there while steps are left. `/reset` and `/notes clear` empty them
(the file before is kept a day); a task untouched for 14 days is set aside to an archive beside them, and the agent told.
A turn eight calls in that has written neither `notes` nor `plan` is asked to, once. A helper or a peer gets a
read-only copy of the task its work is part of, and no `notes` of its own. The dashboard's chat shows them in a drawer
beside a one-to-one conversation (`GET /sessions/:id/notes`), read again when a turn ends; an operator replaces the
whole file there (`PUT`), checked like the agent's own writes and recorded in the audit log.

**Token counting:**
- Approximate: 1 token ≈ 4 chars (English), 1 token ≈ 1.5 chars (CJK), biased high on prose so the window trims early rather than overflowing
- Scaled per conversation to what the provider counts: every call that reports usage measures its count over the estimate for that same request (between 1x and 4x; a provider that reported nothing teaches nothing), and every limit — the window, `compact_at_tokens`, the per-result cap — is held against the estimate at that scale. A log of timestamps and ids counts about 2.3x its characters/4; it is now trimmed and compacted at its real size. The scale is kept in memory per conversation and model, and a restart measures it again on the first call
- No per-provider tokenizer: the provider's own usage figures are what `llm_usage` records

**Large tool output (harness-enforced, no configuration):**

`security.tool_max_output_bytes` (100MB) bounds what one call may write to disk, not what enters the context.
Every tool result passes one choke point in `runTool`, and anything over the turn's per-result
budget is written to `<data_dir>/tool-output/<agent>/<conversation>/<call_id>.txt` while the model gets:

- the **head and tail**, never the middle — a long log carries its signal at the two ends, and whole
  lines only, because a fragment ending mid-token reads as corruption;
- the **measured** line count and size, because silently substituting a short result invites the model
  to conclude the command printed nothing and report success;
- the **path**, which is a read-only root for `read`, `glob` and `grep`, so "open it with an offset" is
  an instruction the agent can follow rather than a suggestion the sandbox then refuses.

`read`'s 256KB ceiling had to move for that last point to be true. It applied to the *file*, and refused
one over the limit with a message telling the agent to "use offset and limit" — which the same check
ignored. Every spill worth making is bigger than 256KB, so every pointer was dead on arrival; found by
driving a real turn against a 1.26MB spill. The cap is now on what a read **returns**: a windowed read
works at any file size and is cut at 256KB with the line to continue from, while a whole-file read keeps
the ceiling, because "give me all of it" on a 6MB file is the request it exists to refuse.

**Whose file it is.** The directory is cut by agent, then by conversation, and a turn's read-only root
is its own agent's conversation directory only. It used to be the whole `tool-output` directory for
every agent, which let one agent read what another's commands printed. A `delegate` helper writes under
the lead's conversation (its session id is a child of the lead's — `rootSessionOf`), so the path it
hands back is one the lead can open; a peer answering `ask_agent` keeps its files to itself. `/new`,
`/reset`, a rollover and deleting the conversation from the dashboard delete the conversation's directory
(`ENDS` in `pipeline/conversation-end.ts`, the one way a conversation ends); retention sweeps the rest after two days.

**`exec` streams.** A command's output no longer collects in memory up to `tool_max_output_bytes`. It is
held whole while small; past 64KB it goes to the call's spill file as it arrives, masked against the
agent's injected credentials *before* it is written, and memory keeps only a bounded head and a tail
that is the real end of the output. `tool_max_output_bytes` (100MB) is now a cap on that file: past it
the command keeps running, the file says where it stopped, and the tail keeps moving. The spill then
names the file rather than writing a second copy. The runner also drains a pipe past its cap instead
of closing it, which had killed long builds with SIGPIPE partway through.

**Smaller by kind first (0.8.17, TOKEN_SAVINGS §3.3).** Before the spill, a result loses what no model reads:
colour and cursor codes, a line redrawn with carriage returns down to its last state, three or more identical lines
that are not blank as one marked `[× N]`, and the spaces between a JSON text's tokens (by walking it, so numbers stay
as written). A diff keeps its lines, and a tool whose result is a file's lines (`Tool.verbatim`: `read`,
`memory_read`) is never touched, since an edit is made by the exact text read. A result made at least 256 characters
smaller keeps its whole text in the conversation's spill folder first (`keepCleared`), and ends with one line naming
it; when that write fails, nothing is taken out (`llm/output-by-kind.ts`).

**A batch gets shares, not a head and a tail.** `ToolContext.resultChars` tells a tool how much of its
result will be shown. `web_fetch(urls)` gives each page an equal share and says which ones it cut;
`read(paths)` stops at that figure and names the files it did not read. Cut head-and-tail instead, the
files or pages in the middle would disappear from the excerpt while the model believed it had them.

The budget is `min(12k, budget/4)` tokens with a 2k floor, derived per turn from the real window rather
than configured as a byte count: the same 6MB log is survivable at a million tokens and fatal at
thirty-two thousand. The 12k is counted as the provider counts — a dense log carries fewer characters
under it once a call has reported what the provider counts per estimated token (see Token counting). The prompt used to *ask* the model to do this itself — advice it had to remember
before seeing how big the output was, on the one call where forgetting is expensive. The `LARGE OUTPUT`
harness section now describes what already happened instead.

**`preserve_recent_tool_results` is a preference, not a guarantee.**
Keeping the newest results whole is right — they are what the model is still working from — but `keepRecent × the per-result cap` can exceed the whole budget on a small window.
So `trimToolResults` trims the older results first, then shortens the text old `write` and `edit` calls carried, and only if the set still does not fit squeezes the protected ones oldest-first, as far as the line and no further.
Nothing changes in the ordinary case.
When the last resort fires it is logged as a warning naming the model, the budget and both knobs, because it is a statement about the configuration rather than about that turn.

**The three budgets, and how each is bounded:**

| | Bound |
|---|---|
| Context window | `[llm] context_window` in the pack, else what the agent's gateway states for the model in its `/models` listing (G2, `llm/catalog.ts` — read from the last listing, asked hourly, never waited for), else a pattern table, else 32k **and a warning** |
| System prompt | Half the usable window; sections dropped in `TRIM_ORDER` past that |
| One tool result | `min(12k, budget/4)` tokens as the provider counts them, with a 2k floor, spilled to disk past that |

**Group context (`[agents] group_context_messages`, default 20):**

In a group, an agent is only handed the message that addressed it. Everything else in the room is
dropped at routing, so "@nouva ini" arrived pointing at an exchange the agent had no record of and was
answered with a question about what "ini" meant — live, on both Discord and WhatsApp.

So the daemon keeps a per-room ring buffer of recent messages and replays the ones the agent has not
seen in front of the question when it is finally addressed. What this is *not* is a call back to the
platform for history: the Telegram Bot API cannot fetch a message a bot did not receive, so a
history-reading implementation would have been Discord-only while looking uniform. Every adapter
already emits everything in a channel; this buffer is what routing was throwing away.

- **Unaddressed chatter still triggers nothing.** It is remembered, not answered.
- **Captured before the access gate**, deliberately. In `pair` mode `admit` drops everyone the operator
  has not approved — in an ordinary group, everyone — so a buffer filled after it would hold nothing.
  Overhearing is not obeying: an unpaired sender still cannot start a turn, reach a tool or draw a
  reply. If a room's chatter should not reach a model at all, `group_context_messages = 0` is the
  setting that says so.
- **One number for the daemon, overridable per connection** — the same shape as
  `groups_require_mention`. The daemon-wide value is the one an operator reaches for, so it gets the
  daemon-wide control (Agent Settings, beside the pairing switch); a connection's override lives on that
  connection's form and says what it is overriding. Both are live: the pipeline reads the limit off the
  config object on every message, so a dashboard edit applies to the next message with no restart.
- **Keyed by `platform:chat_id`** — the room, not the connection. Six bots in one Discord channel are
  six deliveries of one message; it is stored once and every agent there reads the same buffer.
- **In memory, not in SQLite.** It is minutes of small talk that rebuilds itself as people keep typing.
  A restart loses the window; the next few messages restore it.
- **Replayed into the user message, never the system prompt**, so the cached prompt prefix (§6.3)
  still matches, and one flat block rather than replayed `user` turns, so whole-turn truncation has
  nothing to cut between.
- **One budget for the block, spent newest-first.** ~6k characters total, not a cap on each line. The
  per-line version bounded the wrong thing: at 400 characters a chatter message was never truncated
  (nobody types that much in a channel) while an agent's answer always was — so the one message worth
  replaying in full, because reviewing it is why the next agent was tagged, was the only one guaranteed
  to arrive as a stub. And the block's real size was `window × cap`, so raising the cap multiplied the
  worst case by twenty. Now the newest message arrives whole, older ones are cut, and the ones that did
  not fit at all are *counted in the header* — a model that cannot tell a quiet room from a trimmed one
  answers as if it had the whole conversation.
- **Never replayed twice.** The block is stored with the message that carried it, and the next window
  starts after that message. Anything the turn already carries — the tag itself, a quoted message it
  replied to — is left out.
- **Telegram needs privacy mode disabled** in @BotFather (`/setprivacy` → Disable), or the bot made a
  group admin. Otherwise the Bot API never delivers an unaddressed group message and the buffer stays
  empty, which reads as the feature being broken rather than unconfigured.

**Thread-scoped sessions (Discord/Telegram):**
- Discord threads: separate session per thread, parent channel gets its own session
- Telegram topic groups: separate session per topic
- Session binding: `sessions` table UNIQUE on `(agent_id, chat_id, gateway)` where `chat_id` includes thread/topic ID

### 6.5 Streaming & Typing Indicators

**Streaming response from LLM:**

```toml
[llm.streaming]
enabled = true                     # stream from the provider; the reply is still sent whole
typing_indicator = true            # platform typing indicator for the whole turn
progress_in_chat = true            # one progress message, edited as the turn works
```

**Flow:**
1. User sends message → immediately send typing indicator to gateway
2. Start LLM streaming request (`stream: true` in API call)
3. Accumulate streamed tokens in buffer
4. On final response:
   - If text-only (no tool calls): send complete message to gateway
   - If tool calls present: execute them and re-submit; with `progress_in_chat`, the first tool posts one progress message that is then edited as the turn works (throttled, so it re-notifies nobody), and a turn that calls no tool posts none; the text a step returns beside its tool calls is sent to the chat at once as its own message before the tools run — the turn's first such line always, a later one only two minutes after the last one sent — and never again in the final reply (`pipeline/preamble.ts`; chat turns only, not a system event). A coding CLI's words between its steps are each a message of their own, sent as written whatever the gap, and each closes the progress message so far (`✓ n steps`) so the steps after start one below (0.8.5)
5. Refresh typing indicator every 5s for the whole turn, tool calls included

**Platform-specific streaming behavior:**
- **Discord:** Send typing indicator every 5s (auto-expires after 10s). Final message sent once complete. For very long responses (>2000 chars), split into sequential messages.
- **Telegram:** `sendChatAction("typing")` every 5s. Final message sent complete.
- **WhatsApp:** Composing presence. Final message sent complete. No progress message to edit: one closing line says what the turn did.

**Why not live-edit the answer?** Aggressive message editing creates flicker and hits rate limits. Better UX: typing indicator → complete message.
Only the progress message is edited, never the answer.
There is no config surface reserved for live editing the answer; whoever implements it adds the key alongside it.

### 6.6 Supported LLM Providers

- **OpenAI-compatible** — any endpoint that speaks OpenAI chat completions format (GPT-4o, OpenRouter, Nougate proxy, self-hosted, etc.)
- **Anthropic** — native Claude Messages API (`/v1/messages`)

No OAuth-based provider integrations. A profile is `kind` + `base_url` + `api_key`, where `api_key` is the *name* of a secret (§17.1). Users bring their own keys or point to their own proxy (e.g., Nougate, which the router editions run in the daemon's own process).

---

## 7. Tool Execution & Sandbox

### 7.1 Execution Model

Tools run via `Bun.spawn()` with:

- **No shell by default** — command + args array, never `shell: true`.
  A command that uses shell syntax (a pipe, a redirect, quotes) runs under the system's `bash -lc` — never a `bash` an agent installed — and the gate classifies what is inside it (§17.4).
- **Explicit env** — only allowlisted environment variables passed: `PATH`, `HOME`, the locale, the toolchain settings below, and the secrets the agent's `[security] exec_secrets` names. `SSH_AUTH_SOCK` only for an agent whose pack says `[security] ssh_agent = true` — its commands, sessions, scheduled commands and stdio MCP servers (since 0.7.10, S11; before it, every command of every agent held a socket that signs with every key the ssh-agent holds)
- **Timeout** — `[security] tool_timeout_ms` (default 30s) in the foreground, at most 4 minutes; a longer command runs as a background job instead (§7.2). A background job has none unless `[security] job_max_ms` is set (since 0.7.6; `0` by default, at most 2147483647): one still running after it — a service excepted — is stopped like a `kill`, recorded `killed`, and its agent woken to say it did not finish
- **Resource limits** — output streams to disk, capped at `tool_max_output_bytes` (100MB); `[security.exec] max_memory_mb` and `max_cpu_seconds` set `prlimit` ceilings on Linux — for a background job as well since 0.7.3, except that a service is not given the CPU-seconds one: it is a total, and a server spends it by running. A job's log is masked against the agent's injected credentials as it is written, as `exec`'s spill file is
- **Working directory** — scoped to agent workspace
- **Its agent's own user** (0.8.0) — on a Linux host with the helper `install.sh` sets up, every command an agent runs —
  `exec`, a background job, `session`, a scheduled command — runs as `nr-<agent>`, through `nouride-run`
  (`packages/isolation`). It reaches `workspace/shared/`, its own `workspace/private/<agent>/` (its HOME), its declared
  roots, its pack and its own job logs, attachments and long tool output to read — and nothing of another agent's or of
  `data/`. The credentials directory is read by the agents in `nr-creds`: every agent unless its pack says
  `[security] credentials = false`. `[security.exec] landlock` adds Landlock where the kernel has it. The daemon's own
  CLI, run for an agent by the `nouride` tool, stays the daemon's. A stdio MCP server an agent uses runs as its user
  too (0.8.1; before it, the daemon's, and a shell or file server read what the daemon reads), with its HOME and
  installs, in its own folder unless the server's block names a `cwd` — a folder its user may enter. What a command
  starts with `&` and leaves running is read by the helper — as `nobody` once the command has ended — until it closes
  its output, as the daemon reads one of its own commands leave (0.8.6: the helper stopped reading at the command's
  end, and the next line such a server printed killed it). In a container,
  on macOS, or without the helper, commands and servers run as the daemon's user; boot and `nouride doctor` say which,
  and why.

**Where installs land.** Where HOME is the agents' own (a service unit or the container image), boot points every installer at `.nouride/` through the settings each one already reads (`modules/toolchain/env.ts`):
`npm i -g`, `bun add -g`, `pipx install`, `uv tool install`, `go install` and `cargo install` put their programs in `.nouride/bin`, with what is more than one file under `.nouride/opt`, so no install needs root or a flag.
`pip install` lands in one Python environment every agent shares, `.nouride/opt/python`, which still sees the system's own packages; it is built at boot and rebuilt when the system's Python changes.
Every command — `exec`, background jobs, `session`, scheduled commands — gets one `PATH`: `.nouride/bin`, then the shared Python env, then the system's directories, then `~/.local/bin` and `~/.cargo/bin` last, so nothing there can shadow a system program.
HOME is `.nouride/home`, and persists.
Where each agent is its own user (0.8.0), the shared `bin/`, `lib/`, `opt/` and Python env are every agent's to run and
only the daemon's to change — an agent could otherwise put a program there for another agent, or the daemon, to run.
What an agent installs lands in its own HOME instead, by the same settings: `~/.local/bin` (its `$NOURIDE_BIN`) and
`~/.local/opt`, first on its PATH, with the shared directories behind them; `pip install` goes into its own Python env,
`~/.local/opt/python`, made at boot with no pip of its own — the shared env's packages, pip among them, stay importable
through a `.pth`. Its HOME is its private folder, seeded once with a copy of the shared HOME's logins and settings —
not its caches — and its `~/.ssh/config` and `known_hosts`. What every agent runs — the shared directories and the
programs in the shared HOME (`claude`, Rust's toolchains through `RUSTUP_HOME`) — stays on its PATH, and is the
orchestrator's to install and update: `nouride tools run -- <installer …>`, as the daemon's user, through the `nouride`
tool, which offers it to the orchestrator alone and only while its pack does not say `[security] shared_tools = false`.
It runs an installer and nothing else — npm or bun with `-g`, pipx, `uv tool`, pip, cargo, `go install`, rustup,
`claude update` — and refuses a flag that would put what it installs elsewhere or read a file, and a path in any word
(`toolchain/installers.ts`). Every approval level asks it (`shared-tools`, §17.4).
The prompt names what is already installed, and `nouride doctor` lists it, warning about a link into a cache, a broken link, or a program that hides a system one such as `git` or `python3`.

### 7.2 Built-in Tools

The Approval column is each tool's own default.
What actually asks is decided by the pack's `[tools] approval_required`, the approval level, and for `exec` by `[security.exec]` (§7.3, §17.4).
A pack that names no tools gets the read-only default set: `read`, `glob`, `grep`, `plan`, `delegate`, `ask_agent`, `web_fetch`, `web_search`, the four `memory_*` tools, `person_record`, `person_notes`, `send_file`, `send_message`, `session_status` and `nouride`.

| Tool | Description | Approval |
|---|---|---|
| `exec` | Run a command. `background: true` (or an obviously long command) runs it as a job and the agent is told when it ends; `keep_working` lets the turn carry on beside it; `service: true` is for a server that runs until stopped. A follower — `tail -f`, `journalctl -f`, `docker`/`kubectl`/`nouride logs -f`, `watch` — is refused in the background unless it is a service, with the snapshot to take instead (`exec-follow.ts`) | ✅ Required |
| `session` | Run a program with its input kept open — a password prompt, a REPL, anything needing a terminal | ✅ Required |
| `nouride` | The daemon's own CLI, with `argv[0]` fixed to this install's binary | ✅ Required — forwards to `exec`'s decision |
| `read` | Read text files, one or several per call, with offset and limit. A PNG, JPEG, GIF or WebP is shown as a picture under `[media]`: `native` puts it in front of the model, `described` asks the image model, `off` says it was not read; over `max_image_bytes` it is refused with how to make a smaller copy | Auto |
| `glob` · `grep` | Find files by name, and lines by content, across the workspace | Auto |
| `write` | Write/create file — overwriting one is refused unless it was read first | ✅ Required |
| `edit` · `multi_edit` | One exact-string replacement, or several applied atomically to one file | ✅ Required |
| `plan` | Track a multi-step plan (`task_plan` until 0.7.16; a pack that still names it does not load since 0.8.0): one step active, a skipped one with its reason; kept with a task in the work notes while steps are left (§6.4) | Auto |
| `notes` | The agent's work notes for this conversation: `write` or `remove` one task, `view` all (§6.4). Offered by the daemon to every agent with a tool, never to a helper or a peer | Auto |
| `secret_save` | Keep a credential sent in chat under a name in the secret store, by its handle — the value never passes through the model. Comes with `exec` | ✅ Required at the agent's level; replacing a stored one always asks |
| `web_search` | Search web | Auto |
| `web_search` (`kind: "image"`) | Image search, returning direct image URLs. Needs Brave or SearXNG; refuses on the keyless fallback rather than substituting a web search | ❌ Not required |
| `web_fetch` | Fetch URL content. HTML is reduced to Markdown by default, with the page's `<head>` metadata as YAML frontmatter and every URL made absolute; `format: "html"` returns the markup untouched, for selectors and embedded JSON, and `format: "text"` gives flat prose. See [§7.5](#75-reading-a-web-page-web_fetch-output) | Auto |
| `memory_read` | Re-read the agent's own `MEMORY.md`, open a past conversation by id, or read back an archived stretch of this one (§12) | Auto |
| `memory_write` | Write the agent's own `MEMORY.md`, or keep one fact about the person speaking (§12.1) | Auto |
| `memory_search` | Search the conversations and facts this chat may see — by words, and by meaning where `[memory.semantic]` is on (§12.3) | Auto |
| `memory_analyze` | Counts over the conversations this chat may see: top tags or people, when something came up, trends per day / week / month, weekdays, importance. No model call | Auto |
| `person_record` | Write the speaker's name and a one-line note into their person (`people/<key>.toml`) | ❌ Not required — it records an identity, and identity is never permission |
| `person_notes` | Read and change the speaker's own notes in their person (`people/<key>.toml`), a line at a time — what does not change about them. Never anybody else's, whoever asks | ❌ Not required — what somebody says about themselves, into their own entry; it grants nothing |
| `send_file` | Send a file into the conversation as a real attachment — from the workspace, or fetched from a URL through the SSRF guard | ❌ Not required — it discloses nothing `read` does not, to nobody `read` would not already reach |
| `send_message` | Send a message into another chat this agent knows — `to` is a person's key or name (their one-to-one), a group's name, or an address `gateway:chat`; one it cannot resolve lists the chats it can reach (0.7.23). Through the agent's own connections only: one it owns, or one with no owner where it already has a conversation — never another agent's bot, never the chat it is in. Once the platform took it, it is appended to the agent's conversation in that chat after a `[system]` line saying where it came from, so the next turn there has it; a scheduled job's output delivered into a chat is recorded the same way. Audited by where it went and its length, not its words. Comes with `send_file`; withheld from helpers | ✅ Required — its own gate asks at the agent's approval level, never as a standing grant |
| `attachment_read` | Open a file that is **in this conversation**, by ref: an image goes to the vision model (with an optional question), a text file comes back whole. Called with no ref it lists what is there. Reaches files another agent sent and files in messages that addressed nobody — see [§7.6](#76-reading-a-file-that-is-in-the-conversation-attachment_read). Offered wherever the daemon keeps the index, whatever the pack lists | ❌ Not required — a file that arrives *with* a message is already described to the agent with no tool entry consulted, so this changes when a file is read, not whether |
| `delegate` | Hand up to four briefs to blank helpers: in parallel and waited for, or with `background: true` each a job of its own whose result wakes the agent when it finishes (§13). `tier` picks which of the agent's models they run on — `small`, `default` (unsaid) or `high` (§20) | Auto — every tool a helper calls is gated as in the parent's turn |
| `ask_agent` | Hand a task to another agent behind the chat (§4.3). Waits for the answer up to 45 seconds, then lets the peer carry on in the background and its answer wake the agent; `background: true` returns at once (§13.4). `asks` takes up to four agents in one call, at work at the same time, every answer in one result (§13.4). `tier` picks which of the other agent's models answers (§20). Offered only when there is another agent to ask | Auto — the peer is gated against its own permissions |
| `session_status` | Show current session/model info | Auto |
| `update` | Check for a newer release, or install it (§17.4: installing is `replace`) | Auto to check |
| `agent_create` · `agent_configure` | Create a new agent pack, or change this agent's own provider and model | ✅ Required |
| `skill_create` · `skill_toggle` | Write a new skill into the pool (on for this agent, checked like a draft), or switch one on or off for this agent | ✅ Required |
| `skill_improve` | Propose a correction to a skill — raises a draft, changes nothing (§12.4) | Auto |
| `skill_search` · `skill_install` | Find a skill on a public hub, and queue it as a draft for a person to approve | Auto |
| `mcp_search` | Find an MCP server in Nouverse's MCP catalog, a mirror of the official registry (0.7.19), and give the person the dashboard link that adds it — never add one | Auto |

**Skills come from three scopes.** `shared` (`agents/skills/`, the pool every agent draws from), `builtin` (what ships with the daemon), and `project` (`<root>/.agents/skills/` for each directory in `[workspace] skill_roots`). The first two are **on for every agent unless switched off** in `agents/<id>/skills.toml`, a map of `skill-name = true|false` where absent means on — default-on because an opt-in list cannot name a skill that does not exist yet, so every skill added later would arrive switched off with nothing to say why. A pack has no skills directory of its own: a procedure worked out once should be visible to every agent rather than re-derived per pack. Project skills are re-scanned each turn against file size and mtime, so editing one takes effect on the next message with no reload — the other two load once, because a pool is config-as-code an operator reloads deliberately while a project's `.agents/` is edited while working. All of them are read-only to the agent, and a pooled skill of the same name wins: a skill is instructions in the system prompt, so letting a repository override one would make a pull request a way to replace an agent's instructions. Roots are named explicitly rather than discovered for the same reason. A skill may declare `requires:` — host software its procedure needs — which is probed against `PATH` and reported by the Skills Workshop, `nouride skills` and `nouride doctor`, and gates nothing.

**The agent knows who is speaking.** People are one file each, `people/<key>.toml` beside `config.toml` (since 0.8.18; `[[people]]` in `config.toml` before, kept there for the way back and moved again when an older version changes it), found by the `key` — unique, set once, the name of their memory profile — mapping the accounts they send from (`ids`, each `<platform>:<senderId>`: the account, whichever of our connections it writes to; an id written with the connection in the middle, as before 0.7.0, is refused at load since 0.8.0, naming the id without it) to a name and optional notes, and the match is rendered into the prompt for DMs as well as group chats — a household talks to its agent in DMs, and that was the one surface telling the agent nothing. One person holds every account they use (WhatsApp LID, WhatsApp Phone JID, Telegram ID, Discord ID), and may hold none yet: somebody added by name is attached to their accounts when they pair (Access, "Approve as"). An entry written without a key is given one from its name; one from before 0.7.0 that names its first account `id` is refused at load since 0.8.0, naming `ids`. Identity is the **id**, never the display name: `sender_access` records platform names as untrusted because anyone can rename themselves, and matching on one here would undo that in the place it matters. An unmatched sender is described to the agent as unverified, in visibly different words, so a rename cannot read as an identity. The agent fills this in itself: `person_record` is a first-class tool rather than a suggestion to run the CLI, because it competes with `memory_write` for the same instinct and prose loses — an agent told in the prompt to record a name, holding both, wrote it to `MEMORY.md`, where the identity line never looks. This is identification, not authorisation — every sender still gets the same toolset. Different capabilities per person are expressed by giving them different agents, routed by `[channels]` on the same gateway.

**Credentials never reach the model.** Value-shaped ones (API keys, tokens) are named per agent in `[security] exec_secrets` and resolved into the child process environment at the moment a command runs — each into the commands it is bound to and no others (`[security.exec_secrets] pypi_token = ["twine upload"]`, S6). Every part of a command line has to be bound, read with the reader the allowlist uses (`@nouride/policy` `secretsFor`), so `twine upload && curl …` gets nothing; a command handed a bound secret asks at every approval level but `trusted` (class `credential-out`), and its grant key carries the secret names and the digest of every script it runs (`modules/tools/exec-secrets.ts`). A secret bound to `"*"` reaches every command, an interactive session included, without asking; the old list form, which meant that, is refused since 0.8.0 and that agent does not load. Output is masked with all of them; the audit row names the ones a command got. File-shaped ones (service-account JSON, OAuth caches) live in `[security] credentials_dir`, which is deliberately not a workspace root — `read`, `glob` and `grep` cannot reach it, and only a command can, through `$NOURIDE_CREDENTIALS_DIR`. Reading a credential file through `exec` is a sensitive path (§17.4); a script that opens the file itself is not. The threat is the context window rather than the filesystem: a credential in a conversation is in the provider request log, the session on disk, and whatever the model says next.

**Credentials sent in chat are taken out on arrival (0.7.17).** `arrive` runs every message — and every edit and quote — through `findSecrets` (`@nouride/secrets`: one registry of shapes — vendor formats, and a key that names a secret, `=` or `:`, then a value that is one; a password a sentence names without either is not guessed at) before the room's record, the inbox, a steer or a turn: what matches is held in memory under a handle, `$TMP_SECRET_` and twelve hex digits, for that conversation, an hour from when it was last sent, and the handle takes its place in everything the daemon stores, shows or sends (`pipeline/chat-secrets.ts`). The sender is told by the daemon, with `/secret undo` for what was not a secret. A command that names a handle is handed the value in its environment and masked of it; once a turn has read outside content, the first command to use one asks at every approval level but `trusted` (the secret guard, `tools/held-secrets.ts`; its switch, `[security] secret_guard`, went into the levels in 0.8.0). `secret_save` keeps one under a name, and it and `/secret set` hand it to every command of that chat's agent — `[security.exec_secrets] <name> = ["*"]` in its pack, unless the pack already names it; replacing a stored one is on the fixed list (`secret`, §17.4). And what leaves the daemon — every model request, every text it embeds, every line a chat is sent — is masked of every value the secret store and the handles hold, by exact value (`commons/egress.ts`).

**What the file tools may reach.** An agent's own pack and its `[workspace] roots`, read and write.
For an agent with a shell, `read`, `glob` and `grep` also open its HOME and `.nouride/bin`, `lib` and `opt` by path, read-only; a search with no path skips them, and a path outside every root is refused with the way that works.
A credential file — a `.env`, `.npmrc`, `.netrc`, a cloud or coding CLI's login, a private key — is read with its secret values hidden: which keys are set and how the file is laid out, never the values.
Nouride's own — the secret store, the control token, the credentials directory — are not read at all.
`send_file` refuses a credential file, and any text file holding the value of one of the agent's own secrets, because a file on a chat platform cannot be masked.
Since 0.7.17 a command meets the same: one that reads a credential file has its values masked out of what it prints (`valuesForCommand`); a `git add`, `commit` or `push` that would carry one is refused at every level (`tools/git-guard.ts`); and one that sends one off the machine asks, under the secret guard (`tools/credential-send.ts`). A command — or a line typed into a session — that names the secret store, a copy of it, or the control token is refused at every level, before the policy is asked (`ownSecretNamed`); what the store, the control token and the files of the credentials directory hold is masked out of every tool's result, whole, as it is out of what leaves the daemon (`ownSecretValues`, `tools/secret-mask.ts`). A plain address under a key named for one (`token_uri`) is not taken for a secret.
No file tool writes the agent's own pack `config.toml` or the daemon's, at any approval level: tools, roots and approvals are the operator's to change.
`exec` refuses a write into this install's own files — the `nouride` binary, the dashboard, the shipped skills — and the refusal names the way that works: `nouride update`, or a copy of the skill in the pool or the agent's own pack.

### 7.3 Approval Gate (Human-in-the-Loop)

When a tool requires approval:

1. Agent pauses execution
2. Sends approval request to the originating chat with:
   - Tool name
   - Full command/parameters (never truncated)
   - How to answer: `/approve` (`/approve always` to stop being asked for that exact command) or `/deny`, typed in the chat; the dashboard and `nouride approvals` answer the same queue
3. Waits for human response (`[security] approval_timeout_ms`, default 5 minutes)
4. On approve → execute and continue
5. On deny → inform LLM the tool was denied, let it adapt
6. On timeout → deny by default, notify user

**How much asks is a level, not a switch:** `careful` asks whatever `[security.exec]` says; `balanced` (the default) asks only for the classes that change or remove something (§17.4); `trusted` asks nothing but four classes every level asks: `unwatched` (work nobody watches sending somewhere its job did not name, 0.8.0), `shared-tools` (`nouride tools run`, a program installed for every agent, 0.8.1), `persona` (an agent's own persona, 0.8.8) and `people` (who People says a person is, 0.8.9).
Until 0.7.23 the three were called `normal`, `risky` and `none`; 0.8.0 refuses the old names everywhere, `config.toml` and a pack included, like any other unknown level.
An agent's `[agent] approvals` wins when it sets one; otherwise the person's own `/approvals` level, else `[security] approvals`.
`trusted` cannot be set from a chat — only from the dashboard or `config.toml`.
When nobody can be asked — no chat connected, no dashboard open — the level answers on its own: at `trusted` the call runs but for those two classes, and what the level does not cover is refused.

```typescript
interface ApprovalRequest {
  id: string;
  agentId: string;
  tool: string;
  params: Record<string, unknown>;
  chatId: string;
  gateway: string;
  requestedAt: number;
  timeoutMs: number;
  status: "pending" | "approved" | "denied" | "expired";
}
```

**One question at a time in a chat** (`tools/approval-floor.ts`): a chat is shown one prompt; the next waits behind it and is posted once it settles, its window starting then. The chat is the one the prompt goes to — a mission's questions go to the chat it began in, and wait in that chat's one line with the chat's own turn's, in the order they were asked (0.8.7; before, a mission's waited in a line of its own and the chat's own went past them). The prompt on screen says how many wait behind it, rewritten in place, its buttons kept, as each is asked or answered elsewhere; a bare `/approve` there answers the one it shows, a mission's included. Every pending request is answerable from the dashboard and `nouride approvals` at once; `GET /approvals` marks the ones not yet asked in their chat `queued: true`, and the dashboard's card says "Not in the chat yet".

**Approval persistence:** Stored in SQLite (`approvals`). A request still pending when the daemon stops is kept (D8, `tools/approvals-kept.ts`), however it stopped: its row stays pending, and who asked, the turn and the grant `allow-always` writes are on that row as JSON from the moment it is asked (`extras_json`, 0.8.18). Until 0.8.17 they were handed over in `data/approvals-kept.json` at a clean shutdown only, so a crash lost them; 0.8.18 reads that file once at its first start, moves what it holds onto the rows and removes it, and 1.0.0 drops that reader. The next boot asks the request again — said to be from before the restart — for what is left of its window, when that is half a minute or more, and otherwise expires it and tells its chat in words. The same call asked again in that conversation — the turn the restart takes up, told its question is still open — waits on the open question instead of asking twice, and an answer that arrives with nobody waiting is the answer to that call once, within the window, besides waking the agent. `/reset` and a deleted conversation still expire them.

---

### 7.4 MCP Client Support

Nouride acts as an **MCP host** — it can connect to external MCP servers and expose their tools to agents.

```toml
# agents/mcp.toml — the install's library, one block per server
[[servers]]
name = "nouva-mcp"
transport = "stdio"                    # stdio | sse | streamable-http
command = "python3"
args = ["/path/to/nouva-mcp/server.py"]
env = { NOTES_DIR = "/srv/notes" }

[[servers]]
name = "deploy-mcp"
transport = "streamable-http"
url = "http://localhost:8090/mcp"
auth_secret = "deploy_mcp_token"       # a secret NAME; sent as a bearer token

# agents/<id>/mcp.toml — the servers this agent uses; one not switched on here is off
[servers.nouva-mcp]
on = true
```

A server is added once, to the library (`nouride mcp add`, or the dashboard's MCP page), and switched on per agent (0.7.19).
A pack's own `[[mcp_servers]]`, the form before that, is refused since 0.8.0: that agent does not load, and the message names the library.

**MCP tool integration:**
1. On agent load → connect to configured MCP servers
2. Discover available tools via MCP `tools/list`
3. Merge MCP tools into agent's tool definitions (prefixed: `mcpserver__toolname`)
4. Tool calls routed to MCP server, results returned to LLM
5. MCP server lifecycle managed per-agent: connected at boot, reconnected when the pack is reloaded, closed at shutdown

`packages/mcp` is the protocol, the client and the stdio and HTTP transports — and, in `packages/mcp/src/oauth`, the
OAuth client a remote server that asks for a login is logged in to through (MCP 2025-06-18 Authorization: discovery,
client registration, PKCE, the token exchange and its refresh); `apps/engine/src/modules/tools/mcp.ts` is the engine's
half: naming, gating, untrusted marking, and `apps/engine/src/modules/mcp-oauth` the logins. Notes on what the list
above leaves open:

- **A login is detected, not configured** (0.7.19). A remote server with no `auth_secret` and no `Authorization` header
  is tried with no credential; one that answers 401 waits for a login ("needs login", its challenge kept for the
  discovery the login starts from). Connect on the MCP page, or `nouride mcp login`, runs the OAuth flow — PKCE, Dynamic
  Client Registration or a client id given by hand, the RFC 8707 resource — with the browser sent back to
  `/dashboard/oauth/mcp/callback` at `[dashboard] public_url`, or on this machine's loopback, and the address it landed
  on accepted pasted back. A login started by one admin is finished only by the same one, within ten minutes, once. The
  server's block then gets `auth = "oauth"` (refused beside `auth_secret` or an `Authorization` header, and on stdio);
  the access and refresh tokens are secrets, `mcp-oauth-<agent>-<server>-access` and `-refresh` (a confidential
  client's secret `-client`), and the rest is in `mcp_oauth` (`069_baseline.sql`). Tokens renew ahead of expiry and on
  a 401, each new pair written in one write before it is used; a refresh the server refuses puts the server back to
  "needs login", tells the operator once through `[alerts]`, and an agent's call to its tools fails saying a person must
  log in again, and where. No route answers with a token, a code or a verifier.
- **Credentials stay out of the file.** `headers` refuses a value that looks like a token; an HTTP
  server's token is a secret named by `auth_secret` (`auth_header` when it is not `Authorization`), and a stdio
  server's is a variable named in `env_secrets` (0.7.19), resolved when the server starts.
- **Declaring a server is the opt-in.** MCP tools are merged into the toolset without appearing in
  `[tools] enabled`, because their names come from the server and are not knowable when the pack is
  written.
- **They run unless the pack says to ask**, like a built-in nobody named: an MCP tool asks only when
  `[tools] approval_required` lists it by its full name (`<server>__<tool>`). `allow-always` then writes
  a grant scoped to that tool on that server.
- **Descriptions and results are marked untrusted**, following the `web_fetch` convention — both are
  instruction-shaped text written by somebody who is not the operator.
- **Every call is written down** (0.7.4, S10): a `tool_exec` row under the qualified name, with the arguments
  as the audit log keeps them and the turn's id — the same wrapper a built-in runs in (`tools/audited.ts`), so a
  call reaches the turn's event stream too. Before, only built-ins were recorded.
- **Never in a built-in's place.** A qualified name that is a built-in's is not offered, and is said once in the
  log: a server's `read` would replace the one that keeps to the agent's roots. `<server>__<tool>` makes the
  collision unlikely; this makes it impossible.
- **An image in a result reaches the model.** It is saved under the agent's scratchpad
  (`tool-images/`) and shown the way `read` shows a picture — numbered in the text (`[image 1]`) where
  it stood, and by its path, so the agent can `read` it again once a later request has left it out.
- **A server that will not start is never fatal.** Its tools are absent, everything else runs.
- **Servers connect at once**, every agent's, four handshakes at a time. Boot waits at most 10 s for one;
  a slower handshake keeps going and the server's tools join when it is ready, unless a reload or a
  shutdown came first, in which case it is closed.
- **A call is the turn's.** It carries the turn's signal: `/stop`, the deadline and a shutdown release it at
  once, and the server is sent `notifications/cancelled` with the request's id rather than left to work for
  an answer nobody will read. A request that times out is cancelled the same way (`initialize` excepted, which
  a client may not cancel).
- **The protocol is MCP 2025-06-18** (since 0.7.13; 2024-11-05 before it). A server that answers 2025-03-26 or
  2024-11-05 is spoken to in that version — nothing Nouride uses differs between the three; any other answer, or
  none, is refused with the server's name and both versions, and its tools are not offered. Over HTTP the version
  settled on goes out as `MCP-Protocol-Version` on every request after `initialize`. Nouride declares no client
  capability — it offers no roots, sampling or elicitation, and a server that asks for one is refused (`-32601`);
  a server's `ping` is answered. `tools/list` is read to its last page.
- **A server's tools can change while it runs.** A server that declared `tools.listChanged` and sends
  `notifications/tools/list_changed` has its tools listed again — once for a burst — into the agent's slot, and
  the log says what was added, removed and changed (`mcp server's tools changed`). A turn already running keeps
  the tools it started with; the next turn has the new list. Over Streamable HTTP such a server can only say so
  on its GET stream, so the stream is opened for it and for no other server: reopened when it ends, resuming with
  `Last-Event-ID`, and never asked for again after a 405. A 404 for the session, on the stream or on a call, is
  the session gone, and the server is reconnected as one that dropped is.
- **A call is held to the tool's schema before it is sent:** every `required` argument there, and each declared
  property's top-level `type` (string, number, integer, boolean, array, object, null) — nothing deeper, no
  `$ref`, `anyOf`, formats or nested schemas, which stay the server's to judge. A call that fails is answered to
  the model with each problem named, before anyone is asked to approve it and with nothing sent to the server.
- **A result is read as 2025-06-18 shapes it.** Text content is what the model reads; `structuredContent` with
  no text beside it is written out as JSON; a `resource_link` is a line with its address
  (`[resource link: main.rs] file:///project/src/main.rs (text/x-rust) — …`); `isError` makes the call a failed
  one, as before.
- **A result is held to the tool's `outputSchema`, when it declared one** — by the same two rules as a call's
  arguments. A result whose `structuredContent` misses a required field, has a field of the wrong type, is not an
  object, or is absent (the spec says a server that declares the schema MUST return conforming data) reaches the
  model as an error naming each problem, and its data does not; the log says so at warn with the server and the
  tool. A result the tool marked `isError` is not held to it, and a tool with no `outputSchema` is unchanged.
- **The child gets a minimal environment**, not the daemon's: an MCP server is third-party code, and
  handing it every credential this process holds is not a decision anyone would make deliberately. Where each agent
  is its own user (§7.1), it runs as its agent's, with that agent's HOME and installs; its block's `env` and `cwd`
  still win.

MCP resources and prompts are not exposed; only tools are.

**Security:**
- A stdio MCP server runs with a minimal environment, not the daemon's
- MCP tool calls respect the agent's approval gate configuration
- MCP server output treated as untrusted (same as tool output)

Nouride is also an MCP **server**, for other tools such as Claude Code or an editor: `[mcp_server] enabled` serves this install's memory and personas at `/mcp` to tokens made with `nouride mcp-server token create` (§12.3). It answers `initialize` in the version the client asks for when it speaks it — 2025-06-18, 2025-03-26 or 2024-11-05 — and in 2025-06-18 otherwise (until 0.7.13 it echoed whatever was asked); a request whose `MCP-Protocol-Version` names a version it does not speak is refused with 400.

### 7.5 Reading a Web Page (`web_fetch` output)

A modern page is mostly not the page.
Navigation, cookie banners, sidebars, footers and script bodies were 92–99% of the bytes across the four real pages this was measured against, so a document truncated at the 200KB fetch cap could be three quarters boilerplate — the answer cut off to make room for a menu.
`web_fetch` therefore reduces HTML rather than returning it, and the `format` parameter chooses how.

| `format` | What it is | Reach for it when |
|---|---|---|
| `markdown` (default) | Frontmatter, then the article as Markdown: headings, lists, links, code blocks and tables. Furniture and `<script>` bodies are gone | Reading a page |
| `html` | The response untouched, byte for byte | Writing a scraper (class and id attributes), or reading a tag the frontmatter does not carry — an arbitrary `<meta>`, a `<link rel>`, `__NEXT_DATA__`, `ld+json` |
| `text` | The same prose with the Markdown syntax stripped and no frontmatter | Feeding a page to something that counts words |

An unrecognised `format` is an error naming the three, never a silent fallback to Markdown.
An agent that asks for markup, quietly receives prose and finds no `<meta>` tags will report that as a fact about the page.
A response that is not HTML — JSON, plain text, CSV — comes back as it arrived in every format, because `format` says how to reduce *markup* and a body with none has nothing to answer for.
Truncation at the byte cap is stated in the content for the same reason: it used to cut silently, and under `html` the cut lands mid-tag.

**The frontmatter.**
`<head>` is where a document says what it is, and the reduction used to discard it wholesale — so every question about who wrote a page, when, and what it calls itself needed a second fetch as `html` and 70KB of markup read to recover six values.
The tags worth reading now come back as a YAML block above the body, in the one format every model already reads without being told.

| Field | Read from |
|---|---|
| `title` | `<title>`, then `og:title`, `twitter:title` |
| `description` | `description`, then `og:description`, `twitter:description` |
| `site_name` | `og:site_name`, `application-name` |
| `author` | `author`, then `article:author`, `og:article:author`, `citation_author` |
| `published` · `modified` | `article:published_time` and friends, `article:modified_time`, `og:updated_time` |
| `type` | `og:type`, omitted when it is the default `website` |
| `image` | `og:image` and its variants, then `twitter:image` — the social card |
| `images` | Up to eight images the article itself shows, absolute and deduplicated, walked with the furniture rules applied |
| `canonical` | `<link rel="canonical">`, then `og:url` |
| `feeds` | `<link rel="alternate">` whose `type` is RSS, Atom or JSON Feed — at most four |
| `sitemap` | `<link rel="sitemap">`, or the `Sitemap:` line in the host's `robots.txt` |
| `keywords` | `keywords`, `article:tag`, `news_keywords` — at most twelve |
| `lang` | `<html lang>`, then `og:locale` |

`feeds` and `sitemap` answer a different question from the rest of the block: not what this page says, but how to follow the site it belongs to.
They are emitted as a block sequence of flow mappings, one line per feed, because a bare URL cannot tell the site feed from the comments feed:

```yaml
feeds:
  - { type: "atom", url: "https://simonwillison.net/atom/everything/" }
  - { type: "rss", title: "Comments Feed", url: "https://example.com/comments/feed" }
```

A `title` is carried only when it says something the `type` does not — `title="Atom"` beside `type: "atom"` is a word paid for twice.
`rel="alternate"` alone is never enough: it is also how a page declares its translations, its AMP copy and its print stylesheet, so the media type decides.
`application/json` is deliberately not accepted, because an alternate JSON representation of a page is an API response as often as it is a feed, and a wrong entry is worse than a missing one — the agent will fetch it.

The sitemap is the one field that can come from a second HTTP request.
`<link rel="sitemap">` is valid and almost nobody writes it; sites publish the answer in `robots.txt`, so `web_fetch` reads that **once per host** for the life of the process and every page of the site carries the result afterwards.
Per fetch would double the request count of a research loop reading twenty articles from one blog; only for the front page — the first version of this — answers nothing for `https://gading.dev/en/`, where a localised site's front page is one path segment down.
The lookup is one request with no redirect walk, accepts only `200`, and reads a bounded prefix; anything else is silence rather than a field.
A guessed `/sitemap.xml` is never reported: it would hand the agent a URL that 404s, which is a wrong answer wearing the shape of a finding.
`<link rel="sitemap">` in the document wins over `robots.txt` when both exist.

`images` is not `image`.
The social card is chosen to look right in a link preview and on most sites is the same house image on every page; the article's own diagrams are the thing an agent asked to explain or carry a figure needs.
The card is excluded from `images` when the body shows it too, so one URL never occupies two lines.

Everything else in `<head>` — `viewport`, `theme-color`, `robots`, preload hints, favicon links — is bytes the model has to skip that answer nothing about the content, and stays behind `format: "html"`.
So does JSON-LD: `ld+json` is richer and often more accurate, and it is also an arbitrarily deep object of unbounded size, so flattening it means either a schema-by-schema mapping or dumping JSON back into the budget the reduction exists to protect.

`format: "text"` gets no frontmatter, because a `---` block is exactly the syntax that format exists to remove.

**Every value in the block was written by whoever owns the page**, which decides three rules.
Newlines and control characters are collapsed to spaces, so a `content` attribute cannot close the block and forge fields underneath it.
Every value is emitted as a quoted scalar with `\` and `"` escaped, including the ones that look like they need no quotes — unquoted, `published: 2026-08-01` is a date object and `lang: no` is the boolean false.
Every field is length-capped, because a 40KB description is a denial of the budget rather than a description.
The whole result still carries the untrusted-content marker (§17.1); the frontmatter sits inside it.

**Every URL in the output is absolute.**
A browser resolves `/docs/limits` against the address bar and nobody notices; a model reading Markdown has no address bar, so a relative href is a string it cannot open, cannot ask about, and cannot tell apart from a working one.
Links and images are resolved against the URL of the **last redirect hop** — the only base a relative href in that document is correct against, and the requested URL would name a path on a host that redirected away.
Four rules fall out of the same place:

- **An `<img>` is read from `data-src`, `data-original` and `srcset` as well as `src`.** A lazy-loading page ships `src=""` and keeps the real URL elsewhere, so reading only `src` reports a page full of diagrams as a page with no images.
- **An image proxied through a resizer is unwrapped to the original.** `/_next/image?url=…` is a link to a resizing endpoint on the site being read: it works today, says nothing about where the image lives, and dies with the deployment. Judged by shape — a `url` parameter whose value is itself an absolute http(s) URL — so Next.js, Vercel, Netlify and Cloudflare are one rule rather than four branches.
- **A blur-up placeholder is not a second copy of the picture.** A low-resolution copy painted first, as an `<img>` sibling with the same non-empty `alt`, is dropped in favour of the last of the repeated alts. Judged structurally rather than by class name: on the page that found this, the *real* image is `class="lazy-image lazy-image-blur"`, so a rule matching `blur` would delete the picture and keep the thumbnail.
- **A declared 1×1 is analytics, not a picture**, and appears in neither the body nor `images`.

Link text is flattened to one line.
A card on a blog index is `<a>` around a `<div>` and an `<h2>`, and rendered literally that is `[![alt](img)` … `## Title](url)`, which Markdown does not read as a link at all — the brackets become characters and the URL attaches to nothing.

**What it costs.**
A fully populated frontmatter block is roughly 428 characters, about 107 estimated tokens, against pages that routinely cost thousands and a second fetch that costs the whole page again.
The tool definition is 306 estimated tokens and its harness prompt line 113, so the feature is about 55 tokens per request, paid uncached on every request of every tool iteration.
Token figures here are `estimateTokens` output — estimates, not provider counts ([CONTRIBUTING.md](./CONTRIBUTING.md) invariant 4: never invent a number, flag every estimate).

### 7.6 Reading a File That Is in the Conversation (`attachment_read`)

A file used to be readable by exactly one agent, once, at the moment it arrived.
`AttachmentIntake` fetched what came with a message, a vision model described it, and the description entered *that* agent's history.
Everything else about the file was gone.

Three consequences, all observed in a dashboard room with several agents in it:

- **A file another agent sent was invisible.** The others overheard the sentence and not the attachment, so asked to look at a photo one of them had just sent, an agent answered — correctly — that it only receives a text transcript of the conversation.
- **A file in an untagged message had no reader at all.** Nothing was addressed, so nothing fetched it, and by the time somebody was tagged the platform handle was the only trace left.
- **A file could not be re-read.** The description was written at intake, answering a question nobody had asked yet.

**The fix is an index, not a second copy of the bytes.** `chat_attachments` records what is in a conversation and how to get it: `local_path` when some agent has a durable copy, and the platform handle when not.
A room's lookup key is the **chat**, not the connection — a platform hands every bot in a channel its own copy of every message, so six connections onto one room must collapse to one row.
A one-to-one chat's key is the chat *and* its connection: on Telegram and WhatsApp a DM's chat id is the person's own id, so two of our bots in a DM with the same person are two conversations under one chat id, and keyed on the chat alone the second agent was offered, and could open, what the person had sent the first (#12).
The `ref` is derived from the message id, the conversation and the position (`messageAttachmentRefs`), which is what makes the room's collapse possible and what lets one file be reachable by one name from every agent in the room — and namespaced by the connection wherever the connection numbers the id (a DM, a Telegram basic group), because two bots' message 5 is not one message.

**Reading is on demand, and nothing is announced.**
An image costs a model call, and most files are never asked about; describing every image for every member of a six-agent room is six calls per photo spent on the chance somebody asks.
So the file that came *with* the message being answered is still described automatically — sending a screenshot with a question *is* the instruction, and making "what does this error say?" cost a tool iteration to discover the screenshot exists would be worse.
Every other file waits to be asked for, and the prompt says nothing about it.

That last part was got wrong twice before it was got right, and both attempts are worth recording.
The first described the conversation's files in every prompt — a list with refs and a sentence inviting the agent to open a relevant one — which is not "read it when I tell you to", and it did what the wording invited: reported from a phone, an agent's first act after a `/reset` was `attachment_read` on a screenshot from a previous conversation, because `lastAddressedAt` answers 0 for a cleared history and 0 as a lower bound means the beginning of time.
The second bounded that window to fifteen minutes, which made it rarer rather than right.

The prompt now carries nothing about files at all.
`attachment_read` called with no arguments lists what is in the conversation, its own description says so, and that is the entire mechanism: somebody asks, the agent looks.
It costs no tokens on any turn and cannot fire unasked.

**What it may open is a ref, never a path.**
The chat is checked inside the lookup rather than after it, so a ref carried in from another room finds nothing at all.
Bytes are materialised into the *reading* agent's own conversation directory, on the connection that saw the file first — a Telegram `file_id` is scoped to the bot it was issued to, so the caller's own connection is only the fallback.
Everything returned is wrapped as retrieved content, for the reason `web_fetch` output is: text written inside a screenshot is attacker-supplied text on its way into a prompt.

Both the index and the bytes are swept on `[retention] session_days`, with the transcript that mentions them.
They were not: files had their own `[attachments] retention_days`, seven days against a thirty-day transcript, so a conversation went on mentioning a screenshot for another twenty-three days after the screenshot was deleted — the ref resolved to nothing and the tool answered "no local copy and no way to fetch it again" about a file the conversation was visibly about.
On the live box the numbers were 7 against 30, so it happened weekly.
A file is part of what was said, so it lives as long as the saying; the knob is gone, and `merge.ts` tells anyone who had set it where the decision went.
A read still verifies the path and re-fetches rather than trusting it, because a platform copy can vanish for reasons retention has nothing to do with.

---

## 8. Cron System

Scheduled work: reminders, recurring checks, daily reports, and commands that run without a model.

The scheduler lives in the daemon rather than in a system timer, and the reason is what a job needs rather than what it does.
A timer can run a script.
It cannot reach a Telegram chat, run against an agent's own conversation history, or record a run where the operator is already looking.

### 8.1 Job Schema

```typescript
interface Job {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;

  trigger: JobTrigger;         // stored in the `schedule` column
  webhookToken?: string;       // a webhook job's URL secret: POST /hooks/<token>
  payload: JobPayload;
  delivery: JobDelivery;
  target: JobTarget;           // the conversation the job is about
  session: "fresh" | "isolated" | "chat"; // whose history the turn runs against
  keepAfterRun: boolean;

  createdBy: string;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  failCount: number;
  failStreak: number;           // since the last success; drives the auto-disable backstop
  disabledReason?: string;      // set when the daemon disabled the job itself
}

type JobTrigger =
  | { kind: "at"; at: number }                      // one-shot, epoch milliseconds
  | { kind: "every"; everyMs: number }              // interval, measured from the end of the last run
  | { kind: "cron"; expr: string; tz?: string }     // 5-field expression, IANA zone
  | { kind: "webhook" }                             // runs when its URL is called, not on a clock
  | { kind: "manual" };                             // runs when a person starts it: never due

type JobPayload =
  | { kind: "systemEvent"; text: string }                       // delivered as-is, no model call
  | { kind: "agentTurn"; message: string; model?: string }      // a full turn with tools
  | { kind: "command"; argv: string[]; cwd?: string; timeoutMs?: number;
      then: "deliver" | "agentTurn" }                           // a host command, no model call
  | { kind: "mission"; goal: string; checks?: string[]; review?: string | false }
  | { kind: "steps"; steps: JobStep[] };                        // several, in a fixed order (8.3.1)

// A step is one of the above less what the list decides for it, or a wait for a person. Each has an id, an optional
// name, and three exits: where the run goes when it is done, failed, or had nothing to say.
type StepGo = "next" | "end" | { to: string };                  // `to`: the id of a LATER step
type JobStep = { id: string; name?: string; then?: StepGo; whenFailed?: StepGo; whenEmpty?: StepGo } & (
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; model?: string; agentId?: string }
  | { kind: "command"; argv: string[]; cwd?: string; timeoutMs?: number }
  | { kind: "mission"; goal: string; checks?: string[]; review?: string | false; agentId?: string }
  | { kind: "approval"; ask: string; timeoutMs?: number }
);

interface JobTarget {
  gatewayId: string;   // the gateway INSTANCE (`discord:main`), never the platform
  chatId: string;
}

interface JobDelivery {
  mode: "announce" | "none" | "webhook";
  gatewayId?: string;  // both, or neither: an override names a whole conversation
  chatId?: string;
  webhookUrl?: string;
}
```

### 8.2 Three questions, kept apart

A job's location is three separate facts, and merging any two of them produces a wrong delivery the first time somebody wants them to differ.

| Field | Question | Notes |
|---|---|---|
| `target` | Which conversation is this job *about*? | A `(gatewayId, chatId)` pair — the address the whole engine already uses. A Discord channel, a WhatsApp group and a Telegram topic are all just a `chatId`. |
| `session` | Whose history does the turn run against? | `"fresh"` (**default**) reads nothing and writes nothing — a daily report gains nothing from remembering yesterday's, it only pays to send it and pays again to summarize it. `"isolated"` runs against `cron:<jobId>` on the same gateway: a private history kept across runs, never in the human transcript, and subject to the same rollover policy as any conversation. `"chat"` reads *and appends to* the target conversation — contamination both ways, so choose it for a job that is genuinely part of the discussion. Only `"chat"` may use the fire-and-forget dispatch path, because the pipeline replies into the conversation the message came from. |
| `delivery` | Where does the output go? | The target by default. An override sends elsewhere — "watch this conversation, report to the ops channel". A `webhook` is POSTed behind the same SSRF guard as `web_fetch`, to the address the guard judged, and a redirect is refused with where it pointed rather than followed (`cron/webhook.ts`, since 0.7.10) — `fetch` used to follow one past the guard and turn the POST into a GET without its body. |

`gatewayId` is the instance id, not the platform name.
Sessions, bindings and outbound messages are all keyed by instance, so a platform name would pick an arbitrary bot as soon as a second one is configured — and pick it silently.

### 8.3 Payloads, and what each one costs

| Payload | Provider calls | Use it for |
|---|---|---|
| `systemEvent` | none | Reminders. Works while the model is down. |
| `command` with `then: "deliver"` | none | A probe whose output speaks for itself. A run that prints nothing sends nothing. |
| `command` with `then: "agentTurn"` | one, when it printed something | A probe whose output needs interpreting — the facts are already in hand when the turn starts. A run that prints nothing runs no turn and sends nothing (0.8.17): a check that prints only when something is wrong costs nothing while all is well. |
| `agentTurn` | one turn, up to `max_tool_iterations` | Work whose answer is not known in advance. |
| `mission` | the mission's turns, and a reviewer's | Long work, checked: each run is a mission started as whoever turned the job on, reporting to its chat, ending at the reviewer; one at a time (0.8.0). |

#### 8.3.1 A list of steps

A job's work may be a list (`steps`, at most 20): the scheduler runs the steps in order, each handed what the one before said as text, and an agent runs only the step it is given. The last step's words are the run's, delivered as the job says; a message step is sent as it runs, and a mission tells its chat itself. A job of steps never runs on the chat's history. A webhook's body is read by the first agent or mission step, and every later turn is marked as having read outside content.

- **Exits.** Each step says where the run goes when it is done (`then`), failed (`whenFailed`) and had nothing to say (`whenEmpty`): the next step, the end, or a later step by id. Forward only, refused at save otherwise, so a run always ends and there is no loop. Left unsaid a step behaves as a job of that one kind: done goes on, failed ends the run as failed and is reported, nothing to say ends it quietly. A failed step that goes on hands its failure to the step it goes to.
- **A mission as a step**, at any place: the run waits for the mission to end and hands its result on. A mission that failed or was stopped is a failed step.
- **A wait for a person** (`approval`): asked where the job reports, with Continue and Stop where the connection has buttons, and on the dashboard (Waiting for you, and the automation's page). In a one-to-one chat the person in it answers; in a room whoever turned the job on, or an admin; on the dashboard an operator or an admin. A yes hands on what the step before said. A no, or no answer within `timeoutMs` (a day unless set, five minutes to seven days), is the step's failed exit: by default the run ends there as skipped, not failed, and nothing is reported as a failure. No model is asked while it waits.
- **A run that waits is a row, not a process.** Its status is `waiting`, with where it stands (`cron_runs.state`): the step, what the step before said, a webhook body no step has read, and what it waits for. A mission's end, an answer from a chat or the dashboard, its time running out, and a boot each find it there, so a restart loses nothing; at boot a run whose mission ended meanwhile goes on, and one whose mission is gone fails that step. While a run of a job waits the job starts no other: it has no next time until that run settles it, and Run now says what it waits for. Each step's outcome is written to the run as the step begins and ends, so a run at work can be read.
- An agent proposes a list through `schedule` as it proposes any job, each step written as a job of one kind is (`text`, `command`, `prompt`, `mission`, `ask`), with exits by step number; the card says each step and where the run goes from it. Nothing an agent wrote runs until a person turns it on.

A `command` payload runs argv on the daemon host with no model and **no approval gate** — nothing inspects it when it fires.
An agent proposes scheduled work and never makes it (0.8.0): the `schedule` tool writes the job whole, kept off, and posts a card in the chat — what it does, when, where it reports — that a person turns on (a press, `/schedule on <id>`, or the dashboard), by the rule approvals keep for who may answer. The `nouride` tool refuses `cron add|update|enable` and `webhook add|rotate` and points there. Reached any other way, the CLI is still on the fixed list: `nouride cron add … --command` is classified as the command it schedules, and otherwise as `unattended` (§17.4), asked under `careful` — and under `balanced` when the command is one `balanced` asks — and never a standing grant.
An operator's own terminal never passes through the gate and is unaffected.
An agent that wants a script run on a schedule can still schedule an `agentTurn` and call `exec` inside it, where the gate sees it at the moment it runs.

### 8.4 Scheduler

- One timer, set for the soonest `nextRunAt` (read from a partial index on `enabled = 1`) and set again whenever a write moves a job's next run — create, update, enable, delete, settle. A job fires at its own time, and an idle daemon does not wake to ask; it sleeps a minute at most, so a wall clock that jumps — a Pi has no RTC — is noticed within that (`[cron] tick_interval_ms` until 0.8.0, a fixed value since). It used to be a one-second ticker, sixty wake-ups a minute for a schedule whose floor is a minute.
- A due job is **claimed** — `nextRunAt` cleared in the same conditional statement that checks it — before anything runs, so a tick that overruns its interval cannot start the same job twice.
- An `agentTurn` run holds a slot under `[queue] max_concurrent_turns` — the same ceiling as chat turns, waited for when all are taken, and handed the next free one ahead of the queue so a busy room cannot starve it. A `session = "chat"` run delivered quietly or to a webhook, due while its agent is in a turn in that chat, is not started over that turn: it is recorded `skipped` (`agent busy: …`), and the next occurrence comes as usual — a one-shot does not run. One that announces in the chat is sent there as a message and waits behind the turn, and a `fresh` or `isolated` run shares nothing with it.
- `nextRunAt` moves forward in exactly one place, on every path a run can end: success, failure, skip, interruption. A schedule advanced in the success path and forgotten in the error path is a job that never runs again and never says so.
- Cron expressions follow Vixie's rule: when both day-of-month and day-of-week are restricted, the job fires when **either** matches. `0 9 15 * 1` is "09:00 on the 15th, or any Monday" — roughly five times a month, not once.
- An expression that can never match (`0 0 30 2 *`) is refused at creation, along with an unparseable one, an unknown timezone, and an interval under `min_interval_ms`.

### 8.5 Coming back after downtime

Anything overdue by less than `catchup_window_ms` is still due, and the first tick fires it.

Past the window:

- A **recurring** job is moved to its next occurrence with no run recorded. Nothing happened, and a run row saying otherwise would be a lie in the one place the operator checks.
- A **one-shot** is recorded as `skipped` and disabled. It cannot be moved on, and deleting it silently would mean the operator never learns the reminder did not happen.

Runs left `running` by the last shutdown are reconciled to `interrupted` at boot, before the first tick; a run a shutdown stopped at a step boundary is recorded `interrupted` too. Neither is a failure: no report goes to the chat, and the fail streak does not move.
The job such a run belonged to keeps running: a recurring one is given its next time from now, and a one-shot — which may have partly run — is disabled with the reason `daemon restart`, for `nouride cron run` to retry.

### 8.6 Failure handling

A failed run is delivered into the job's chat unless `delivery.mode` is `"none"` — an unattended failure that only reaches the log is a failure nobody finds out about.

After `[cron] fail_streak_limit` consecutive failures the job disables itself with `disabledReason: "consecutive-failures"`.
One success resets the streak.
`nouride cron enable <id>` clears both the reason and the streak, so a re-enabled job does not disable itself again on the next failure.

Skipped and interrupted runs do not count: a nightly job should not disable itself because the daemon was off overnight ten times.

### 8.7 Approvals with nobody watching

`[cron] unattended_approval` decides what a scheduled turn does when a tool needs approval.

- `"auto"` — the turn is at `balanced`: the gate's other questions are answered yes, and the decision is audited against the job. **What `balanced` still asks is refused outright**, immediately (§17.4). This is a real escalation of what a schedule can do, and it is the honest default — a job that stops at a prompt nobody will ever see has not run.

  Refused rather than asked, and that changed after it ran live. The first design sent the prompt to the target chat on the reasoning that a dangerous command at 3am should wake somebody. But an isolated job's chat id is `cron:<jobId>`, which no platform can deliver to, so the prompt went nowhere and the turn held its slot for the full `approval_timeout_ms` before failing anyway — observed at **281 seconds** for a single `rm -rf`. "Nobody is watching" is the definition of the turn, not a state worth waiting out.
- `"deny"` — anything needing approval is refused with a reason the model can report.

Either way `exec` still meets the blocked lists first.

### 8.8 Interfaces

| | Creates | Can create `command` payloads | Can target another conversation |
|---|---|---|---|
| `nouride cron` CLI (`nouride webhook` for webhook jobs) | An operator, or an agent through the gate | Yes — hardline for an agent | Yes |
| `POST /api/control/cron` | An operator or the dashboard | Yes | Yes |
| Dashboard `/automations` | An operator; a webhook, an admin | Yes | Yes |

### 8.9 Use Cases

- **Reminders:** "Remind me to check the deploy in 2 hours" → a one-shot `at` job with a `systemEvent` payload, which deletes itself after firing.
- **Recurring checks:** "Check server health every 6 hours" → an `every` job with a `command` payload and `then: "deliver"`.
- **Scheduled reports:** "Send a standup summary at 9am WIB" → a `cron` job with `tz = "Asia/Jakarta"` and `session: "fresh"`, so the daily runs neither fill the chat's context nor accumulate one of their own.

---

## 9. Hooks System

### 9.1 Built-in Commands

| Command | Description | Hook |
|---|---|---|
| `/new` | Start new conversation | File the conversation so far into memory (§12.2), then clear context; an external agent's CLI session for the chat is let go, so the next message opens a new one with the skills on now |
| `/reset` | Hard reset agent state | `/new`, plus clear the work notes, expire this agent's pending approvals, drop a `/model` override, wake it if asleep, reload config |
| `/notes` | The chat's work notes | Show them; `/notes clear` empties them. `/new` keeps them |
| `/sleep` | Put the agent to sleep (0.8.0) | It takes no work from anywhere until `/wake`; a turn it is in stops at its next step, its background jobs run on and report when it wakes, its missions wait |
| `/wake` | Wake the agent | Take work again |
| `/stop` | Stop what it is doing | `/sleep`, and cancel the turn in flight in this chat and the helpers and asks it has working in the background from here |
| `/start` | Wake the agent | As `/wake` |
| `/status` | Show agent status | Display model, uptime, session info and what the conversation has cost |
| `/model` | Switch LLM model | Change model for current session; kept on its row across a restart, as `/effort`'s level is (0.8.18), until `default`, `/reset` or a rollover drops it |
| `/effort` | How long the model thinks | This chat's level over `[llm] effort`: set on a coding CLI's session where its CLI offers it (0.8.16); sent with each request of an agent its own model answers (0.8.17), where a model that refuses it is asked again without and the chat is told once, under the answer. `default` drops it. `<level> lock` writes it as the agent's own `[llm] effort`, for every chat and mission (an admin's, as the Model tab's write); `lock` alone locks this chat's, `unlock` takes the agent's own away (0.8.17) |
| `/approve` | Approve pending tool | Approve tool execution request; `/approve always` makes it a standing grant where that is allowed |
| `/deny` | Deny pending tool | Deny tool execution request |
| `/approvals` | How much is asked | Show the level in force and who set it; `/approvals careful` or `balanced` sets the speaker's own (§7.3) |
| `/grants` | Standing permissions | List them, or revoke one or all: `/grants revoke <id>`, `/grants revoke all` |
| `/agents` | List agents | Show all registered agents and status |
| `/btw` | A side question (0.8.17) | Answered beside the work by a turn of its own on the agent's model, with the conversation and the running turn's last steps (cut to a budget), the tools that only read, five rounds and a minute; one at a time per chat. Marked `btw:` in the chat, kept as a `note` record that memory skips; neither the running turn nor the next one sees it |
| `/compact` | Summarize the conversation | Run the summary pass now (§6.4), keeping the recent turns verbatim |
| `/prompt` | Show the system prompt | The operator's own blocks in full, Nouride's elided (§6.3) |
| `/reload` | Hot-reload agent config | Reload persona files + config.toml without restart |
| `/drafts` | Decide on a proposed skill | List, read, approve or discard what the reflection loop drafted (§12.4) |
| `/secret` | Credentials sent in chat | What this chat holds (handles, never values); `undo` puts the sender's last message back as written, as an edit of itself, within 15 minutes; `set` / `replace <name> <value>` keeps a value under a name. Keeping a value is an admin's, as for `/daemon-restart`. The secret guard has no switch since 0.8.0: it asks at every level but `trusted` (§17.4) |
| `/mention` | A group's mention rule | Show this group's `groups_require_mention` and where it comes from (the group, the connection, the daemon, or for a room made in the dashboard the room's own rule, which the daemon's does not reach); `off` / `on` set the group's own, `default` removes it. Stored per platform chat, so every bot in the group reads one value; answered once per group, addressed or not. Changing it is an admin's, as for `/daemon-restart`; refused in a DM |
| `/daemon-restart` | Restart the daemon | Once nothing is running, or at once with `now`; the chat is told when it is back. Only an admin: paired or on an allowlist, and under People the same person as an admin's dashboard account (Telegram's menu spells it `/daemon_restart`) |
| `/help` | Show available commands | List commands |
| `/commands` | Publish the command menu | Sync these commands to the platform's own menu |

A slash command is answered at once by the harness, with no model call, and outside the conversation's queue — so `/approve` and `/stop` reach a turn that is blocked or busy (§10.1).
`/auto`, the old name of `/approvals`, is gone since 0.8.0: like any word after a slash that is not a command, it reaches the agent as a message.

`/drafts` deliberately does **not** reuse `/approve`. That verb belongs to the tool gate, where it
means something with a five-minute fuse attached to a turn that is blocked right now; a draft blocks
nothing and never expires. Overloading it would make the most consequential command in the daemon
ambiguous at the moment somebody is typing it quickly on a phone.

Subcommands: bare lists the queue, `show <name>` reads one, `approve <name>` writes it into the pool
for every agent, `deny <name>` deletes it. A draft is addressable by skill name as well as by id.

### 9.2 Hook Lifecycle

```typescript
interface Hook {
  command: string;           // e.g. "/new"
  description: string;
  worksWhilePaused?: boolean; // `/start` must, `/new` must not
  hidden?: boolean;          // a renamed command: still answers, not listed
  handler: (ctx: HookContext) => Promise<HookResult>;
}

interface HookContext {
  agent: LoadedAgent;
  envelope: MessageEnvelope;
  gatewayId: string;
  chatId: string;
  senderId: string;
  args: string[];           // Arguments after command
  deps: HookDeps;           // the stores and registries a command acts on
}

interface HookResult {
  handled: boolean;
  reply?: string;           // Text reply to user
}
```

A command acts directly on the stores it is handed; there is no action list to interpret.

### 9.3 Custom Hooks

There are none: the commands are the built-in ones in §9.1, defined in `apps/engine/src/modules/hooks/builtins/`.
Work that should run on a word is a skill the agent follows, or a webhook job (§8).

### 9.4 `/new` and `/reset` Edge Cases

**`/new` (New Conversation):**
1. Cut the conversation so far into memory's episodes (§12.2), so it is remembered now rather than at tonight's pass
2. Clear conversation context/history for the agent in this chat, its progress feed, and its spilled tool output
3. Preserve agent memory (MEMORY.md untouched)
4. Preserve cron jobs
5. Reply with confirmation: "New conversation started. Cleared T turns, M messages, ~N tokens." (tokens are the context estimate)
6. Edge cases:
   - If no messages in current conversation → no-op, reply "Already fresh — nothing to clear."
   - If memory cannot be written → still clear context; the turn log still has it, and tonight's pass files it
   - Concurrent `/new` from multiple chats → each chat has independent context, no conflict

**`/reset` (Hard Reset):**
1. Cut the conversation into memory, as `/new` does
2. Clear conversation context/history
3. Clear session-level state: this agent's pending approvals are expired, a `/model` override is dropped
4. **Do NOT clear:** MEMORY.md, SOUL.md, skills, cron jobs, config, or a person's `/approvals` level
5. Reload agent config from disk (pick up any manual edits)
6. Reply with confirmation: "Reset. Context cleared (T turns, M messages, ~N tokens), config reloaded." — or "Context was already empty"
7. Edge cases:
   - If the agent is asleep (`/sleep`, `/stop`) → reset AND wake it
   - If the reload fails → the reset still happens, and the reply says why the config did not load

**A rollover and a delete** end a conversation too, and all four go through one function, `endConversation` (`pipeline/conversation-end.ts`), whose table says what each clears. A rollover clears what `/new` does except the room's notices, and drops a `/model` override; it files nothing itself, since memory is cut from the turn log the clear leaves alone. Deleting a conversation from the dashboard stops its turn, deletes its record and its rows in the event stream, its progress feed, its spilled output and its `/model` override, and expires the approvals it was waiting on; what it cost, what memory filed from it, and a room's own transcript stay (`ON_CONVERSATION_DELETE` in `db/keys.ts`).

**`/sleep`, `/stop`, `/wake` and `/start`:**
1. `/sleep` → the agent is asleep; `/stop` → asleep, and the turn in flight in this chat cancelled with its background work there
2. `/wake` or `/start` → awake, taking messages again
3. Edge cases:
   - A message to an asleep agent is not answered; in a room, the timeline says the agent did not see it
   - Asleep lasts until `/wake`, through a restart too: the marks are kept in the database, `daemon_state` (D15; `data/paused-agents.json` before 0.8.18). `nouride agent disable` is the one that changes the pack
   - `/wake` when not asleep → "I wasn't asleep."

---

## 10. Message Queue & Backpressure

### 10.1 Inbound Message Queue

When multiple messages arrive simultaneously for an agent, they must be processed safely:

```typescript
interface QueueConfig {
  max_concurrent_per_agent: number;    // Must be 1 — the loader refuses anything higher
  max_queue_depth: number;             // Default 20 messages per chat
  max_concurrent_turns: number;        // Turns running at once across ALL chats, default 8; 0 lifts it
  queue_timeout_ms: number;            // Drop queued messages after this, default 3600000 (1 hour)
  steer: boolean;                      // A message sent mid-turn is read at the turn's next step (a room: from its starter), default true
  steerReply: boolean;                 // Under the steering ack, one sentence in the agent's own words (pipeline/steer-reply.ts), default true
  steerReplyModel: string;             // That sentence's model on the agent's provider; "" = the agent's own
  steerReplyTimeoutMs: number;         // Past it the ack stands alone, default 15000
}
```

`max_concurrent_per_agent` is fixed at 1 rather than merely defaulted to it. Each turn saves the
conversation it loaded with its own messages after (§6.4), so two turns at once in the same chat both read
it and the slower one's save drops the other exchange, with nothing logged — messages being rows since
0.7.12 changes what a save writes, not what it saves. Parallelism across chats needs no setting.

`queue_timeout_ms` is matched to `max_turn_duration_ms`, not chosen independently: a message queued
behind a turn has to outlive that turn, or one slow reply costs the next message. The loader warns when
it is the shorter of the two.

**The inbox comes first.** A message is written to the `inbox` table after admission and before anything acts on it, keyed by the platform's own message id.
- A message the platform delivers twice — an update a dead process never confirmed — is recognised and answered once.
- A message sent more than 15 minutes ago by the platform's clock — a backlog after downtime — is not answered; the chat gets one short notice that it came in while the daemon was offline.
- At shutdown, what is still queued is not started: it stays in the inbox and is answered after the restart, when fresh (§14.2).
- Settled rows are kept two days, long enough to recognise a redelivery.

**Processing model:**
1. Messages arrive from gateway → enqueued per chat (`gatewayId:chatId`)
2. In a one-to-one chat, one turn at a time; in a room, each agent has its own conversation, so several agents may work at once — as many as the room has agents (its members, or every enabled agent where nothing lists them) and never more than half of `max_concurrent_turns`, so one busy room cannot hold every slot (`pipeline/fair-share.ts`) — an agent already working there says so rather than queuing a second turn
3. While a chat is busy → new messages queued (FIFO), unless the turn reads them as a steer (below)
4. If queue exceeds `max_queue_depth` → oldest queued messages dropped, chat notified
5. If queued message exceeds `queue_timeout_ms` → dropped, chat notified

   Both notices are throttled to one per chat per minute: the failure arrives in bursts, and one
   apology per dropped message would itself be the flood. A `duplicate` drop says nothing — it is the
   message the sender already sent — and neither does a `shutdown` drop, where the gateways are already
   closing.
6. Dedup: the same message id within a second → second copy ignored (`dedup_window_ms` until 0.8.0, a fixed value since)
7. Slash commands skip the queue: they run the moment they arrive, so `/approve` reaches the turn waiting on it (§9.1)

**Steering** (`[queue] steer`, on by default; `pipeline/steering.ts`). In a one-to-one chat on any gateway — the dashboard and the control API included — a message that arrives while a turn runs is read by that turn instead of queued behind it:
- Never mid-step. The running tool or model call finishes; the message goes in front of the model before its next call, after that round's tool results, as a user message beginning "[<name> sent this while you were working. Read it before your next step: it may add to, change or stop what you are doing. If it asks you something, answer it in your reply.]". The harness block tells the agent this can happen. A coding CLI that takes messages into its running prompt (`_session/steering`, 0.8.10) is handed them once no tool call is open and the line in the agent's own words (below) has been said, so it reads the two together.
- Acknowledged at once by the daemon: "↪ Got it, I'll read that before my next step." While the turn waits on an approval in that chat: "↪ Got it, I'll read that once the approval waiting here is answered: /approve or /deny." A "yes" typed as a message is not an approval answer. In a room the commands are left out — a bare `/approve` there may reach another agent — and the approval's own message says how to answer.
- Then a line in the agent's own words (`[queue] steer_reply`, on by default; `pipeline/steer-reply.ts`): one non-streaming call to the agent's own provider (`steer_reply_model`, else the agent's model), given the agent's IDENTITY and SOUL (cut at 4000 characters), the sender's People notes (1500), the turn's request, its last few steps, the message theirs replies to when the platform says (`quotedText`), and the message — none of the conversation — for one sentence about what it will do with it, told not to guess where the message is unclear on its own. The ack is rewritten into it ("↪ <line>") where the connection can edit a message, so a steered message gets one bubble; where it cannot, the line follows the ack. Said only if the turn has neither read the message nor answered by then; the line goes into the header of the steered message as a guess, not a promise ("A quick reply went to them in your name before you read this: … It was a guess at what they meant … Go by their words: if the guess misread them, say so and do what they actually asked."). The steered message itself reaches the turn with the message it replies to, quoted, as a turn's own question does. The call is aborted the moment the turn reads the message, answers or ends (`ActiveTurn.replyAbort`), and an answer past `steer_reply_timeout_ms` (15 s) is dropped even from a server that ignored the abort. One at a time per turn, none while an approval is waiting; a failure sends nothing more and is logged with why.
- Several before one step are read together, as one message. A turn reads at most 5; past that, messages queue as before, and in a one-to-one chat the sender is told once a turn that the message waits for the turn and is answered next ("⏳ <Name> is still working on … — this message waits for it, and is answered next.").
- Read only when another model call follows. A turn with no next step (writing its final answer) leaves what it did not read to start the next turn the moment it ends; after `/stop`, that meets the paused agent like any message; if the daemon goes down, the inbox still holds it and the restart answers it.
- What a turn read is journaled with it and settled in the inbox, so a later turn, or one taken up after a restart, has it, and nothing answers it twice. The turn's steps show `read a message sent while working: "…"`.
- Drawn on the running turn's record the moment it is taken (`pipeline/steer-accept.ts`), because the dashboard reads a conversation from there and the local connection hands a reply only to a request waiting for one: the message as a `steer` step (its address taken off), the ack and the agent's line as `steer_reply` steps. Said, not done: they are not counted as steps, and a step's wait is measured across them. A message the turn never reads is taken back off it when it becomes the next turn's question (`TurnStore.unstep`), so it is not drawn twice. So is one past the cap, drawn while it waits with the notice it was given (`ActiveTurn.waiting`). A message sent during a new conversation's first turn — before its session row is written, at the end of that turn — reaches that conversation through the turn's record (`web/control/conversation.ts`), rather than starting another one.
- Words only: a message with attachments, and a slash command, take the ordinary path.
- In a room, after routing — `whileBusy`, at the busy check of step 2, the first point a room message is known to be for this agent: the person who started the turn steers it the same way when the message addressed the agent (a mention, its name in front, or a reply to something it said). Anybody else who addressed it is told, once per person per turn, in a reply from the agent's bot (`busyNotice`): "⏳ <Name> is still working on "<request>" (<elapsed> so far) — ask again once it's done." The request is the turn's own, on one line of at most 80 characters, with every `@` and the platforms' mention markup removed so the router hands the notice to nobody; a turn the daemon started says only how long; ", and is waiting for an approval here" when one is; it never suggests `/stop`, which pauses the agent everywhere. An unaddressed message (a room with one bot routes everything said there to it), the daemon's own events and a second message from somebody already told are refused without a word, and every refusal is still the dashboard's `agent_busy` event. Another agent handing over never steers.
- An agent's hand-over to an agent at work there waits (`whileBusy` answers `wait`; `pipeline/at-work.ts`, 0.8.33): kept on the busy turn (`ActiveTurns.holdHandover`), one for each handing agent, a second from the same agent joined to the first as a burst of messages is one. The room is told once, in the busy agent's voice, with `busyNotice`'s other ending: "this message waits for it, and is answered next". When the turn ends, a peer's turn too, each one kept is that agent's next turn (`TurnContext.returned`), an agent's message still at its depth in the chain (`verdictOf`), so the hop budget goes on counting and a second wait holds it again without a second notice. It stays `queued` in the inbox while it waits (`holds`), so a restart answers it. One that waited longer than `[queue] queue_timeout_ms` is left, and the agent it was for says so in the room (`lapsedHandoverNotice`). A person's message is refused as above: one that waits behind a long turn is answered against a conversation that has moved on.
- A turn's message says what else is at work (`pipeline/work-now.ts`, 0.8.33), after the reminders and never in the cached prompt. In a room: each other agent of the chat (the OTHER AGENTS list) at work there, with the request it is on as `busyNotice` quotes it, for how long, and an approval it waits on; each one asleep; and that a tag to one at work waits. On the box: the turns running in other chats, the helpers and asks, the missions with their folder and the background commands with theirs, at most `WORK_SHOWN` (6) named, the reading agent's own first, the rest counted. What somebody asked (a request, a goal, a command line) is said only for work in this chat or begun by the person the turn answers (the same sender, or the same person in People); other work is named by its kind, its folder and its time. A turn no person began reads as nobody; a mission's turn reads as the person who started it. The turn's own work, its room's turns and its own jobs begun in this chat are not listed. Nothing is said when nothing else is at work.
- A message written from a dashboard page says which (`pageNote` in `pipeline/messages.ts`, 0.8.34): `POST /chat/send` takes an optional `page` (`path`, `title`, `subject`), which the chat that floats over the dashboard's pages sends and nothing else does, and the turn that answers the message reads one line after its reminders, `(Written from the dashboard, with this page open: Missions, "Move the shop", at /dashboard/missions/msn_1.)`. It is the browser's claim: each part is cut (the address at 200 characters, the name at 80, the subject at 120), put on one line, and has no tag or quote left in it. On the message, kept as it was sent, and never in the cached prompt. A message read by a turn at work (steering) carries the same line after its words. A body whose `page` is not one is sent without it.
- Work that stops in a room offers a way on (`pipeline/way-on.ts`, 0.8.33), as buttons where the connection carries them (`Gateway.buttons`) and in the line's words where it does not. A chain stopped at its hop budget: Continue under the notice delivers the hand-over that was stopped, as an agent's message with its count begun again. A turn in a room that an agent's hand-over began (its sender one of our bots) and that a failure or its deadline ended, where the daemon does not try again by itself: Continue (`carry-on:<turn>`, the press a long outage's question takes) has the same agent take it up, and Hand to, for up to `HAND_TO_SHOWN` (3) other agents of the room whose button data fits 64 bytes, gives the one picked what the other was asked, as the word of whoever pressed and through that agent's own connection. Whoever may write to the agent there may press (an admin, or a sender its allowlist takes); a turn a restart cut off keeps its rule. A pressed line is settled with who chose what, and its other button answers that it waits no more. What a button needs is kept in memory, at most 100 of each, so after a restart a press says it waits no more and the words still work.
- A room's steered message stays `queued` in the inbox until a turn reads it (`InboxDesk.track` asks `TurnContext.holds`), so a restart before then answers it.
- A message no turn read is its agent's next turn (`TurnContext.returned`): not routed or claimed again — a room's was, and a second pass would meet its own claim or answer it again for every agent it named — outside the queue's dedup, and not counted twice by the rate limit.
- `steer = false`: a message sent mid-turn queues for the turn, as before.
- **A coding CLI's turn** (0.8.10, `external-agents/steering.ts`): the message goes into the prompt it is running through `_session/steering` where the CLI's handshake offers it (`_meta.steering.supported`, which claude-agent-acp 0.95 and codex-acp 2.3 say), asked with `idleBehavior: "promptRequired"`. Held while one of the prompt's tool calls is open, five minutes at most (the owner's rule: a steer landing on a command moves it to the background in Claude's adapter), then sent. `injected` and `startedNewTurn` are taken into the turn; `promptRequired` and `failed` make it the next prompt, as before. A CLI that does not offer it reads it once its prompt ends, and the acknowledgement says so: "↪ Got it, I'll read that once what I'm running now ends."
- **A mission's `tell`** (0.8.10, `missions/tell.ts`): recorded on the mission first (`told`, migration 072), then put in front of its turn at work through the same buffer (`ActiveTurns.steerInto`), under its own header — "[<name> told this mission while you were working. Read it before your next step and follow it: … it wins over the details of the goal. The checks still decide when it is done …]" — and marked read in the turn it was handed to; kept for the next turn's page otherwise, and never requeued as a chat message. Shown on every later page and to the reviewer. Checks that pass with one unread: a mission a person accepts waits, with it shown; one that would end by itself goes one more turn to read it.

**Cross-chat parallelism:** Different chats for the same agent CAN process in parallel (separate context). A one-to-one chat is always sequential.

Bounded by `max_concurrent_turns`, because unbounded is a different thing: a handler here is a provider
call, so fifty active chats meant fifty at once — fifty times the spend per second and a rate limit hit
immediately. Over the ceiling, work waits in arrival order across keys (oldest first, so one busy chat
cannot starve the others) rather than being dropped. A turn's `delegate` helpers and `ask_agent` peers
count too (§13.1): they run on the turn's own slot, and on more only where the ceiling has room.

**Rate limiting per sender:**
```toml
[security.rate_limit]
messages_per_minute = 10               # Per sender, per gateway instance
cooldown_reply = "Please slow down."
```

### 10.2 LLM Call Budget & Rate Limiting

```toml
[llm.limits]
max_tokens_per_turn = 32000            # Max output tokens per LLM call
max_tool_iterations = 250              # Max tool call loops per user message
max_turn_duration_ms = 3600000         # Max time one reply may take
max_daily_cost_usd = 0                 # Daily cost cap (all agents combined); 0 = off
max_daily_tokens = 0                   # Daily token cap (all agents combined); 0 = off
cost_alert_threshold_pct = 80          # Warn at 80% of whichever cap is set
```

The stored conversation is capped by `[security] max_conversation_turns` (200), not here.

**Cost tracking:**
- Each model call records its token counts and estimated cost in `llm_usage`, through one seam (`llm/metered.ts`), with what it was for (`purpose`: the turn's own, a helper's, a peer's, a steering reply's, a compaction, a reflection, the nightly memory pass, an embedding, an image read, a clip transcribed — by its length, not invented tokens), how it is billed (`basis`: `list`, `included` for a subscription profile, `unpriced`) and whether its counts are the provider's or an estimate (`estimated`) — 0.7.10, `069_baseline.sql`
- And why it ended, as the provider said (`stop_reason`, 0.7.26 — `069_baseline.sql`): `stop`, `tool_calls`, `max_tokens` — a reply cut at the output limit, said even when it carried tool calls — or `error`; `NULL` when the provider gave no reason and on a call that is no generation, never a guessed `stop`. Every caller records it through the same seam: it rides on `TokenUsage` from the client, and `reportedCounts` carries it (`tests/contracts/usage-recorders.test.ts`)
- With the turn it was made for (`turn_id`, since 0.7.3 — `069_baseline.sql`), how long it took from the request leaving to its usage being read (`latency_ms`, retries and their waits included) and how many HTTP attempts it needed (`attempts`). A `delegate` helper's and an `ask_agent` peer's calls, and a steering reply's, carry the id of the turn that started them; the nightly pass and embeddings carry none
- And what each request carried (0.7.26, `llm/executor/context-line.ts`): before every model request of a turn — each round, each wrap-up — a line in the turn's record, never the request itself: about how many tokens (`estimatedTokens`, at the scale the provider last measured; the provider's own count is the call's `llm_usage` row), how many earlier tool results in it were cleared to make room and the files those newly cleared were kept at, whether a compaction's summary was in it, and whether the agent's notes were (`notes`, false until there are any). A `context` row of the stream, not a step, held until the turn's next row and written in its commit — a request costs a Box's card no write of its own. A waited-on helper's or peer's lines go into the turn that waits, marked `via`/`by`; a delegate's own turn keeps its own
- `audit_log.turn_id` names the turn of a `tool_exec` row (from `ToolContext.turnId`) and of an error logged during one; a log line written in a turn has `turn_id` beside `agent_id`. `nouride turns show <id>` reads all of it in one place (`turns/inspection.store.ts`): the record and its calls added up in one join, every call, the steps, the audit rows
- The same, as it happens, in one append-only stream since 0.7.4 (`069_baseline.sql`, `modules/events/`): a turn's start and end, its steps, the answer's new text, each `tool_exec` audit row and each metered call of a turn, under one cursor, `seq`. `GET /api/control/events` pages it, `GET /api/control/events/stream` follows it as Server-Sent Events — replay after `since` or `Last-Event-ID`, then each row once committed, `Cache-Control: no-cache` and `X-Accel-Buffering: no` so a proxy holds nothing — and `nouride events [-f]` prints it. Written synchronously and never failing the turn; swept with the turns on `session_days`. Since 0.7.6 a turn's steps live only here, and since 0.7.10 the steps of turns recorded before 0.7.4 too: `069_baseline.sql` copied them in from `turn_steps` and dropped it, and made `seq` `AUTOINCREMENT`, so SQLite never hands one out twice. Since 0.7.6 too it is a versioned contract, protocol 1.0 ([EVENTS.md](./EVENTS.md), locked by `docs/contracts/` and `tests/contracts/events-contract.test.ts`): `retry` and `compact` are kinds of their own, a `callId` unique within the turn pairs a call's `tool`, `audit` and `tool_done`, the rows of one tool result commit in one transaction with the journal's record of it, and a row too large to keep loses text, never its identity keys
- A model with no published price is recorded as `NULL`, never `0`, so the dollar cap cannot mistake it for free; `max_daily_tokens` is the cap that sees every model
- The day starts at midnight in `[daemon] timezone`; when either cap is reached, a turn is refused with a message naming the cap and how to raise it
- `[daemon] timezone` (0.7.7): left out, the host's zone — where `/etc/localtime` points — and `TZ` in the environment wins over both, `:/path` read for the zone file it names. A name `Intl` cannot use, a typo or a POSIX string like `CET-1CEST`, is refused at load: it made every `localTime` throw, and the nightly pass's clock took the daemon down a minute after each start
- Past the alert threshold the turn still runs. The operator is told once a day at the threshold and once at 95%, each naming the agents and models with the most of the day's spend (0.8.0, `llm/spend-alerts.ts`, kept in the database across a restart: `daemon_state` since 0.8.18, `spend-alerts.json` before); before, the alert rode the `[alerts]` cooldown and came every five minutes

---

## 11. Web Dashboard

### 11.1 Features

- **Login:** Username/password. The first admin's password is generated and printed once at first boot, and must be changed at first login. "Continue with Nouverse" where the edition carries it.
- **User Management:** Add/remove users, change passwords, roles (admin/operator/viewer). More than one account needs an edition that carries multi-user. Every account is someone in People (`web:<account id>` among their ids): one named when it is made, or a new person named after it; one with none is given its own at boot (`boot/account-people.ts`).
- **Chat:** Talk to any agent from the browser, or open a room with several of them; each conversation's timeline also shows what happened around it (a restart, a message nobody saw).
- **Floating chat (0.8.34):** on every page but Chats, for an account that may write: a button with an agent's face, and a panel over the page (a card from a tablet's width up, a sheet on a phone) holding one agent's conversation, the person's newest one-to-one conversation with it as `/chat-list` names it, or a new one. The same session as on Chats: transcript, live turn, approvals, steps, files, stop. It opens on the agent the page belongs to (`/agents/<id>…`), else the one last used there in this browser, else the orchestrator; the person picks another in its bar. Each message carries the page that is open (`page` on `POST /chat/send`, §10.1), and the Chats page sends none. A page's "Ask … to" button opens it on the orchestrator with its request in the box, unsent, under anything already written there. Closed, it reads nothing and holds no event stream.
- **Whose chats (0.8.32):** a conversation's row keeps who opened it (`sessions.opened_by`, the first person who spoke, as People writes an id). An account reads its own: the private chats its person opened, here and on the apps, the groups its person spoke in, the rooms it made or spoke in, and every scheduled job's and mission's conversation. An admin and the control token read every one; an admin's lists say `?whose=everyone` to list them, set apart by person. Every route that names a conversation, a room, a turn, a helper or an event row asks one question (`web/control/whose.ts`), and answers a chat its reader may not open as one that is not there.
- **Agent Management:** Per agent: its files, model, connections, access, skills, external tools (MCP), settings, and its look in the Office; for an external agent a Brain tab in place of Model — the coding CLI, its account and sign-in, the preset, the CLI's model, and the model Nouride's own work for it runs on (§4.4); sleep, wake, enable/disable. Daemon-wide agent settings — who may pair, group context, exec policy, spend caps, retention — on one page.
- **Office (0.8.1):** The agents' statuses drawn as a small office of cats — each agent with its own desk, sofa seat and bed, the orchestrator's desk alone at the front, twelve agents to an office (the orchestrator always, then those the daemon saw first — kept in the database (`daemon_state`; `agents-seen.json` before 0.8.18), written as each agent first loads and `/status` carries as each agent's `since` — the rest counted at a door to another office) — at its desk working, a hand up waiting for a person, on its seat idle, in its bed asleep, a red `!` where one cannot work, walking through the doors and along the hall between them — each cat's look the pack's `[look]` parts (fur, pattern, outfit and its colour, hat, accessory, eyes) and the rest from a versioned hash of its id. Reads `/status` while the tab is seen; nothing on the daemon's side.
- **Skills:** The Workshop — the pool, who carries each skill, drafts waiting on a person, and skills found on public hubs.
- **Memory:** The agents' own notes, people's profiles, the timeline of conversations, shared knowledge, proposals waiting on a person, the nightly pass's settings, the graph, and the tag tools (§12.2).
- **People:** Who is who across platforms (`[[people]]`).
- **Schedule and Webhooks:** Scheduled and webhook jobs — create, edit, run now, pause, delete — with their run history.
- **System Status:** Uptime, connected gateways, LLM usage stats, error rates, cost tracking; System Logs for the daemon's log, the audit trail, job runs and background commands
- **Approval Queue:** View pending tool approvals, approve/deny from dashboard
- **Gateway Status:** Connection health per gateway, reconnect controls, last activity
- **Models, Secrets, Integrations, Web Search:** Provider profiles and, on a tab of their own, the coding CLIs with their accounts and the agents on each (§4.4); the secret store (names only); other tools using this install over MCP; and the search backend.
- **Update:** Which version this is, and installing a newer one.

### 11.2 Auth & Security

- Passwords hashed with `Bun.password.hash()` (argon2id) at OWASP's cost, `m=19456,t=2,p=1` — since 0.7.11; a hash
  made at another cost (Bun's 64 MiB default, before) still verifies, and is hashed again at this one when it does
- Session tokens: opaque, carried in an `HttpOnly` cookie; SQLite (`user_sessions`) keeps only their SHA-256 (since
  0.8.17, whose upgrade cleared the sessions kept before, so everyone signed in once); expired ones are swept
- The cookie is `SameSite=Lax`, so a cross-site form cannot carry a session into a state-changing request
- Rate limiting: 30 sign-in attempts per address and 10 per account in 15 minutes; a successful sign-in is refunded
- First boot: generate random admin password, print to stdout once
- All dashboard API routes behind auth middleware; the CLI's control token (`data/.control-token`) counts as an admin

### 11.3 Tech

- Backend: Hono (see TD-002) serving API routes + static frontend assets
- Frontend: React 19 + Vite + TanStack Router + TanStack Query + TailwindCSS + daisyUI (see TD-009)
- Same stack as Nougate dashboard — zero context-switching across Nouverse products

---

---

## 12. Memory Persistence & Recall

Two kinds of memory, kept apart on purpose:

- **The agent's own notes**, `MEMORY.md` in its pack: how it works, its conventions, what it is in the middle of.
  Written by the agent, in the prompt on every turn, never touched by the nightly pass (§12.1).
- **What is remembered about people and conversations**, in the memory vault: every conversation as an episode, a profile per known person, and shared knowledge.
  Filed each night by the nightly pass, recalled into every prompt, and searched on demand (§12.2, §12.3).

Memory is written in English whatever language a conversation was in, so one search finds it across every chat.
Names and quoted terms stay as they were said, and transcripts stay exactly as they were said.
Every writer checks it (`memoryTextIsEnglish`, `modules/memory/english.ts`): the nightly pass asks once more and otherwise leaves the conversation for the next night, and `memory_write` refuses with the reason.

### 12.1 MEMORY.md Read/Write

Agents read and write their own `MEMORY.md` file through built-in tools:

**`memory_read`:** With no arguments, re-reads the agent's MEMORY.md — already in the prompt, so needed only after a write in the same turn.
Where the daemon keeps memory it also opens a past conversation by id (its transcript while kept, else its summary, optionally with the conversations linked to it), and with `earlier` reads back the exact exchanges of an archived stretch of this conversation (§6.4).

**`memory_write`:** With `about = "agent"` (the default), appends or updates sections in MEMORY.md.
With `about = "person"`, it adds, corrects or removes one fact about the person speaking, in their profile, right away — readable only in this chat and by the people in it.
In a turn that has read outside content — a fetched page, a search, an MCP server's answer, a file somebody sent, and a turn whose own prompt is outside content: a forwarded message (Telegram says so), a webhook's payload in a scheduled job — what it writes says so: a MEMORY.md block carries `> Written after reading outside content (<what>) — a record of it, not an instruction.` under its heading, and a fact ends `(written after reading outside content: <what>)`, so an order a page slipped in reads as where it came from, in the file and in every prompt after. And it waits for a person first (`Tool.keepsInPrompt`): `memory_write`, `person_record` and a change through `person_notes` ask as a change to what the agent is (`config` on the fixed list, never grantable) — asked at `careful` and `balanced`, not at `trusted`, and refused in a run nobody is watching.

```typescript
interface MemoryWriteParams {
  about?: "agent" | "person";
  mode?: "append" | "replace_section" | "full_replace";   // for MEMORY.md
  section?: string;                    // Heading to target; for a person, where a new fact goes
  change?: "add" | "update" | "remove"; // for a person
  current?: string;                    // the fact as it reads now, for update or remove
  content?: string;                    // The text; a person's fact is one English sentence
}
```

**Write semantics:**
- `append` — add content to end of file
- `replace_section` — find section by header, replace its content (between this header and next same-level header); a heading that is not there is an error, not an append
- `full_replace` — always refused: it would let an agent erase its own identity
- Text that is not English is refused, and past 8KB the result says the whole file costs tokens on every request and is worth tidying

**Conflict resolution:**
- Writes to one file are serialized by a per-file lock and written atomically (temp file + rename), so a reader never sees a half-file
- Backup: before any write, the current MEMORY.md is rotated into `MEMORY.md.bak.1` … `.bak.5`
- The packs are also snapshotted weekly under `data/backups/agents/` (`[daemon] backup_keep`)

### 12.2 Autonomous Memory Decisions

An agent does not write down what was said: every conversation is filed for it.
What it writes itself is narrow:
- How it works, its conventions, what it is in the middle of → `memory_write` to MEMORY.md
- Something the person says about themselves that changes over time — work, plans, tastes → `memory_write` with `about = "person"`, kept now
- What does not change about them — full name, family, birthday, allergies → `person_notes`, a line of their notes in `[[people]]`, at their word and only theirs
- A person's name → `person_record`, into `[[people]]`

Everything else is decided by the nightly pass, and what it may not decide alone waits for a person.

**The vault.** `[memory] dir` (`.nouride/memory` by default), plain Markdown with wikilinks, so it opens as an Obsidian graph:

```
episodes/2026/09/2026-09-25-0459-nouva.md    one conversation
archive/2026/09/2026-09-25-0459-nouva.md.gz  its transcript, once the episode is compacted
days/2026/09/2026-09-25.md                   the day's hub, generated
people/<key>.md                              a profile, for a [[people]] entry — named by its key
agents/<id>.md · groups/<slug>.md · tags/<tag>.md   graph stubs
shared.md                                    what every agent knows, in every chat
.proposals/ · .history/                      changes waiting on a person, and previous versions
.nouride-vault.json                          which format the vault is in: {"format": 2}
```

Everything that is a folder of many files is by month, so no folder grows past a month.
The vault is the truth; the database holds only its index, rebuilt from the files at every boot (§12.3).
It is snapshotted at boot and daily under `data/backups/memory/` (or `memory/` under `[daemon] backup_dir`) — unchanged files hard-linked to the previous snapshot — and again, always under `data/backups/memory/`, before a tag tidy.
Which format it is in is the vault's own to say, in `.nouride-vault.json`, read at boot before anything else touches it — before the database is migrated too: 1 is 0.6's flat `days/`, 2 is 0.7's months. This build reads 2 only. A vault in 1 refuses the boot with "install 0.7.28 first", whose first start lays it out by month (0.8.0 has no step between formats); one a newer build wrote refuses the boot too. An episode whose `day:` still links a flat hub is a problem the sync names, with the link to write, rather than one it files.

**Episodes.** One conversation, cut from the turn log and, in a group, the room's message log — never from the session context, which compaction rewrites.
A chat is cut at `/new` or `/reset` in it, and by the nightly pass for every chat active since its last cut; there is no idle timer.
Where it was last cut is the vault's to say: where its latest episode ended, or a deleted one did (`.deleted.json`) — 0.8.0 dropped the cursor the database kept beside it (`069`).
A cut is split at each local day it crosses and past what one model call reads whole; a scheduled job's own chat, and a stretch with no person in it, are not episodes, and what people said more than a day before the first agent reply does not open one.
Its frontmatter carries `status` (`raw` → `summarized` → `compacted`), `kind` (`dm`, `group`, or `archive` for an import), the chat, start and end, the day, the agents and people in it, the people it mentions, the group, tags, importance (1–5), related episodes and the summary; the body is the transcript while it is kept.

**The nightly pass** (`[memory] pass`, off until setup asks; at `pass_at` in `[daemon] timezone`, once no turn is running; `nouride memory pass` runs it now).
Since 0.8.0 the scheduled night also waits while the box is busy (`commons/box-load.ts`): the CPUs together more than 70% busy over the last minute (from `/proc/stat`, not the load average), a thermal zone at or past the lowest of its `passive`, `hot` or `critical` trip points (a fan's `active` ones do not count), or the daemon's cgroup — the unit's, above `daemon/` and `commands/` when boot split it — stalled on memory 10% or more of the last minute (`some avg60` in its `memory.pressure`). Each signal counts only where its file is, so a machine without them is never busy, and a reading that fails is room. A busy box skips the minute; once started, each conversation and each batch of the embedding after them waits, looking again every half minute. After two hours of waiting in all, the night goes on busy or not. The journal says once that it waits, with why, and once that it goes on. A pass asked for by hand (`nouride memory pass`, Run now) never waits.
It cuts every active chat, then files raw episodes — direct conversations first, oldest first, at most `pass_per_night` per agent — with each episode's own agent's provider and model unless `pass_provider` / `pass_model` say otherwise.
A pass model that cannot answer — not served, no access, out of quota or credit (404, 403, 402, a 429 that says quota, a provider saying the model is unknown) — is asked of the episode's agent's own model instead, and so is a compaction summary routed to `summary_model` or `pass_model` (since 0.7.25); a 5xx, a timeout or a short rate limit keeps its retries and no fallback. The log says it once an hour per model, and `/health`'s issues (the Overview's warnings) and `nouride doctor` say what failed or fell back in the last 24 h, with the setting to change. So does the Memory page, under the setting itself: its **Helper model** card (Settings) says what that model is for — the pass, and compaction unless `summary_model` is set, which it then names — and reads `/status`'s `helpers` for a working line or what failed, how often, when and the provider's last words (0.7.26).
A night may also have a budget of its own, `pass_max_tokens` (0, the default, is none): the pass stops before the next conversation once its calls have used that many tokens, counted as reported or estimated where a provider reported none, and the rest wait — the count is never lifted by it, and `[llm.limits]` applies as well; the night's report says how many it used.
An agent with more conversations a day than `pass_per_night` falls further behind every night, so the backlog is said where an operator looks — the Memory page's pass card, `nouride memory`, `nouride doctor`, and a warning in the log after the night — with each agent's pace (its conversations a day over the last week, or since the first on a younger box) and the `pass_per_night` that would file what waits within a week.
For each one the model writes a summary, tags, importance, who was mentioned, and changes to people's facts, in English.
Facts follow `[memory] facts` — `auto` applies them, `ask` proposes each, `off` (the default) files conversations only — and a `[[people]]` entry's own `facts` overrides it for that person.
A fact is stamped with the conversation it came from and that conversation's audience, so it is readable exactly where the conversation is.
`shared.md` is never changed by the pass on its own say: with `propose_shared` it proposes, and a person approves (`nouride memory proposals`, or the dashboard).
Each episode is linked to up to three earlier ones that share its people and tags, from the last 90 days, ordered by meaning when vectors are on.
An episode is marked summarized last, so a crash means it is filed again; after `max_attempts` failures it waits for a person (`nouride memory failed`, `retry`).
The pass also merges a profile that has grown past what a prompt can carry (never removing more than a third of it in one go), compacts episodes older than `transcript_days` — keeping the summary forever, and the whole file as `.md.gz` under `archive/` when `archive` is on — redraws the day hubs that changed, and embeds what it filed in the background.
Today's `[llm.limits]` are checked before each episode, and every call is recorded in `llm_usage`; a night over budget stops without counting as a failure.
The question is sent as two cached system blocks and the episode: the rules, the same for every episode, then the tags the episode's audience uses — read once per audience per night, whose episodes are filed back to back — so from the second call on, a provider that caches prompts reads both from its cache.
Every change to a fact is recorded with its cause (`nouride memory changes`), and a profile or `shared.md` can be put back one version (`nouride memory undo`).

**Groups.** A group conversation is filed under the group's slug (`groups/<slug>.md` — storage, not the group's name: a group is named on the dashboard's Groups page), and what is learned there is readable in that group.

**Tags are one vocabulary.** Whatever writes a tag — the pass, an import, a tidy, a person — goes through one gate (`fileTags`, `modules/memory/tags.ts`):
- A new spelling is folded into the tag already in use when the match is certain: the same word with a plural or separator, a one-letter typo, a short form.
- A conversation may then coin **one** new tag — three while its audience has fewer than 20 tagged conversations — and an import none of its own; a conversation keeps four at most.
- The model is shown the tags in use for that audience, most used first, then tags used once in the last 30 days, and the chat's own recent tags.
- A tag gets its own page only once two conversations share it; a page nobody edited is removed when that stops being true, and spellings listed under a page's `aliases` are read as that tag.

The tags already written are tidied with the same rules, from **Tidy tags** on the Memory page or `nouride memory tags tidy`: merged spellings, a narrower tag folded into the broad one beside it (only when asked for), tags only one conversation has trimmed, and more than four on a conversation capped.
A person ticks what to apply; **Also ask the model** (`nouride memory tags suggest`) adds merges by meaning, unticked.
Applying backs the vault up first and changes only each episode's `tags:` line; a tag merged away keeps working as an alias, and **Undo** (`nouride memory tags undo`) puts the newest tidy back.
The morning after a pass, the Memory page lists the tags it coined, each beside the tag it is nearest, with **Merge into**; the graph has **Merge into…** on every tag, and `nouride memory tags merge <tag…> --into <tag>` does the same.

**Forgetting a person** (`nouride memory forget <person>`) deletes their profile, every conversation they took part in, the facts those conversations taught, and what is proposed about them; with `--anonymize`, other conversations keep the information with their name replaced, and without it each summary that names them is rewritten without them. A conversation is someone else's about them when it mentions them, or names them by key, full name or alias; a single word of their name, matched only as written, is replaced inside those and never decides one — so forgetting "Claude Test" leaves every other "test" alone.
Neither can be undone: no earlier version of any profile keeps those facts for Undo, Recent changes loses the changes about them and those their conversations made, and a day hub listing a changed summary is drawn again. Deleting one conversation takes what it taught out of the same places.
Every chat is cut into episodes first, so what they said since the last cut is forgotten with the rest rather than filed by the next pass.
What stays is outside memory: the vault's weekly snapshots taken before, until `backup_keep` rotates them out; a chat still open with them, until `/new` or a rollover; and the turn log, for `session_days`.

### 12.3 Memory Search

**Who may see what** is decided by who was in the conversation, never by a model:
a DM with a person sees what that person took part in, on any agent, and a group sees what was said in that group.
A fact carries its source conversation's audience, and a fact a person wrote by hand is readable wherever its subject is present.
Search, recall and `memory_read` all filter by the chat they are asked from, so nothing from anyone's DM reaches a group.

**RECALL**, in every prompt (§6.3), without being asked:
- the profile of each known person in the chat — in a DM its person, in a group those speaking — up to 60 facts a person and 120 in all, in the order of their keys and with the same share for everyone present, whoever is speaking — each fact with the day it was learned, its source conversation's;
- `shared.md`;
- what is coming up in the next week (a fact's `(on …)` date) and each person's open follow-ups; a fact past its `(until …)` date is not shown;
- the newest `[memory] prompt_recent` conversation summaries this chat may see, each saying when it was another agent's;
- the conversations cut since the last pass, by their first line, with the id `memory_read` opens — and told that only that line was read, so the agent opens one before relying on it.

The same fact learned in several chats is a line for each — readable where each was said, since a near-copy may carry a detail only one chat heard — and where a chat may read several, RECALL shows it once: alike within a section by meaning when `[memory.semantic]` is on (close vectors, and half the shorter one's words shared), by words otherwise; the one that says everything the others say, or else the newest.

`[memory] recall = false` leaves it out, and a `[[people]]` entry's own `recall` overrides that for one person: off, their facts are left out everywhere, and a chat whose RECALL is off — a DM follows its person, a group the setting — carries no shared knowledge and no conversations either. The pass still learns, and `memory_search` and `memory_read` still reach all of it.

It changes only when a pass, a cut or a `memory_write` does, and in a group when somebody new has spoken, so it is cached — a block of its own after the harness, so that what moves it costs only itself.

**`memory_search`** reaches the rest — conversations, people's facts and shared facts — with optional `since`, `until`, `people` and `agents` filters and at most 30 results (10 by default):
1. **Keywords**, through SQLite's own full-text engine (FTS5, TD-015), ranked by BM25: a word in a conversation's summary counts twice what it does in its transcript, and Indonesian words also match by their root.
2. **Meaning**, when `[memory.semantic]` is on: cosine similarity over the same visible items.
3. The two orderings fused, then scored by relevance (0.5), importance (0.3) and recency (0.2).
4. **Related conversations**, both ways: what a hit continues and what continued it, up to two links out, at most five per hit, nearest first, each worth 0.7 of the one it came from.
5. **One conversation, one result**: the pieces a cut split one conversation into (at a day, or at what one nightly call reads) are one hit — the best match, naming the other pieces' ids — and a piece the hop brings does not count against its five.

Agents are told to search with English keywords, since that is what memory is written in.
`memory_analyze` answers counting questions over the same conversations — top tags or people, when something came up, trends — with no model call.

**The index** is a cache of the vault in the database: a contentless FTS5 table (`memory_fts`) over each item's summary, tags, body and Indonesian roots, plus the episodes, facts, tags and links as rows.
Boot reads every file that changed before memory answers anything, so a file edited while the daemon was down is what memory answers from; `nouride memory reindex` rebuilds it, and `nouride doctor` runs FTS5's own integrity check.

**Vectors** (`[memory.semantic]`: `enabled`, `provider`, `model`, `dimensions`) embed each filed conversation's summary and tags, and every fact — never raw transcripts — through a provider profile with an OpenAI-style `/embeddings` endpoint.
They are stored in `memory_vectors` as their bytes, one row per item and model, and read into memory once per model: a search asks SQLite only for the ids of what its audience may see, scores them against the vectors in memory, and reads whole only the episodes either ranking put near its top. Held, not kept for good: a model no search has read for a quarter of an hour is let go and read again when next wanted, and a vector removed takes its bytes with it.
A catch-up embeds at most 2,000 items, so switching it on over a large archive spreads across nights; `nouride memory embed` runs one now.
A vector is recorded under the provider, the model and the size asked of it (`ollama/bge-m3:latest@512`), so changing any of the three embeds everything again; a vector made before 0.7.3, when the size was not in the key, was put under its sized key by `069_baseline.sql`.
The old model's vectors are not deleted ahead of the new ones: they are kept beside them until the new model has every item, and the catch-up that completes it deletes them, so a model that cannot be reached, or one switched back from, leaves the index as it was.
Until the new model has as many vectors as the old one, a search is ranked by the old one — its query embedded by the old model, through the provider its key names — so a change of model is not nights of search blind by meaning; conversations filed since the change have only the new model's vectors, and are found by their words until it takes over. An old provider that cannot be used any more is left alone for a quarter of an hour at a time, and the new model ranks with what it has.
A failed call means the search runs on the model in use, or on keywords alone — meaning makes search better, it is never a reason for it to fail.

**From other tools.** With `[mcp_server] enabled`, Claude Code, an editor or another MCP client reaches memory at `/mcp` with a token from `nouride mcp-server token create`, bound to one person and the agents named on it; the audience is that person's DM.
A client may also save a condensed conversation, which becomes a raw episode filed that night like any other.

`archive` episodes, which an import before 0.8.0 made from day summaries, are read like any other. The import of a 0.5 or 0.6 capture folder (`memory backfill`) is gone in 0.8.0; 0.7.28 still has it.

### 12.4 Skill Learning

The other half of remembering: memory keeps *what happened* and what is true, and this keeps *how to do it*.
`[skills.learning]` (was `[rsi]` until 0.7.27; refused since 0.8.0, naming `[skills.learning]`).

**Three places, one of them a skill.** Work notes hold one task while it runs — its plan, where it stands, what it
found (§10). Memory holds facts — about people, and about this environment: which host runs what, its addresses,
accounts and paths (§12.1–12.3). A skill holds a procedure for a *kind* of task: the steps an agent follows the next
time it does work like this, on a different task and perhaps on a different machine. Only that becomes a skill.

**Trigger** (`modules/reflection/trigger.ts`, pure). Decides *when to look*, never what to conclude. Structural and
free — counting, exit codes, a tool name not seen before — with the dials fixed in `reflection/tuning.ts`:

| Rule | Fires when |
|---|---|
| `user_request` | the person asked for a skill in words |
| `error_recovery` | three or more tool calls failed in a turn, and one succeeded *after the last failure* |
| `sustained_effort` | eight rounds accumulated in one conversation — a turn is worth its model round-trips, **plus one when it arrived within three minutes of the agent's last word** |
| `first_integration` | the agent succeeded for the first time ever with a tool it had not used |

`sustained_effort` catches a long conversation where every command succeeded and the person still had to steer.
Earlier versions read that from phrasing ("bukan gitu", "still broken") and failed silently for wording nobody
anticipated; the counter is borrowed from Hermes Agent's `skill_nudge_interval` and is deliberately dumb. Correction
density is counted without reading a word — a turn arriving inside three minutes is worth an extra round — and over
228 real turns that left the number of reflections unchanged while a dense chain reached the threshold in six turns
instead of ten. The counter is reset when the pass runs, not when a trigger matches; a minute's cooldown per agent and
twenty pending drafts bound the rest.

**Triage** (`reflection/synthesis.ts`, `prompts.ts`). One call, one question: what should happen to the library
because of this conversation — `skip`, `update <skill>`, `attach <skill>` (a file beside it rather than a longer body)
or `create`. It sees every skill with its description, size and owner, and can read any of them. It is active about
procedure — "standard" and "routine" are not reasons to skip, and a correction is a first-class signal — and strict
about destination: an incident earns a line only as the step that prevents it on the next task of the kind, and
facts, measurements, one task's own steps and Nouride's own flags are not captured. A second call writes: the new
skill, or the revised one, given the current file.

**A new kind of work waits for a second conversation** (`candidates.store.ts`, `069_baseline.sql`). A `create`
names the class and its "Use when" line and is held as a candidate — no body, no second call. When a later
conversation is the same kind of work (triage names the candidate in `recurs`, or picks its name) the skill is
written; a person asking for one skips the wait; a candidate lapses after 30 days. One conversation cannot show that
work recurs, and on the live box by 2026-10-22 a single audit workbook had become a skill.

**Checked in code** (`draft-lint.ts`, `gates.ts`), because the prompts said the same and it did not hold. A draft is
refused when its body names a machine's address, a hardware address or an account, or tells a session ("in this
session", "the user said"); when a description it set reads as an edit note ("Update…", "Document…"); when a new body
passes 8,000 characters; and when a revision takes a body past 12,000 — one already past it may only shrink. Revisions
integrate the lesson into the step it changes rather than append it. The live box had grown `home-pc-ops` to 306 lines
of incidents under the old rule, "keep everything that is still true".

**Scope.** A skill learning writes is on for the agent whose work it came from (`agents:` in its frontmatter,
`Skill.agents`); another agent turns it on in its `skills.toml`, whose answer always wins. Until 0.7.27 every pooled
skill was on for every agent, and a split drawn per agent leaked with each new one.

**Ownership.** Learning may revise a skill an **agent** wrote (`author:` in the frontmatter) and never one a
**person** wrote or one that ships with Nouride. Checked twice: triage marks them off limits, and `approve` refuses.

**Two axes of "can this actually run".** `requires:` names host software, a **local** `PATH` lookup (a procedure that
runs `ssh host "docker ps"` needs `ssh` here, not `docker`). `needs_tools:` names the Nouride tools it calls, checked
against each agent's `[tools] enabled`. Both advisory, both surfaced in the Workshop, `nouride skills` and `doctor`.

**`skill_improve`.** An agent that just found the step a skill was missing says so during the turn; it proposes and
never writes, and the draft waits for a person.

**Redaction.** Credential-shaped runs are masked before the transcript leaves the box and again on what the model
wrote; what was masked is recorded on the draft.

**The gate** — `mode`. `ask` (the default) leaves every draft in `skill_drafts` until a person approves it from chat,
the Workshop or `nouride skills approve`, or discards it; a pending draft never expires. `auto` approves the pass's own
drafts as they are written, which is what Hermes does, and records the daemon as the approver (`skill-learning:auto`).
`off` examines nothing; queued drafts stay decidable. An unrecognised mode is read as `ask`, never as `auto`.

**The weekly review** (`curator.ts`, `review.ts`) — what Hermes has no counterpart for. A pass that only adds grows a
library nobody prunes, so once a week while learning is on (the daily sweep checks), and on `nouride skills review`:

- **tighten** — a body past 12,000 characters comes back shorter; one naming an address, an account or a session comes
  back without it;
- **merge** — one model call over the names and descriptions finds skills covering one subject; one is rewritten to
  hold them and the others are archived on approval;
- **archive** — a skill nobody has read in 45 days and older than that, with no model call. Reads are `skill_reads`,
  which the audit log fills and its retention does not empty; a path first asked about is watched from the oldest
  audit row searched, so "unread" is never claimed for longer than anything was looking.

Only skills an agent wrote are touched. Each proposal is a `curation` draft that waits for a person in every mode,
`auto` included. An archived skill moves to `skills/.archive/`; moving it back undoes it.

---

## 13. Subagent & Session Spawning

### 13.1 Subagent Model

Agents can hand independent pieces of work to blank helpers that run in parallel, with the `delegate` tool:

```typescript
interface DelegateParams {
  tasks: {                             // 1–4 briefs, written in English whatever language the person speaks
    goal: string;                      // what it is to achieve, in one sentence
    context: string;                   // what it needs and cannot know — refused when empty, with what to add
    constraints?: string;              // what it must not do, or must keep to
    deliverable: string;               // what it hands back, and in what shape
  }[];
  background?: boolean;                // each brief a job of its own (§13.3); offered only where the agent may
  tier?: "small" | "default" | "high"; // which of the agent's own models runs the helpers (§20); unsaid: default
  isolated?: boolean;                  // each helper in a worktree of the mission's, on a branch of its own (§13.5);
                                       //   offered only in a mission that works in a worktree
}

interface SubAgentHandoff {            // one per task, all returned together as the tool result
  agentId: string;                     // the parent's: a helper runs as its parent
  status: "success" | "requires_human" | "incomplete" | "failed";
  summary: string;                     // its answer
  files: string[];                     // files it wrote
  spills: string[];                    // large outputs it spilled to disk, readable by the parent
  metrics: { toolCalls: number; steps: number; ms: number };
  reason?: string;
}
```

**Execution model:**
1. Parent agent calls `delegate` with up to four tasks
2. Each helper starts at once, as the parent's agent id — the same tools, model, workspace, grants, approval gate, MCP servers' tools and skills' index (the names and one line each; a body is read when a task needs it) — with a role instead of the persona, its brief as its one message, and no memory or history. The daemon adds what the parent cannot be expected to restate: the workspace and the agent's runtime facts are in its prompt, the conversation's files open as they do for the parent, and a file the brief names is listed with where it is
3. Each runs to completion with half the parent's tool-iteration budget (at least 3; half of the pack's own number when it names one — it reached a helper whole until 0.7.15), under the parent's approval level — a person on `/approvals balanced` is not asked again for a helper's writes — and against the parent's deadline less one wrap-up reserve, so it hands back a summary before the parent has to answer. One that ran out of rounds or of time hands back `incomplete`, not `success`, though its last words came from the wrap-up
4. All results return to the parent agent together, as one tool result; one helper failing is reported in place and does not fail the others
5. Nothing of a helper is kept but what it wrote and spilled

**Use cases:**
- Parallel file reads / searches
- Several independent questions answered at once instead of one after another
- Delegating bounded side-tasks without filling the parent's context

**Constraints:**
- At most 4 tasks per call
- Inside `[queue] max_concurrent_turns`, never waiting on it (`pipeline/lanes.ts`): the parent waits on its helpers, so its slot is the first helper's, and each further helper takes one only where the ceiling has room. At the ceiling they run one after another on the parent's — slower, and none fails for want of a slot. Waiting for a slot instead would stop the daemon: every parent at the ceiling holding the slot its helpers wait for. An `ask_agent` peer runs on its asker's lanes the same way
- Subagents cannot spawn their own subagents (max depth = 1): `delegate` is removed from a helper's toolset
- A helper does not speak as its parent: `send_file` and `send_message` are removed, the tools whose writes every later prompt reads (`memory_write`, `person_record`) are not offered, and a write through one that also reads (`person_notes` with a change) is refused at the gate — the mark S13 holds such a write at (`Tool.keepsInPrompt`). It says in its answer what is worth keeping, and the parent decides
- An approval a helper needs is asked as the parent's, and one refused or unanswered ends that helper as `requires_human`
- Every tool call a helper makes is in the audit trail, like the parent's

A helper is not another agent: to hand work to Nox with Nox's own persona, memory and permissions, an agent uses `ask_agent` (§4.3).

### 13.2 Session Types

| Type | Lifetime | Context | Use Case |
|------|----------|---------|----------|
| Main | Persistent per chat — a Discord thread or a Telegram topic is a chat of its own | Full conversation history | Normal chat |
| Subagent | One `delegate` call; nothing stored | Empty, with a role instead of the persona | Delegated tasks |
| Cron | Persistent per job (`cron:<jobId>`), for `session = "isolated"`; a `fresh` job keeps nothing | The job's own earlier runs | Scheduled background work |

### 13.3 Helpers in the Background (0.7.15)

`delegate` with `background: true`: the agent hands a task that will take a while to a helper and its turn ends at once, so the person can talk to it meanwhile.
Asked for by the owner on 2026-10-18 — one helper is the habit for a long task, so the agent stays on standby, and two are for two independent pieces.

- **Each helper is a job of its own** — a row of `jobs` with `kind = 'helper'` (`069_baseline.sql`): listed by `nouride jobs` and on the dashboard (System Logs → Background work, and the strip in its chat), stopped by `nouride jobs kill` and by `/stop` in its chat, and bounded by `[security] job_max_ms` like any job. Its row keeps its brief and, once it ends, its handoff; its log is its steps as it takes them. The row is the shape 0.8.0's missions take over: one task, one parent, one report.
- **Its own turn record** (0.7.26, `pipeline/delegated-turn.ts`), beside its log: a turn in the chat it works for, its cause `{via: "delegate", job, parent}` — the job, and the turn that started it — its steps and tool calls, each nudge it read (a `read a nudge: …` note, written by the executor at the step it reads one), and its handoff's summary as the reply. `nouride turns show <id>` reads it; the turn that started it lists it (`handed off`), and the log's first line names it. It is no turn of the conversation: the transcript, the live view, memory, a reply's file and a restart's resume read the chat's own turns only (`OWN` in `turns.store.ts`), a restart closes it without telling the chat, and deleting the conversation deletes it. Its model calls and audit rows stay the starting turn's (D2).
- **A helper waited on that runs long moves here.** `delegate` without `background` is for quick questions: it waits for its helpers up to 45 seconds (`FOREGROUND_WAIT_MS`, in `tools/builtins/wait-then-move.ts`), the wait an ask has (§13.4). A helper that answers inside it is answered in the turn, as always. One still working then carries on as a helper job of the agent's, as if `background: true` had started it at that moment (`pipeline/background-move.ts`): the same row, limit, log, stop, nudges and wake-up. The tool result says which answered and which moved, with their job ids, and that their results will come as messages; the turn wraps up (`helper_moved`), reporting what the others found. A helper that moved is told so before its next step, and from then has a background helper's clock and its commands' thirty minutes; its round trips stay the half it started with, the number its prompt gave it. With no room to move one — the limit full, the day's spend reached, no jobs in this process — it stays and is waited for to the end, and its answer says why it took so long. Found live: three tasks of five to ten minutes each, sent to the foreground, held the person's chat for eight minutes.
- **The turn ends at once** with what it started (`helper_started`): the reply says what is working and that the result will come. The tool result names every helper running for this conversation; a person's later turn there is told the same, in a note on their message, so the agent can check what runs before starting more and answer "how is it going" with what is true.
- **Each result wakes the agent as it arrives** — through the road every job's end takes (`pipeline/job-wakes.ts`), after the turn running in that chat, in order behind anything queued. Two helpers are two wake-ups: the first to finish is reported first, with no barrier. The wake-up carries the helper's handoff (§13.1); the agent reports it in the person's language. A helper that stopped short is said by the daemon itself first (`⚠️ Background helper … stopped before it finished its work: …`), as a failed command is.
- **The limit** is `[delegate] max_background` — the daemon's (0 off, at most 4; unset it follows the machine: one for each core but one and one for each GiB of memory the agents' commands may use, whichever is lower, at least 1 and at most 4, `commons/machine.ts`) or the agent's own in its pack, set from its Settings page in the dashboard and read as each helper starts and as each turn's toolset is resolved, so a change applies to the next one without a restart. Since 0.7.19 it counts the agent's asks in the background too (§13.4): one number for both. One over it is refused with what is running; the same goal already running is refused as already running (not a helper waited on that moves: its work is under way already). With the limit at 0 `delegate`'s schema has no `background`, and its helpers in the foreground are waited for to the end. A scheduled turn and a peer's turn (`ask_agent`) get none either: the first has nobody to stay free for, and the second answers the agent that asked, not the chat.
- **Its own clock and budget:** the agent's whole tool-iteration budget and turn duration, not half — it is a turn of the agent's that nobody waits on — or `job_max_ms` when the operator set it shorter, wrapping up a reserve before either. It holds no slot under `[queue] max_concurrent_turns`: it exists so the agent stays free for the person, and one holding a chat's slot would be what keeps them waiting; `max_background` is what bounds helpers. Its model calls are metered under the turn that started it, against the day's caps, and it is refused before it starts when the cap is reached.
- **Room for the machine** (0.8.0): started while the box is busy — the three signals of §12.2's nightly pass — it waits before its first step, looking again every half minute, its log saying why it waits and when it goes on. Ten minutes at most, and never more than half of `job_max_ms` when one is set; its turn's clock starts when it does, and `job_max_ms` still counts from its job's start. A stop ends the wait. A helper in the foreground is part of a turn somebody is waiting for and never waits, nor does any turn in a chat.
- **Approvals** a background helper needs are asked in the parent's chat, through the approval gate the agent's own calls use — answerable there, from the CLI and from the dashboard, and kept across a restart (D8) — with the helper and its goal in the reason: `a background task (job_…: "…") wants to run this — …`. It waits for the question's whole window; unanswered, the question expires and the helper stops there and says so (`requires_human`).
- **A restart** stops every helper: a shutdown pauses it at its next step, keeps what it did with its row and writes no end; a crash writes nothing at all. The next boot closes the row as interrupted (`JobStore.interruptOrphaned`) and wakes the agent with what it had done — its handoff if it had one, its log — that it is not resumed, and its brief to start it again from.

### 13.4 Asks That Run Long (0.7.19)

`ask_agent` ran the peer's whole turn inside the asking agent's tool call (§4.3), so a deploy or an audit held the asking turn — its time budget, and the person, who could not talk to the asking agent meanwhile. The hybrid (`pipeline/background-ask.ts`):

- **It waits, then moves.** The ask waits for the answer as before, up to `FOREGROUND_WAIT_MS` (45 s, in `tools/builtins/wait-then-move.ts`, the wait `delegate`'s helpers in the foreground have too). An answer inside that comes back as the tool result, exactly as it always did. Past it, the peer's turn carries on as a background job and the call returns saying the peer is still working and its answer will come as a message; the asking turn wraps up (`ask_in_background`) telling the person so. From then on the peer's turn is no longer tied to the asking turn's abort signal or lifetime.
- **`background: true`** returns at once, for work the agent knows is long.
- **A job of the asking agent's** — a row of `jobs` with `kind = 'ask'`, its agent and task kept in the `brief` column (no migration: the row is read by its kind, and an older daemon lists it as a command). Listed by `nouride jobs` (`ask <agent>: <task>`, "ask at work") and on the dashboard wherever helpers show; stopped by `/stop` in that chat and by `nouride jobs kill`; bounded by `[security] job_max_ms`, counted from when it was asked; closed as interrupted by a restart. Its log is the peer's steps — those it took while it was waited on first — masked of both agents' credentials; its progress bubble in the chat is sealed when it moves. From the move it is also a turn of its own (0.7.26), the asked agent's, as a background helper's is (§13.3): its cause `{via: "ask_agent", job, parent}`, its first step saying it moved and which turn holds the steps before.
- **The answer wakes the asking agent**, never the asked one, in the chat the ask came from — through the road every job's end takes (`pipeline/job-wakes.ts`): after the turn the asking agent is in there, counted in the chain of wake-ups with no person in it. The wake-up says it is the answer from that agent, to what it was asked (a one-line excerpt) and when, then the handoff, so a person who moved on gets context; it is masked as the tool result it used to be. A failure, the time limit, a stop and a restart each wake it too, saying which — the failure, the limit and the restart said by the daemon itself first.
- **One limit.** Background asks count against the asking agent's `[delegate] max_background` with its helpers. Over it, a waited ask simply keeps waiting in the foreground and its result says why; an explicit `background: true` is refused, naming the limit and what holds it.
- **No ping-pong.** Only a turn that may hold background work moves an ask — the agent's own chat turn, with the limit above 0. A helper's turn, a scheduled turn and a turn where the limit is 0 get the waiting form (`waitingForm`: no `background`, every ask waits to the end, and `delegate`'s helpers too); a peer — a background ask's own turn included — still has no `ask_agent` at all.
- **Approvals** the peer needs after the asking turn ended are asked in the chat as before, in the peer's name, with the work in the reason: `nox, working in the background on what nouva asked (job_…: "…"), wants to run this — …`.
- **In a room** the semantics are today's: `ask_agent` is offered there as in a DM, and the wake-up goes to that room's chat. A mention's handover is unchanged.
- **Several agents in one call.** `asks` takes up to four asks, each an agent and its task, in place of `agent` and `task`; the single call's arguments and result are as they were. They start together and every answer comes back in one result, each under `── <agent>: <the ask's first line>`. Each is the single ask it would have been, so everything above holds for each on its own: checked alike (a name nobody has, the asking agent itself, a task too long or not in English are said in that ask's place, and the rest still go), a peer that is asleep, disabled or already at work in the chat answers as failed in its place, the waiting form waits for all of them to the end, and past the wait each one still working moves to the background, one after another, so the one limit counts the ones this call moved: one with no room is waited for, and its answer says why. With `background: true` each starts as a job at once, and one over the limit is not started and says what is running. The result is an error only when nobody answered and nobody is at work; once any moved, the asking turn wraps up as a single ask's does.

### 13.5 A Mission in a Repository (0.8.1)

A mission — long work an agent finishes alone (0.8.0; `[missions]` in §20, `nouride mission`) — works in a folder: the
one it was given, or its own, `workspace/private/<agent>/missions/<id>/`. Where the folder it was given is in a git
repository, it works in a worktree of its own instead (`missions/worktree.ts`):

- **Where:** `workspace/private/<agent>/missions/<id>/worktree`, on the branch `mission/<id>` — or the one `mission`
  start named in `branch` (0.8.7): with a `workdir` only, refused unless `git check-ref-format --branch` takes it as
  it is and the repository does not have it yet — made as the agent from the repository's last commit — what was not committed in the person's clone is neither taken nor touched. The mission
  works at the same place inside it that its folder had in the repository. The notice that asks for a person's yes,
  the done notice and the mission's page name the branch. The daemon makes and removes worktrees and does nothing else
  in git: merging the branch is the agent's call, through the gate like a push.
- **Only where the box has room:** the agents' commands may hold 512 MiB — room for a coding CLI's session, the floor
  of §4.4 — and the free disk is at least twice the repository's checked-out files: one copy, and as much again for what
  installing into it adds. Below either, or in a repository with no commit yet, the mission works in the folder it was
  given and says why, and the one-repository queue stays: a second mission in that repository waits for the first
  (`missions/decide.ts`). Each in a worktree of its own, two missions in one repository run side by side.
- **Helpers that write:** `delegate` with `isolated` (§13.1) gives every helper a worktree of the mission's,
  `missions/<id>/helpers/<n>`, on a branch of its own, `<branch>-helper-<n>`; the result names the branches for the
  mission to merge. Offered only in a mission that works in a worktree.
- **Afterwards:** the mission's own folder, its worktrees with it, is removed 7 days after the mission ends, and the
  worktrees' entries are pruned from the repository. Not where a worktree in it — the mission's or a helper's — holds
  changes nobody committed: then nothing is removed, and the log names them. An agent working in a worktree is told to
  commit. A folder a person gave a mission is theirs and never removed. The branches stay in the repository: nothing
  deletes a `mission/*` branch.

---

## 14. Graceful Shutdown & State Persistence

### 14.1 Shutdown Sequence

```
SIGTERM / SIGINT received
  → Set daemon state to "shutting_down"
  → Stop the background timers (retention, backups, the nightly pass clock)
  → Pause the queue: nothing waiting is started; it stays in the inbox for after the restart
  → Ask every running turn to stop at its next step (half the budget, 15s by default);
    abort the rest as a restart (a sixth, 5s). Each closes into its conversation with
    everything it did, and tells its chat what it had done — while the gateways still work
  → Stop the cron scheduler
  → Stop the gateways
  → Release whoever waits on an approval; keep the requests for the next boot (D8)
  → Let the turns still in flight finish (sessions are written inside the turn)
  → Close MCP clients, kill background jobs, close interactive sessions
  → Record "daemon_stopped" in the audit log; flush the audit and log buffers
  → Stop the HTTP server, and the in-process LLM gateway where there is one
  → Release the lock file, refresh the query planner's statistics, close SQLite
  → Exit
```

The whole sequence has `[daemon] shutdown_timeout_ms` (30s); the systemd unit allows 45s and signals the daemon alone, so a command a turn is running is stopped by the daemon, at a step, rather than killed under it.
**If timeout exceeded:** Exit with an error, log warning. SQLite WAL keeps the database consistent, and anything a turn did is already in its journal (§14.2).
A second signal exits at once.

### 14.2 Startup Recovery

```
Daemon starts
  → Load global config (config.toml)
  → Refuse data 0.8.0 has not run on — `data/last-run-version` older than 0.8.0, or
    missing beside a database — before anything is written or locked, naming the
    release to start first (`boot/upgrade-floor.ts`)
  → Take the install's lock file
  → Bind the HTTP port: until the end of boot, /health answers 503 "starting" with the
    step boot is on, and every other path a 503 saying so (§15.1)
  → Settle the agents' HOME and toolchain: .nouride/bin first on PATH, installers pointed
    at .nouride, the shared Python env checked in the background (§7.1)
  → Read the memory vault's format: refuse one this build does not read (§12.2), before
    the database is touched
  → Open SQLite: refuse a SQLite build without what the memory index needs, refuse a
    database below schema 69 (from before 0.8.0: "install 0.8.0 first") and a schema
    this build is wrong about, snapshot an existing database before migrating, apply
    pending migrations, compact the file if a migration left it mostly empty; then record
    this version in `last-run-version`
  → Close every turn the last process left with a journal (below); mark turns still
    `running` without one as interrupted
  → Integrity-check the database (advisory) — skipped when the last run stopped cleanly
    and a check ran in the last week — check free disk
  → Discover and load all agents (agents/*/)
  → Start the in-process LLM gateway, where the edition has one
  → Memory: read the vault's format and refuse one a newer build wrote, move day pages
    into month folders once (vault snapshotted first), sync the index with the vault,
    drop tag pages nobody shares
  → Connect every agent's MCP servers at once, four handshakes at a time; boot waits at
    most 10 s for one, and a slower server's tools join when it is ready
  → Build the tools and the pipeline; construct the cron scheduler
  → Start gateways (Discord connect, Telegram polling, WhatsApp auth); boot waits at most
    30 s for them (0.8.15), and a slower one keeps connecting — what is sent through it
    waits in its buffer until it is up
  → Settle what the restart owes (below), then report background jobs it killed
  → Start the cron scheduler: reconcile interrupted runs, catch up on missed ones
  → Hand the port the dashboard and the control API
  → Log "nouride ready" with agents, gateways, providers
```

**Mid-conversation recovery (durable turns).** Every step of a turn is committed as it happens: the inbound message is written to the `inbox` before anything acts on it, and each model reply, the tool calls it asks for — marked just before each one runs — and each result go to `turn_journal`.
When a turn ends, however it ends, the journal is folded into the conversation's messages (`session_messages`) and deleted in the same transaction, so a journal found at boot is a turn whose process died without a signal: a power cut, the OOM killer, `kill -9`.
The journal opens before the files that came with a message download (0.7.7) — with its words and the names of what is still arriving, replaced by the composed question once it exists — so a crash during a download, thirty seconds a file, closes the turn with its question rather than leaving a record with nothing behind it.
It is closed into its conversation the way a turn cut short at shutdown is: every finished call keeps its result, a call that was running is marked cut off — so the agent checks before repeating anything that changes something — and the assistant has the last word.
The person is told what was done and what was cut off, and a turn cut off recently — at shutdown or in a crash — is taken up again by itself (step 4 below); one cut off longer ago is asked about (step 5).
What the report ends on is what happens next (`Onward`, `turns/close.ts`). At shutdown the daemon cannot know how long it will be down, so it says both: "If I'm back within 15 minutes I'll carry on by myself; after that I'll ask you first." At boot, of a turn lost in a crash, it says it is carrying on, or asks, or for a turn nobody is asked about only that everything is kept.
A journal write that fails is swallowed so the turn carries on, but not silently (0.7.7): it is counted for `/health`, and every write takes its row's number whether it lands or not, so the journal it leaves has a gap. A turn closed past one says part of it could not be recorded, and no call in it is said not to have started — it may have run.

Once the gateways are up, in this order, without holding up `ready`:
1. Each closed turn tells its chat what it had done, however long the daemon was down; a turn left `running` with no journal gets a plain notice, unless step 4 takes it up again.
2. A reply the last process wrote and never got delivered is sent — once, and only if its turn started in the last 30 minutes. A reply that landed in part is not sent again.
3. Messages it received and never answered are answered when sent in the last 15 minutes, or told they came in while the daemon was offline; a platform's second delivery of one is answered once.
4. A conversation's turn cut off in the last 15 minutes is taken up again, once (`pipeline/restart-resume.ts`): the agent is told the daemon restarted and carries on from where it stopped, checking what a cut-off step did before repeating it. A turn that was itself taking one up is not taken up again, so a turn that crashes the daemon cannot loop, and a cron run is left to the scheduler (§8.5). Cut off longer ago, nothing runs by itself.
5. A conversation's turn cut off longer ago than that, and within two days (`ASK_WITHIN_MS`, as long as the inbox keeps a chat's messages; a starting value), has its chat asked whether to carry on, once (`pipeline/resume-ask.ts`): "I was cut off 1 hour ago while working on "…". I have not carried on by myself, since it was a while ago. Say "continue" and I will pick it up." Built from the record, never asked of a model. For a turn lost in a crash the question is the end of its report in step 1; for one the shutdown stopped it is a line of its own, after the reports, and on the chat's timeline for the dashboard. Where the connection carries buttons it has one, Continue: a press takes the turn up as step 4 would (`continuePresses`), for the person in a one-to-one chat, and in a room the person whose turn it was or an admin. Once per turn across any number of boots: the time it was asked is on its record (`turn_records.resume_asked_at`), set when the question was said, and a turn with one is never taken up by a later boot either — one closed at a boot after a crash would otherwise look freshly cut off to the boot after it. A turn left for its person over a call the gate asks about is marked the same way. Not asked: a scheduled run or a `cron:` session, a mission's turn (it goes on from its page), a helper's own turn (its job reports to the agent that started it), a turn already taken up or itself a resumption, and a chat where anything started since the cut or a message is waiting from before the restart.
6. The dashboard's timeline of each touched chat marks where the restart happened.

Background jobs the restart killed wake their agents after that, and a scheduled job's interrupted run is reconciled by the scheduler (§8.5).
A restart that is asked for — `nouride restart`, an update, the dashboard, `/daemon-restart` — waits for turns ten minutes at most and for background jobs however long they take — a command an external agent's CLI left running in the background too, and half a minute past its end for what the CLI says of it (0.8.6, `Pipeline.cliCommands`) — so the jobs killed are those of a stop, a crash or a `now`. An approval waiting for a person does not hold it: the restart keeps it and asks it again.
They are not carried across on purpose: the daemon is meant to run all day, and a long outage means it was stopped or something is wrong.

**Upgrading the schema.** A migration is applied to an existing database only after a snapshot, `data/backups/db/nouride-<time>-before-<version>.db`, which the daily rotation leaves alone and the next upgrade's snapshot replaces; `nouride db restore` puts one back.
A database a newer build has migrated is refused by an older one, with a message pointing at `nouride db list` and `nouride db restore`.
A database from before 0.8.0 (schema below 69) is refused before anything is applied or snapshotted, naming 0.8.0 — the release whose first start migrates it — and the Docker image to run once; `nouride db adopt`, the drift override and `nouride db restore` of such a snapshot are refused the same way.

### 14.3 Config Hot-Reload

Support live config reload without full daemon restart:

**Hot-reloadable (no restart needed):**
- Agent persona files (SOUL.md, IDENTITY.md, AGENTS.md, MEMORY.md)
- Agent config.toml (model, temperature, tools, skills, MCP servers — reconnected on reload)
- Cron job definitions — they live in the database and change live
- The settings the dashboard edits that the daemon reads per message — access mode, group context, rate limits, approval levels, memory, the reflection loop; each save says whether it applied or needs a restart

Every save of a config file goes one way (`modules/config/config-file.ts`, since 0.7.7): under one lock per file, so two saves at once both land; checked before it is written — the daemon's `config.toml` through the loader's own steps, so a save the next boot would refuse is refused instead, and a pack's file through its agent's reload, the previous text put back when the agent no longer loads; and the previous text kept as `.bak.1` … `.bak.5` beside it. `scripts/check-arch.ts` refuses a config file written any other way.
- A new agent created from the dashboard or by `agent_create`, which is loaded at once

**Requires restart:**
- Global daemon config changes (`[dashboard] port`, `[daemon] data_dir`)
- A new or changed gateway connection, and its credentials: adapters are built at boot (`nouride gateway restart <id>` reconnects an existing one)
- A pack directory added by hand — found when every pack is re-read: at a restart, or after a change to the skill pool
- Database schema changes

**Trigger:** There is no file watcher. A pack is reloaded by `/reload` or `/reset` in a chat, `nouride agent reload <id>`, the dashboard (which reloads after every edit it makes), or a change to the skill pool, which reloads every pack.

---

## 15. Health Check & Monitoring

### 15.1 Health Endpoint

```
GET /health                     (also /api/health; no token)
→ 200 { "status": "ok", "uptime": 3600, "version": "0.7.0", "edition": "basic", "appliance": false, "agents": 3,
        "install": "<hash of the data directory>", "gateways": { "discord:main": "connected", "telegram:nouva": "connected" },
        "memory": { "rssBytes": 118916096, "heapUsedBytes": 45000000 }, "failedAgents": ["kai"] }
→ 503 { "status": "degraded", …, "issues": ["whatsapp:main: dead"] }
```

`memory` is the daemon's own, read at the request (since 0.7.11): what is resident, and how much of the JavaScript heap is in use. Resident includes the pages of the executable mapped from disk, which the kernel drops under pressure; the heap is the part it cannot.

`agents` is the number answering now and `failedAgents` the ids of the packs that did not load, absent when none failed — both read from the registry at the request (since 0.7.11), so a pack fixed and reloaded leaves the list and is counted at once.
A failed pack is reported, not a status: `degraded` does not read it, so neither Docker's healthcheck nor an update's confirmation waits on it — a rollback could not undo the migration the update already ran.
The dashboard's Overview names each under its warnings, and `nouride doctor` says why it failed.

`degraded` means a gateway is dead, the SQLite WAL is past 100 MB, or a provider has failed three times in a row; a reconnecting gateway is listed under `issues` without failing the probe, and so are turn journal writes that failed since start (`turn journal: 2 write(s) failed since start, the last at …`) — the daemon still answers, and a restart empties no disk.
A daemon that is stopping answers `shutting_down` with 503.
A daemon that is booting answers `starting` with 503 from the moment it has its config and its lock, with `phase` naming the step — `opening the database`, `checking the database`, `loading agents`, `loading memory`, `taking boot snapshots`, `connecting MCP servers`, `connecting gateways`, `starting the control plane` — and `install`, `version` and `edition` as ever; `agents` is 0 and `gateways` empty until boot knows them.
Every other path answers 503 with `Retry-After: 2` until then: an API path `{ "error": "nouride is starting — <phase>", "note": … }`, a page a short one that reloads itself.
A probe that waits for a 200, as `install.sh`, Docker and the flash tool do, waits for the end of boot as it always did; what changed is that `nouride status` and the dashboard can tell a daemon starting from one that is not running.
**Clean stop.** The last thing a clean shutdown does, after the database closes, is write `data/clean-shutdown.json` — when it stopped and when the database was last checked. Boot takes it (reads and deletes it, so a run that dies leaves none) and skips `PRAGMA quick_check` when it is there and the last check is less than a week old.

### 15.2 Heartbeat System

Periodic self-check, every minute:
- Check disk space in the data directory, alerting through `[alerts]` below 1 GB

The minute and both thresholds — this one and the WAL's 100 MB above — were `[health]` until 0.8.0. Nobody tuned them;
they are fixed values now, and a `[health]` table still in a file is named in a warning and ignored.

The rest is checked where it happens: each gateway pings its own upstream (§5.5) and alerts when it gives up, and the WAL size and provider failures are what `/health` reports (§15.1).
The heartbeat reaches no model, and nothing in this runtime starts a turn nobody asked for: work that must happen *at a time* is cron (§8).

### 15.3 Structured Logging

```typescript
interface LogEntry {
  timestamp: string;                   // ISO-8601
  level: "debug" | "info" | "warn" | "error";
  component: string;                   // "gateway.discord", "llm.executor", "cron", etc.
  agent_id?: string;
  chat_id?: string;
  message: string;
  data?: Record<string, unknown>;      // Structured context
}
```

- Logs to stdout in JSON format (for container/systemd collection); under launchd, stdout goes to `.nouride/data/nouride.log`, kept under 16 MB by the daemon (the previous 16 MB in `nouride.log.1`)
- The daemon also keeps its recent lines in memory, which `nouride logs` reads, and its log in SQLite (`log_entries`, `[retention] log_days`, default 3), which System Logs on the dashboard reads — neither needs a journal, and both work from another machine
- Error-level logs also written to `audit_log` SQLite table
- Every line is scrubbed once, where it is written and before any of the three reads it (`log-redact.ts` in
  `@nouride/shared`, since 0.7.10): a value under a key named like a credential — `token`, `password`, `api_key`,
  `authorization`, `cookie`, `secret`, in any spelling — is `[redacted]`, and so are a `Bearer` or `Basic` value, a
  URL's password, and a query parameter or JSON field of such a name inside any string. A flag or a count under such a
  key is kept, and a line that means a secret's *name* says `secret_name`
- No stack traces or internal paths leaked to chat users (sanitized error messages)

---

## 16. Licensing & Commercial Considerations

### 16.1 The WhatsApp bridge

Baileys is MIT. The bridge is a **module** of its own — `packages/wa-bridge`, sharing nothing with the
engine but `@nouride/runtime`, behind a newline-delimited JSON protocol — and every edition compiles it
into the binary. It runs in the daemon's process — one WhatsApp number per daemon. Its one copyleft dependency, `libsignal` (GPL-3.0), is replaced
by an MIT shim, and a contract test fails if the real package returns (`packages/wa-bridge/README.md`).
`ARCHITECTURE.md` §6 is the account of the boundary.

The one alternative still worth keeping in view is Meta's official Cloud API: no QR auth, official
webhooks, a Business account and Meta app review, and a monthly cost. It is the better shape for a
production deployment for reasons that have nothing to do with how the bridge is packaged.

### 16.2 Other License Notes

- `discord.js` (Apache-2.0) — ✅ Commercial OK
- `grammy` (MIT) — ✅ Commercial OK
- `hono` (MIT) — ✅ Commercial OK
- `@whiskeysockets/baileys` (MIT) — ✅ Commercial OK, with `libsignal` replaced as above

---

## 17. Security Requirements

### 17.1 Critical (Must Have Before Any Production Use)

1. **Tool Sandbox:** No shell passthrough — a command with shell syntax runs under the system's `bash -lc`, and the gate classifies what is inside it. Command allowlist. Timeout + resource limits.
2. **Secret Management:** API keys in the secret store (`data/secrets.enc`, `0600`, encrypted at rest since 0.8.19 with a key kept as far from the data as the install allows: ARCHITECTURE §7) or env vars; config files hold only their names, and a credential an agent's commands were given — or the start of one — is masked wherever a command prints it. Never in config files or logs. Since 0.7.7 the daemon's own environment — where `.env` puts a value — is out of its commands' reach: non-dumpable on Linux, so `/proc/<pid>/environ` and `mem` are refused to a process of the same user, and the exec gate classes either path as credentials; a tool call's step text is redacted as its audit row is.
3. **Sender Verification:** Each gateway verifies sender identity. No unauthenticated tool exec.
4. **Input Sanitization:** User input never directly interpolated into shell commands.
5. **Prompt Injection Defense:** System prompt boundaries. User content clearly delimited.
6. **WhatsApp Credential Encryption:** Baileys session stored AES-256-GCM encrypted at rest.
7. **Dashboard Auth:** Argon2id password hashing. Rate-limited login. `SameSite=Lax` session cookies — and, since 0.7.10 (S9), a write to `/api/control` or `/llm-gateway` that the browser marks as another page's (`Sec-Fetch-Site` other than `same-origin` or `none`, or an `Origin` that is not the host addressed) is refused, a sibling subdomain included. A request with neither header is not a browser's, and goes on. The hosted gateway's own port signs nobody in once its dashboard is shown inside this one: keys only there.

### 17.2 Important (Before Commercial Release)

1. **Audit Logging:** All tool executions, approvals, config changes logged to SQLite with timestamp + actor.
2. **RBAC:** Dashboard users with admin/operator/viewer roles.
3. **Rate Limiting:** Per-sender message rate limits to prevent LLM abuse (see §10.1).
4. **Dependency Pinning:** Lockfile with integrity hashes. No floating versions.
5. **Error Handling:** No stack traces or internal paths leaked to chat users.
6. **LLM Cost Budget:** Daily cost and token caps with alerts (see §10.2).
7. **Sender Authorization:** Configurable allowlist of sender IDs per agent — only authorized senders can trigger tool execution.

### 17.3 Nice to Have

1. **E2E Encryption for inter-agent messages** (if multi-node deployment later)
2. **WAF/reverse proxy hardening** for web dashboard
3. **Automated dependency vulnerability scanning** (CI pipeline)

---

### 17.4 The fixed list — what always asks

Since 0.8.0 one setting decides what reaches a person, the approval level (`[security] approvals`, an agent's
`[agent] approvals`, a person's `/approvals`), over **one fixed list** of what always asks (SIMPLIFY RFC §1). A call
on the list is asked *allow once* only and never becomes a standing grant, through whichever tool makes it.
`careful` asks every entry, plus each new command or mutating tool once (*allow always* remembers it); `balanced`
asks only the entries marked ✔ below; `trusted` asks only `unwatched`, `shared-tools`, `persona` and `people`, which every level asks. The
four knobs that guessed at it before —
`[security.exec] mode`, `ask`, `ask_fallback`, `sensitive_paths` — and the editable allowlist are gone: a file that
still writes one starts with a warning naming it, and `mode = "deny" | "allowlist"`, `ask = "always"` and
`sensitive_paths = "hardline"` are refused at load, since dropping them would let more run unasked
(`config/global/gone-keys.ts`).

`nouride policy` prints this list from the running build, and `nouride policy check <command…>` runs
the real classifier against one command without executing it. `packages/policy/src/hardline.ts` and `own-cli.ts`
are the authority; everything below is a description of them.

| Class | `balanced` | What it covers |
|---|---|---|
| `config` | ✔ | A `config.toml` changed — the daemon's, the agent's own or another's: `nouride gateway`/`provider` add·set·rm, `agent enable\|disable`, `agent external\|internal` (whether a coding CLI answers an agent, 0.8.1), `memory set`, `setup`; `agent_create`, `agent_configure`; `write`/`edit` of a `.nouride` `config.toml` where agents run as the daemon; and a write to what every later prompt reads after outside content (S13). A pack's `skills.toml` and `mcp.toml` are not |
| `access` | ✔ | Someone given access, or a person's answer given for them: `nouride access` changes (`approve` with `--as`, `--me` or `--new` is `people`), `users reset`, `approvals <answer>`, `grants revoke`, `mcp-server on\|off\|token`, `mcp login\|logout`, `agent sleep\|wake` (a person's to set, 0.8.0). The CLI reads the admin token off disk, so an agent's answer to an approval was an operator's |
| `stop` | ✔ | This daemon stopped, killed or uninstalled: `nouride stop`, `service install\|uninstall`, `systemctl`/`service`/`launchctl` stop·disable·mask of a `nouride` unit, `kill`/`pkill`/`killall` naming it, `shutdown`/`halt`/`poweroff`. A restart is not |
| `secret` | ✔ | A stored secret replaced or deleted: `nouride secret set\|rm`, `secret_save` with `replace` |
| `credential-out` | ✔ | A credential leaving: a credential file sent off the machine (`credential-send.ts`), a command handed a secret it is bound to (S6), a credential sent in chat used after outside content (the secret guard) |
| `own-state` | ✔ | Where agents run as the daemon's user only: a command naming its state — `secrets.json`, `secrets.enc` and its key, `.control-token`, the agents directory (a `config.toml` under `.nouride/` is `config`, `nouride.db` is `database`). Where each agent is its own user, file permissions refuse these and nothing is asked |
| `replace` | | This daemon replaced: `nouride update --start`, the `update` tool's apply |
| `database` | | The daemon's database read or written: `nouride.db` (where agents run as the daemon), `nouride db restore\|adopt` |
| `delete` | | Deleted for good outside the workspace: `rm` by absolute path, `~`, glob or `..` — or over ssh or in a container, any path — and a recursive `rm` with no operand (under `xargs`); `dd`, `mkfs`, `shred`, `fdisk`; `docker volume rm`, `system prune`, `compose down -v`; `dropdb`, `dropuser`, `redis-cli FLUSHALL`; `find … -delete`; `crontab -r`; package removal. **Nothing bounded to `/tmp` or a `.scratchpad/`** — see below |
| `teardown` | | Infrastructure torn down: `terraform`/`tofu` destroy (and `apply -destroy`), `pulumi destroy`, `kubectl delete`, `helm uninstall\|delete`, `pct`/`qm`/`vzctl destroy`, `lxc`/`incus delete`. Creating and changing — `apply`, `scale`, `pct stop` — are not |
| `unattended` | | A job that runs unasked: `nouride cron add\|update\|enable`, `webhook add\|rotate`. A `--command` put in a job is classified as itself first, so one that would ask now asks when it is put there |
| `interactive` | | The `session` tool: `start`, and every `send` into a running program. When what is about to run or be typed has a more specific class, that class is reported instead |
| `force-push` | | A remote's history rewritten: `git push --force\|-f\|--force-with-lease\|--mirror`, `+ref`, `:ref`, `--delete` — to any branch. An ordinary push is not |
| `unwatched` | ✔ | Work nobody watches (0.8.0): a scheduled job's run sending with `send_message` anywhere but its job's chat, and what the second look held (`tools/second-look.ts`). Asked under `trusted` too: nobody is there to see it happen. *Always* to it allows that destination for that job's runs (`Job.allowed`), never the agent |
| `shared-tools` | ✔ | A program installed or updated for every agent, as the daemon's user (0.8.1): `nouride tools run -- <installer …>`. Its install scripts run as the user that owns every pack, the database and the secret store, so it is asked under `trusted` too, *allow once* only, and in a chat only an admin answers it (0.8.9). Through the `nouride` tool it is the orchestrator's alone, and only an installer runs (§7.1) |
| `system-packages` | ✔ | This machine's packages changed, as root, through `nouride-pkg` (0.8.15): `nouride pkg install\|remove\|upgrade`; `check`, `status` and `refresh` change nothing and are not on the list. *Allow once* only, and in a chat only an admin answers it. `trusted` does not ask: the agent says what it installs. The 0.8.0 list had left it out, and an agent at `balanced` changed packages unasked until 0.8.15 |
| `persona` | ✔ | An agent's own `SOUL.md`, `IDENTITY.md` or `AGENTS.md` changed, through the `persona` tool (0.8.8), or a folder added to or taken from its skill roots, through `skill_root` (0.8.24). Asked under `trusted` too, and answered in a chat by an admin only, in a one-to-one chat as well |
| `people` | ✔ | Who People says a person is, changed (0.8.9, N5): `nouride people set\|remove`, and `nouride access approve <code> --as <key>\|--me\|--new`, which puts the code's sender on a person (taking their id off whoever held it). A sender is an admin when the person holding their id holds an admin's dashboard account (`senderIsAdmin`), so a chat linked to an admin answers as one. Asked under `trusted` too; the class is stored with the approval row (`hardline_class`), and only an admin answers it — in a chat, in a one-to-one chat too, on the dashboard (an operator's account is refused) and never another agent's `nouride approvals` (`approval-answerers.ts`) |

The `nouride` tool runs the CLI as the daemon's user, so what it runs for the agent is classified as itself first:
the command after `nouride tools run --` or a cron `--command`, with the daemon's own state in reach, and otherwise
the verb's own class.

An elevation is on no list of its own: `sudo`, `su -c`, `doas`, `runuser`, `chroot`, `pkexec` are looked through,
and what they run decides. A credential path (`.ssh/`, `.env`, `.netrc`, `.gnupg/`, the credentials directory,
`/proc/*/environ`) is never an everyday command — `careful` asks it once, grantable — and what it prints is masked at
every level.

**Through a shell, over ssh, and through a wrapper.** A command inside `sh -c`, after `ssh <host>`,
after a container wrapper (`pct exec`, `lxc`/`incus exec`, `docker`/`podman exec`, `kubectl exec`,
`nsenter`), after a privilege wrapper (`sudo`, `runuser`, `chroot`, `pkexec`) or behind a prefix wrapper (`timeout`, `env`, `nohup`, `setsid`, `nice`, `ionice`,
`stdbuf`, `xargs`, `systemd-run`) is classified by what it would *run*, not by the program on the
command line. Without that the whole classifier was
one indirection away from irrelevant: `rm -rf /x` was refused while `sh -lc "rm -rf /x"` and
`ssh host "rm -rf /x"` both passed every rule. Neither is exotic — `exec` uses `bash -lc` for anything
with a pipe, `cron` wraps every `--command` in `sh -lc`, and on a homelab the machines worth breaking are
the remote ones. The payload is split on shell operators and each segment classified, bounded to
three levels of nesting. It is a heuristic, not a shell parser: quoting and `$()` can hide a command
from it.

**A turn stops waiting before it dies.** `approval_timeout_ms` bounds the *question*;
`max_turn_duration_ms` bounds the *turn*, and they are not the same clock. The turn holds back
a share of its own deadline (15%, between 20 and 60 seconds) so the model can report and carry on
rather than being aborted mid-call. When the turn stops waiting the row stays
`pending` — the operator's window is unchanged — and an answer that arrives after that wakes the
agent as a system event rather than releasing a promise nobody holds. A denial wakes it too; finding
out by trying again is how an agent argues with someone who has already answered.

**What each level answers by itself.** `balanced` (and `[cron] unattended_approval = "auto"`) answers every question
whose class is not in `BALANCED_ASKS` — the ✔ rows above — and every question with no class; `careful` answers none;
`trusted` answers all but `unwatched`, `shared-tools`, `persona` and `people` (`skipsApproval` in `packages/policy/src/approvals.ts`). That is only safe because an elevation is classified by what it elevates — `sudo systemctl stop
nouride` is `stop`, not an elevation — so a wrapper cannot carry one of `balanced`'s questions past it. Under `careful`
the daemon's own line under the fifth question of a day names `balanced` and where it is set, once a day per person,
and never `trusted` (`tools/careful-hint.ts`). A new install is `balanced`, the default in the code: setup writes
no level, and the agents it makes say `balanced` themselves. Until 0.8.34 setup's first write put `careful` in a new
install's file, and an install that has it there keeps it.

**An agent can clear up after itself: `.scratchpad/`.** A command every one of whose operands sits
inside a directory named `.scratchpad` is not hardline, wherever that directory is —
`.nouride/workspace/private/<agent>/.scratchpad/` here, `~/.scratchpad/` on a machine reached over ssh.
The turn that forced it: the agent screenshotted a Mac, sent the file, then tried to tidy up with
`ssh mac rm -f /tmp/screen.png` — an absolute-path delete, so on the list, so it stopped the turn dead
and the level that skips ordinary questions was not allowed to answer it. The gate was right about the command and wrong about the
situation.

"Is this file temporary?" cannot be answered from argv, so the question is turned around: one
directory is *declared* disposable, the harness creates it, and the prompt tells the agent to put
throwaway artefacts there. Ownership by construction rather than a heuristic on path names — and it
is matched on the directory **name**, because the scratchpad on the far side of an `ssh` is not a
path this machine could resolve.

The rule is about **operands, not programs**: `rm -rf`, `find … -delete`, `shred`, `truncate`, `mv`
and `chmod -R` are all ordinary inside a scratchpad, because none of them can reach past one. Gating
four verbs and exempting the fifth teaches only that the rule is arbitrary. What it does not relax:
*every* operand must be inside a scratchpad (`rm -rf /var/lib ~/.scratchpad/x` stays gated on the
half that reaches outside, `dd if=/dev/zero of=~/.scratchpad/x` on `/dev/zero`); a `..` anywhere
disqualifies it; a command with no operands is never exempt, which is what keeps `reboot` and
`crontab -r` where they are; privilege is classified first, so `sudo rm -rf ~/.scratchpad` is still
`privilege`; and the exemption downgrades hardline to an *ordinary command*, which still meets
`ask` and the ceiling. `find` is read by its grammar — its roots bound what it can walk, and only an
`-exec` payload can reach outside them, so that is checked separately.

**`/tmp` is disposable too, and that is the half that works on a machine we do not own.** A path
*under* `/tmp`, `/var/tmp`, their `/private/…` spellings, or a Mac's per-user `$TMPDIR`
(`/var/folders/…/T/`) qualifies exactly as a scratchpad path does. The scratchpad handled the daemon's
own box and changed nothing over ssh: on a live turn the agent wrote `screencapture -x
/tmp/screen.png` on a Mac, copied it back into its scratchpad correctly, and still needed a hardline
approval to delete the original — `$TMPDIR` does not cross an ssh, and the prompt line telling it to
use `~/.scratchpad` over there was read and ignored. The honest fix was not a louder instruction: every
convention on a Unix system already says a file in `/tmp` is disposable, it is cleared at reboot, and
gating deletes in it taught an operator to approve the same harmless `rm` repeatedly — which is how a
gate stops being read.

What stays gated is the distinction that matters: `/tmp` **itself** and a bare `/tmp/*`. A file under
`/tmp` is somebody's scratch; the directory is one the running system depends on, and a top-level glob
sweeps every socket and lock file every other process left there. `rm -rf /tmp/build` is tidying up,
`rm -rf /tmp/*` breaks software that is running right now. The residual risk is stated rather than
hidden: an operator who parked something they cared about in `/tmp` no longer gets asked about it —
`ask` and the ceiling still apply, the never-grantable floor does not.

**The agent does not have to cooperate for `$TMPDIR`.** A prompt can ask an agent to use the
scratchpad; the environment decides it. Every child process `exec` spawns gets `TMPDIR`/`TMP`/`TEMP`
pointing at the agent's scratchpad, so `mktemp`, Python's `tempfile`, `ffmpeg` and everything else
that asks the environment writes there by default instead of `/tmp` — which is exactly the
difference between an agent that can clean up after itself and one that has to ask. Files are swept
after `[retention] scratchpad_days` (3) rather than at the end of the turn, because the next message
is usually about the file that was just sent.

**What is deliberately *not* gated is part of the design, not an omission.** Reading anything;
simulating (`terraform plan`, `--dry-run`, `--check`); installing rather than removing; reversible
service work (`docker stop`, `compose down` without `-v`, `systemctl start`); ordinary file work
inside the workspace; and clearing out a `.scratchpad/` or a file under `/tmp`. A gate that fires on routine work is one an operator learns to click through,
and then it protects nothing — which is why an ordinary `git push` is not gated and `docker rm -f` is not gated at
all.

**With nobody to ask, a hardline command is refused rather than parked.** That is what an unattended
cron turn hits (§8.7). The one exception is an agent at the `trusted` level, whose calls run whether or not anybody
could be asked — all but `unwatched`, `shared-tools`, `persona` and `people`, which no level answers by itself.

## 18. Database Schema (SQLite)

The schema's one home is `apps/engine/src/db/migrations/`: `069_baseline.sql` folds every migration up to 69, the schema 0.8.0 left.
A database below 69 is one an older build left, and is refused (§14.2, "Upgrading the schema").
Migrations are applied in order and tracked by `PRAGMA user_version`; one applied anywhere is never edited, and a fingerprint of their text in `PRAGMA application_id` refuses to boot a database whose migrations differ from this build's.
SQLite is the database, not a stand-in for a portable one (TD-015): stores may use FTS5, recursive CTEs and JSON functions.

| Area | Tables |
|---|---|
| Conversations | `sessions` (one per agent per chat), `turn_records` (each turn and its reply), `events` (what each did as it ran, its steps among it), `turn_journal` and `inbox` (durable turns, below) |
| Rooms | `chat_messages`, `chat_rooms`, `chat_members`, `chat_events` (a room's timeline), `chat_attachments` (§7.6) |
| Tools and approvals | `approvals`, `exec_grants` and `tool_grants` (standing permissions), `auto_approve` (a person's approval level), `jobs` (background commands) |
| Scheduling | `cron_jobs`, `cron_runs` |
| Access and accounts | `sender_access` (pairing), `users`, `user_sessions`, `mcp_tokens` (other tools reaching memory, §12.3) |
| Memory index — a cache of the vault, rebuilt from it | `memory_episodes`, `memory_episode_agents`, `memory_episode_people`, `memory_episode_tags`, `memory_episode_related`, `memory_facts`, `memory_files`, `memory_groups`, `memory_tag_aliases`, `memory_fts` (FTS5) and `memory_fts_items` |
| Memory state — not cache | `memory_attempts`, `memory_changes`, `memory_pass_runs`, `memory_vectors` |
| Skill learning | `skill_drafts`, `skill_candidates`, `skill_reviews`, `skill_reads`, `rsi_tool_seen` |
| Accounting and logs | `llm_usage`, `audit_log`, `log_entries` |

The conversation, and the two tables that make a turn survive a restart (§14.2):

```sql
-- One per agent per chat. Its messages are `session_messages`.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                            -- ses_<agent>:<gateway instance>:<chat>
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  gateway TEXT NOT NULL,                          -- the gateway instance id
  context_token_count INTEGER NOT NULL DEFAULT 0,
  session_type TEXT NOT NULL DEFAULT 'main',      -- main | cron (§13.2)
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,          -- when this conversation began; /new resets it
  UNIQUE(agent_id, chat_id, gateway)
);

-- A conversation's messages, one row each (055). A save keeps the rows that did not change — compared
-- by `hash`, read without the message — and writes the rest: a turn writes what it added.
CREATE TABLE session_messages (
  session_id TEXT NOT NULL,                       -- sessions.id
  seq INTEGER NOT NULL,                           -- the order the model sees them in
  hash TEXT,                                      -- of `message`; NULL for rows moved from the old column
  message TEXT NOT NULL,                          -- one message, as JSON
  PRIMARY KEY (session_id, seq)
);

-- Every message of a running turn, in order. Folded into the conversation's messages when the turn
-- ends — however it ends — and deleted in the same transaction.
CREATE TABLE turn_journal (
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                           -- row 0 is the head: whose conversation, what kind of turn
  at INTEGER NOT NULL,
  entry TEXT NOT NULL,                            -- {head} | {message} | {started}, as JSON
  PRIMARY KEY (turn_id, seq)
) WITHOUT ROWID;

-- A message from a platform, written after admission and before anything acts on it.
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,                            -- <gatewayId>:<chatId>:<platform message id>
  gateway_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,                       -- the platform's own timestamp
  status TEXT NOT NULL,                           -- queued | placed | done | unanswered
  reason TEXT,                                    -- why unanswered: stale, dropped, interrupted
  envelope TEXT NOT NULL,                         -- what it takes to queue it again, as JSON
  settled_at INTEGER
);

-- turn_records.delivered_at: when the platform accepted the reply, NULL until then.
-- turn_records.retry_promised: 1 when the reply told its person the turn will be tried again, NULL otherwise.
-- turn_records.resume_asked_at: when its person was asked whether to carry on with a turn a restart cut off, NULL if never.
```

---

## 19. Project Structure

Where the code lives and what may import what is `ARCHITECTURE.md` §1 (the repository), §2 (the packages) and §4 (inside the engine); §3 is enforced by `lint:arch`.
An install's own layout — packs, data, memory, workspace, the agents' `bin` and `home` — is `ARCHITECTURE.md` §9, and a pack's files are in §4.1 above.

---

## 20. Global Config (`config.toml`)

Every key people change, with its default and what it does, is in `config.example.toml` at the repository root; a key left out takes the built-in default (`apps/engine/src/modules/config/defaults.ts`), so a partial file still boots.
`nouride config schema` prints every key as JSON Schema, and `nouride config explain <path>` explains one.

**Advanced keys** (0.8.0): thirty-six rarely-needed keys — shutdown and log formatting, every cooldown and code lifetime, `[llm.context]` but `compact_at_tokens` and `summary_model`, `[llm.streaming]`, `[queue]` but `max_concurrent_turns` and `steer`, `[cron]` but `enabled` and `unattended_approval`, `[nougate] port`, `[control]`, `credentials_dir`, the output and media byte limits, mention hops and wake chains — are left out of `config.example.toml` and kept behind "Advanced" in the dashboard. They work as written; the one list is `config/advanced.ts`, the docs' Configuration page carries them in its appendix, and the schema marks each `x-advanced`.

**Fixed values** (0.8.0): `[health]`, `[cron] tick_interval_ms`, `[queue] dedup_window_ms` and a gateway's `[resilience]` table are constants now (§5.5, §8, §10.1, §15). A file that still writes one loads; each is named in a warning and ignored.

**Unknown keys** are warned about and ignored — in `config.toml` by the merge, in a pack's `config.toml` by its loader (§4.2). A form an older release wrote and 0.8.0 stopped reading is refused instead, naming what replaced it (`docs/DEPLOY.md` § The upgrade window).

**Three model tiers** (0.8.0): `model`, `small_model` and `high_model` in `[llm.defaults]`, and in a pack's `[llm]` to override per agent. An unset tier is `model`; a pack without its own inherits the install's while it runs on the install's `provider`, and otherwise its tiers are its `model`. An agent picks one per piece of work it starts — `tier = "small" | "default" | "high"` on `delegate` and `ask_agent`, `default` when unsaid — and TOOLS names the three, what each is for and how they compare in cost, in words. A helper runs on the asking agent's model of the tier, an asked agent on its own. Each helper key — `[llm.context] summary_model`, `[memory] pass_model`, `[queue] steer_reply_model`, `[media] image_model`, `[skills.learning] model` — also takes a tier's name, resolved for each agent where it is used; helpers still default to each agent's own model, and no helper key was folded into a tier. `pass_model` naming a tier stands without `pass_provider`, which is refused beside one.
`nouride setup` writes the file to `.nouride/config.toml`; relative paths in it resolve against the install, not the working directory.

| Section | What it holds |
|---|---|
| `[daemon]` | name, log level, the install's directories (`data_dir`, `agents_dir`, `workspace_dir`), shutdown timeout, time zone, the orchestrator (who answers when nobody is named, and the front desk of rooms several bots share), pack backups kept |
| `[agents]` | mentions between agents and their hop budget, group behaviour (§4.3, §6.4) |
| `[providers.<name>]` | model provider profiles: wire format, base URL, credential name (§6.1) |
| `[security]`, `[security.access]`, `[security.exec]`, `[security.web]`, `[security.rate_limit]` | tool limits and the approval level, who may talk to the agents, what `exec` may run, the web tools, the per-sender rate limit (§7, §10, §17) |
| `[media]` | images and voice notes |
| `[jobs]` | background jobs |
| `[delegate]` | helpers in the background: how many one agent may run at once (§13.3) |
| `[alerts]` | where operator alerts go |
| `[dashboard]`, `[dashboard.oauth]` | the web dashboard and its sign-in (§11) |
| `[control]` | the control API the CLI and `nouride chat` use |
| `[gateways.<platform>.<name>]` | one connection per bot or number (§5) |
| `[llm.defaults]`, `[llm.limits]`, `[llm.streaming]`, `[llm.context]` | default model and its small and high tiers, budgets, streaming, the context window (§6, §10.2) |
| `[queue]` | the inbound queue, and steering a running turn (§10.1) |
| `[attachments]`, `[retention]` | attachment size; how long conversations, audit, logs, job logs, tool output and scratchpads are kept |
| `[rollover]` | when a conversation's context is cleared on its own |
| `[memory]`, `[memory.semantic]`, `[[people]]`, `[mcp_server]` | the vault and the nightly pass, search by meaning, who is who, memory for other tools (§12) |
| `[nougate]` | the LLM gateway the router editions run in-process |
| `[cron]` | the scheduler (§8) |
| `[skills]`, `[skills.learning]` | skills switched off for every agent; skill learning (§12.4) |
| `[missions]` | long work an agent finishes alone (0.8.0): how many run at once for one agent and on the box, and the hours, turns and tokens one works before it asks to continue (§13.5) |
| `[[external_clis]]` | coding CLIs added for external agents beside the two built in, Claude Code and Codex (0.8.1, §4.4); read at the next start |

---

## 21. Development Roadmap

The phases below are the original plan's scope, each item marked by whether it exists in the code.
What is open now, and what comes next, is planned in private documents the public export leaves out (`docs/README.md`).

**Read the phases as scope, not as sequence.** They were not built in order: the dashboard, MCP and
skills turned out to be what the work needed before WhatsApp and inline approval buttons did.

Legend: `[x]` built · `[~]` partly built, and the gap is named · `[ ]` not built.

### Phase 1 — MVP Core (Weekend Sprint)

- [x] Project scaffolding (Bun, TypeScript, SQLite, Hono)
- [x] Runtime adapters (`packages/runtime`) — Bun-specific isolation per TD-001, enforced by `lint:arch`
- [x] Agent loader (SOUL.md, IDENTITY.md, AGENTS.md, MEMORY.md, config.toml — USER.md retired in 0.7.0)
- [x] System prompt builder (§6.3) — deterministic assembly with priority ordering
- [x] Message router (mention-based + channel binding + orchestrator)
- [x] Message queue & backpressure (§10.1)
- [x] LLM executor (fetch-based, tool call loop with iteration cap)
- [x] Context window management — whole-turn sliding window (§6.4)
- [x] Streaming + typing indicators (§6.5)
- [x] Discord gateway (thread support, typing, chunked send)
- [x] Telegram gateway (typing, reply-to threading, HTML rendering)
- [x] Gateway reconnection & resilience (§5.5)
- [x] Basic hooks (`/new`, `/reset`, `/status`, `/stop`, `/start`)
- [x] Basic tools: read, write, edit, exec, web_search, web_fetch
- [x] Memory read/write tools (§12.1)
- [x] Session persistence — save/restore context across restarts (§14)
- [x] Structured JSON logging (§15.3)
- [x] Health endpoint (§15.1)

### Phase 2 — Security & Stability (Week 1-2)

- [x] Tool execution sandbox — argv without a shell unless the command uses shell syntax, which runs under the system's `bash -lc` and is classified inside (TD-010); hard timeout; output streamed to disk; `prlimit` memory and CPU ceilings wired into `exec`
- [~] Human-in-the-loop approval gate — the gate, the persisted queue, the dashboard view, the chat commands and the approval levels all work. **Inline chat buttons were never built**: approvals are answered by typing `/approve`
- [x] Sender authorization — pairing by default, per-agent and daemon allowlists, gateway-scoped ids
- [x] WhatsApp gateway — Baileys lives only in `packages/wa-bridge`, and the adapter in `@nouride/gateways` is a protocol client that imports none of it. Sessions are AES-256-GCM at rest, pairing is a QR served through the control API and rendered in the dashboard. Group mentions, quoted context, read receipts and typing are implemented. A number WhatsApp restricts from starting chats (error 463) cannot deliver replies, and that is surfaced as an operator alert
- [x] Cron scheduler — §8. Schedules, webhooks, payloads, delivery targets, run history, catch-up after downtime, auto-disable on repeated failure
- [x] Inter-agent messaging — **without a separate bus.** Agent-to-agent mentions use the ordinary message path in a room, with a hop budget that resets when a human speaks; `ask_agent` reaches a peer behind a one-to-one chat (§4.3)
- [x] Audit logging — every tool execution, approval, config change and cron action, with an actor
- [x] Graceful shutdown sequence (§14.1) — ordering is itself tested, because the ordering was the bug
- [x] Startup recovery (§14.2) — durable turns: every step journaled, a turn cut off by a crash closed with what it did, messages received during a restart answered, undelivered replies sent once; orphaned background jobs and interrupted cron runs reconciled
- [x] LLM cost tracking & daily budget (§10.2) — every model call metered through one seam, compaction, reflection, image reading, transcription and embeddings included, with its purpose and billing basis; `max_daily_cost_usd` covers the price book's models (a subscription profile's calls are included, not spent) and `max_daily_tokens` every call, and past either the work nobody waits on is not made. An unpriced model records `NULL` rather than a plausible number (invariant 4), and an estimated count is marked so (`llm_usage.estimated`, 0.7.10)
- [x] Rate limiting — per sender, after routing so unaddressed chatter costs nobody their budget
- [~] Attachment handling — inbound download, per-conversation scoping and retention sweep all work, and an agent can send a file out with `send_file`. A *tool result* cannot carry a file to the chat on its own; `send_file` is an explicit act
- [x] Error sanitization — `toUserMessage` for chat, everything in the log (§17.2)

### Phase 3 — Dashboard & Intelligence (Week 3-4)

- [x] Web dashboard — React 19 + Vite + TanStack + daisyUI (TD-009)
- [x] Dashboard: login, user management, RBAC (admin/operator/viewer) — more than one account in the editions that carry multi-user
- [x] Dashboard: agent config viewer/editor, enable/disable — an agent is the module: `/agents/<id>` holds its files, its model, its connections, its access rules, its skills and its external tools as tabbed routes
- [x] Dashboard: conversations — a web chat with any agent, and rooms with several, each with its timeline
- [x] Dashboard: cron job management UI — create, edit, run now, pause, delete, run history; webhooks beside it
- [x] Dashboard: approval queue (approve/deny from web)
- [x] Dashboard: gateway status & health, and gateway creation: Telegram, Discord and WhatsApp are configured from the browser, with credentials going to the secret store and only their names to `config.toml`
- [x] Dashboard: who may talk to an agent — the pairing queue is answerable from the browser
- [x] Dashboard: LLM usage stats — tokens and cost, with unpriced requests counted separately rather than shown as free
- [x] MCP client support (§7.4) — stdio and HTTP transports
- [x] Skills system — one pool every agent draws from, with per-agent exceptions; markdown instructions, optionally with support files; agents propose drafts a person approves (§12.4)
- [ ] Custom hooks with MCP integration — only the built-in slash commands exist (§9.3)
- [x] Config hot-reload (§14.3)
- [x] Subagent spawning (§13) — `delegate`, one level deep by construction
- [x] Heartbeat system (§15.2) — disk on an interval, alerted rather than only logged; gateway liveness and WAL size where they happen
- [x] Comprehensive test suite — `bun run test`

### Phase 4 — Commercial Prep

- [x] Baileys → process isolation or WhatsApp Business API migration — isolated as a module of its own, run in-process or as a separate service (§16.1)
- [x] Memory semantic search (§12.3)
- [x] Summary-based context truncation (§6.4) — `truncation_strategy = "summary"`, and it is the default
- [ ] Multi-tenant support (if SaaS model)
- [ ] Plugin/skill execution model (beyond markdown-only)
- [~] Voice message support (STT/TTS pipeline) — voice notes are heard natively or transcribed; there is no speech out
- [x] Documentation & onboarding guide — `GETTING_STARTED.md`, and `nouride setup` or the dashboard's setup for the rest
- [~] CI/CD pipeline with security scanning — `.github/workflows/ci.yml` runs `lint:check` and the suite on every push and pull request, and `release.yml` builds and publishes a tag. No security scanning
- [~] License audit & compliance — the one copyleft dependency, `libsignal`, is replaced by a shim, and a contract test fails if it returns; no audit of the rest
- [x] Performance benchmarking — measured figures live in `SYSTEM_REQUIREMENTS.md`

---

## 22. Open Questions

1. ~~**MCP Integration Depth:** Should Nouride be an MCP host (consume MCP servers) or also an MCP server (expose tools to external clients)? Or both?~~ **Resolved:** both. Nouride consumes MCP servers (§7.4), and serves memory and personas to other tools over MCP (`[mcp_server]`, §12.3).
2. ~~**Conversation Storage:** SQLite JSON column vs external store? For MVP, SQLite is fine. At scale, may need to shard or externalize.~~ **Resolved:** SQLite is the database (TD-015); a conversation is a `sessions` row and its `session_messages` — one JSON document per message since 0.7.12, so a turn writes what it added rather than the whole history.
3. **Multi-node Deployment:** Single process is the goal, but if scaling is needed later, what's the coordination strategy? (Probably out of scope for v1.)
4. ~~**Plugin System:** Should skills be executable (run code) or purely instructional (markdown prompts)? Starting with markdown-only is safer.~~ **Resolved:** skills are instructional; a skill may carry scripts, which an agent runs through `exec` under the same gate as any command.
5. **Voice/Audio:** Voice notes are heard (§5.2). Speech out (TTS) is not built, and whether to build it is open.
6. ~~**Embedding Model for Memory Search:** Which lightweight embedding model for §12.3?~~ **Resolved:** any provider profile with an OpenAI-style `/embeddings` endpoint, named in `[memory.semantic]` — a hosted model or a local one such as Ollama's.
7. **Dashboard Real-Time Updates:** WebSocket or SSE for live dashboard updates (agent status changes, new approvals, cron runs)? SSE simpler, WebSocket more flexible. **Partly resolved:** SSE. Since 0.7.4 the conversation view follows the event stream (`/api/control/events/stream`, [EVENTS.md](./EVENTS.md)); the other pages still poll.
