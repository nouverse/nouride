# Nouride — Technical Decisions

> Rationale log for architectural and stack choices.
> Each entry captures the decision, reasoning, alternatives considered, and security implications.

---

## TD-001: Bun-Native Runtime

**Status:** Accepted.

**Decision:** Target Bun as the sole runtime. Use Bun-native APIs (`Bun.serve()`, `Bun.spawn()`, `Bun.file()`, `bun:sqlite`) as primary building blocks.

**Reasoning:**
- Fastest path to MVP — built-in HTTP server, SQLite, test runner, process spawning.
- Minimal dependency footprint = smaller supply chain attack surface.
- `Bun.spawn()` defaults to no-shell, explicit env passing — security win over Node's `child_process`.
- `bun build --compile` produces one executable with the runtime inside, so a server needs no Bun install.

**Runtime Portability Discipline:**
Not "runtime agnostic" (no abstraction layer), but **runtime-portable by discipline**:
- All runtime-specific calls (`Bun.spawn()`, `Bun.file()`, `bun:sqlite`, `Bun.serve()`, `node:*`) are isolated into thin adapter modules in `packages/runtime/src/`.
- Business logic imports `@nouride/runtime`, never calls `Bun.*` directly — `lint:arch` enforces it (`ARCHITECTURE.md` §3).
- Switching runtime = rewrite adapter files only, zero business logic changes.

```
packages/runtime/src/
  ├── process.ts     # spawn/exec abstraction (wraps Bun.spawn), prlimit and nice
  ├── process-shell.ts # the system's shell, never one from PATH
  ├── fs.ts          # file I/O (wraps Bun.file / Bun.write)
  ├── db.ts          # SQLite (wraps bun:sqlite)
  ├── server.ts      # HTTP server (wraps Bun.serve)
  ├── crypto.ts      # hashing/random (wraps Bun.password, Bun.hash)
  └── …              # toml, yaml, tar, zip, compress, unix sockets
```

**Reference:** Nougate follows a similar pattern — `Bun.serve()` in `server.ts`, Drizzle for DB, but runtime calls are spread across modules. Nouride improves on this by centralizing all runtime-specific calls into one package.

**Alternatives rejected:**
- Node.js — slower startup, no native SQLite, heavier stdlib.
- Deno — smaller ecosystem for chat platform libraries (Baileys, discord.js).
- Rust — too slow for weekend MVP, WhatsApp still needs JS bridge.
- Full runtime-agnostic abstraction — unnecessary indirection tax for internal tool. Adapter isolation achieves portability without the abstraction overhead.

---

## TD-002: Hono for HTTP Layer

**Status:** Accepted.

**Decision:** Use Hono as the HTTP framework for all web-facing routes (dashboard, control API, webhooks, the MCP endpoint, health).

**Reasoning:**
- ~14KB, zero external dependencies — excellent supply chain profile.
- Bun adapter is first-class, zero polyfill overhead.
- Middleware chain pattern (auth → rate limit → validate → handler) is cleaner than rolling our own router.
- Future portability: if we ever deploy edge workers (Cloudflare), Hono runs there natively.

**Scope:** Hono handles HTTP only, on a server `@nouride/runtime` starts with `Bun.serve()`. Chat gateway connections (Discord WebSocket, Telegram long-poll, the WhatsApp bridge) are handled outside Hono.

**Reference:** Nougate uses raw `Bun.serve()` with a manual `handleRequest` dispatcher + `findHandler` pattern (see `router/index.ts`). This works but required building a custom middleware chain. Hono gives us that for free.

**Alternatives rejected:**
- Raw `Bun.serve()` — would end up reinventing Hono's router/middleware.
- Express/Fastify — heavier dependency trees, designed for Node.
- Elysia — Bun-specific but heavier API surface, less portable.

---

## TD-003: Monorepo Structure, Single Build Output

**Status:** Accepted.

**Decision:** Monorepo workspace layout during development, single compiled/bundled artifact for deployment.

**Reasoning:**
- Clean separation of concerns during development (gateway adapters, core engine, dashboard, CLI).
- Single deployable artifact (Docker image or binary) for operations simplicity.
- Follows Nougate's proven pattern: `apps/backend` + `apps/frontend` workspaces, single `Dockerfile` that builds frontend → installs backend deps → produces one image.

**Structure:** `apps/` are processes (`engine` — the daemon and its CLI — `dashboard`, `site`), `packages/` are libraries, and `internals/` holds the private submodules. The layout and what may import what are `ARCHITECTURE.md` §1–§3.

**Build:** `bun build --compile` produces one executable — engine, CLI, gateways and the WhatsApp bridge — shipped with the built dashboard beside it; the image runs the same build as one bundle on `oven/bun` at the version in `.bun-version`, through a multi-stage `Dockerfile` that mirrors Nougate's (`ARCHITECTURE.md` §10).

**Reference:** Nougate workspace layout: `apps/backend` (Bun + Drizzle), `apps/frontend` (React + Vite + TanStack Router + TailwindCSS + daisyUI). Root `package.json` with `"workspaces": ["apps/*"]`. Docker multi-stage produces one image serving both backend and static frontend assets.

---

## TD-004: LLM Providers — OpenAI-Compatible + Anthropic Only

**Status:** Accepted.

**Decision:** Support exactly two provider interfaces:
1. **OpenAI-compatible** — covers GPT, OpenRouter, Nougate proxy, any OpenAI-format endpoint.
2. **Anthropic native** — Messages API (`/v1/messages`), because the format differs from OpenAI.

**Reasoning:**
- These two formats cover 95%+ of LLM APIs in practice.
- OpenAI-compatible is the de facto standard; anything that speaks it works automatically.
- We already run Nougate as our LLM proxy — a provider profile can point its `base_url` at Nougate and get access to any provider Nougate supports, without Nouride needing to know about them.
- Zero OAuth provider flows (no Kiro, no Google OAuth, no device code). Bring your own API key, point to your own endpoint.

**Reference:** Nougate has full protocol translation (OpenAI↔Anthropic in both directions, `core/mappers/`), multi-provider registry, account rotation, and health scoring. Nouride doesn't need any of that — Nougate already handles it. Nouride just needs to speak the two API formats.

**Alternatives rejected:**
- LangChain/LangGraph — massive dependency tree, abstraction layer solving problems we don't have.
- Full provider registry à la Nougate — overkill; Nougate already sits in front.
- SDK packages (`openai`, `@anthropic-ai/sdk`) — unnecessary; raw `fetch()` with typed request/response is cleaner, fewer deps, fully auditable.

---

## TD-005: SQLite via `bun:sqlite` for All Persistent State

**Status:** Accepted; extended by TD-015.

**Decision:** Single SQLite database for all engine state: sessions and turns, the inbox, cron jobs, approval queue, audit log, user accounts, usage, and the memory index.

**Reasoning:**
- Zero external dependency — `bun:sqlite` is built into Bun.
- Single file, easy backup, easy migration, easy inspection.
- WAL mode for concurrent read/write without blocking.
- Sufficient for single-daemon architecture (no horizontal scaling needed).

**Reference:** Nougate supports both SQLite and Postgres via Drizzle ORM (dual schema in `schema/sqlite.ts` + `schema/pg.ts` with parity test). Nougate also uses JSON files for provider accounts/configs for hand-editability. Nouride simplifies: SQLite only, no ORM, no dual schema. Agent configs are md files (hand-editable), the memory vault is Markdown, everything else is SQLite.

**Alternatives rejected:**
- Postgres — overkill for single-daemon, adds external dependency.
- Drizzle ORM — adds dependency; raw `bun:sqlite` with prepared statements is sufficient and more auditable.
- JSON file storage — no query capability, no ACID, race condition prone for concurrent writes.

---

## TD-006: No External LLM SDKs — Raw `fetch()`

**Status:** Accepted.

**Decision:** Call LLM APIs directly via `fetch()`. No `openai` package, no `@anthropic-ai/sdk`.

**Reasoning:**
- Bun's native `fetch()` handles streaming (ReadableStream), headers, timeouts.
- Full control over request/response shaping — no SDK opinions on retry, timeout, error handling.
- Fewer dependencies = smaller attack surface.
- Request/response types are simple enough to define inline (~50 lines each for OpenAI and Anthropic formats).

**Tool call loop:**
```
User message
  → Build prompt (system + history + user)
  → fetch() to LLM
  → If tool_calls in response: execute tools → append results → re-submit
  → Loop until no more tool_calls or max iterations
  → Return final response
```

**Reference:** Nougate wraps `fetch()` in `core/provider-execute.ts` with retry logic, streaming transformers, and protocol mappers. Nouride's executor is simpler — single provider per agent, no rotation, no mapper (agent config specifies which format to use).

---

## TD-007: Gateway Adapters — Platform Libraries, a Module of Its Own for WhatsApp

**Status:** Accepted, amended — the WhatsApp bridge runs in the daemon's process, the one transport left.

**Decision:**
- **Discord:** `discord.js` — mature, well-maintained, WebSocket gateway built-in.
- **Telegram:** `grammy` (preferred over Telegraf) — TypeScript-first, lighter, active maintenance.
- **WhatsApp:** `@whiskeysockets/baileys` — **in a module of its own**, `packages/wa-bridge`, coupled to the engine by a protocol rather than by imports. Every edition compiles it in and runs it in-process.

**WhatsApp Isolation Rationale:**

1. **Licence:** Baileys is MIT. Its `libsignal` dependency is GPL-3.0, and is replaced by an MIT shim through `overrides` in the root `package.json`; a contract test fails if the real package returns (`packages/wa-bridge/README.md`).
2. **Dependency graph:** Baileys and its tree stay in one module that imports nothing from the engine but `@nouride/runtime`.
3. **A protocol boundary:** newline-delimited JSON with a versioned handshake, so a drift is a rejected connection. The transports that ran the bridge elsewhere are gone — `ws` in 0.7.10, `stdio` (a second executable) refused since 0.8.0 — so it shares the daemon's crash domain, the trade for not paying for a second Bun runtime (`ARCHITECTURE.md` §6).

**Message Normalization:** All gateways normalize inbound messages to a `MessageEnvelope` (`SPEC.md` §5.1):
```typescript
interface MessageEnvelope {
  id: string;
  gateway: "discord" | "telegram" | "whatsapp" | "web";
  gatewayId: string;                 // the connection: <platform>:<name>
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  replyTo?: string;
  timestamp: number;
  raw: unknown; // platform-specific payload, for gateway-specific features
}
```

**Reference:** Nougate doesn't handle chat gateways — it's purely an LLM proxy. This is new ground for Nouride. OpenClaw handles similar gateway normalization internally.

---

## TD-008: Agent Persona System — Markdown Files

**Status:** Accepted.

**Decision:** Each agent's identity is defined by markdown files in an `agents/<name>/` directory:

```
agents/
  ├── nox/
  │   ├── SOUL.md        # Personality, behavior rules, tone
  │   ├── IDENTITY.md    # Name, role, bio, emoji
  │   ├── AGENTS.md      # Awareness of other agents in the system
  │   ├── MEMORY.md      # The agent's own notes
  │   ├── config.toml    # LLM provider, model, channels, tools
  │   └── skills.toml    # Which pooled skills this agent has switched off
  ├── nouva/
  │   ├── ...
  └── skills/            # The skill pool every agent draws from
```

**Reasoning:**
- Human-readable, hand-editable, version-controllable.
- No database schema for identity — it's just files.
- Follows OpenClaw's proven pattern (SOUL.md, IDENTITY.md, AGENTS.md, MEMORY.md). Its `USER.md` was dropped in 0.7.0: one description of "the user", read whoever was speaking, is wrong for a household — who somebody is lives in `[[people]]`, said only when they speak.
- `config.toml` for structured settings (provider, model, channel bindings) — TOML over JSON/YAML for readability and comment support.

**Isolation:** Each agent loads only its own persona files. Inter-agent awareness comes only through AGENTS.md (which describes *what other agents exist and their roles*, not their internal state).

---

## TD-009: Dashboard — React + Vite + TanStack + daisyUI (Same as Nougate)

**Status:** Accepted.

**Decision:** Use the same frontend stack as Nougate: React 19 + Vite + TanStack Router + TanStack Query + TailwindCSS + daisyUI. Consistent tooling across Nouverse products.

**Reasoning:**
- Nougate's dashboard already uses this exact stack — proven, familiar, zero context-switching across Nouverse codebases.
- TanStack Router: type-safe file-based routing, clean code-splitting.
- TanStack Query: server state management, caching, optimistic updates for admin actions (agent management, cron status, approval flows).
- daisyUI: component library on top of Tailwind, consistent theming, dark mode out of the box.
- React 19: latest stable, server components ready if needed later.
- Vite: fast builds, HMR, clean production output.
- lucide-react: consistent icon set (same as Nougate).
- Monorepo workspace build → single Docker image (same pattern as Nougate).

**Alternatives rejected:**
- HTMX — too limited for dashboard interactions (real-time agent status, cron management, approval queues with optimistic UI).
- Preact — lighter but ecosystem gaps with TanStack.
- Vue/Svelte — different ecosystem, context-switching cost across Nouverse projects.

**Frontend dependencies:**
```
react, react-dom (19.x)
@tanstack/react-router
@tanstack/react-query
lucide-react
tailwindcss + daisyui
vite + @vitejs/plugin-react
@nouride/ui-graph (d3-force, d3-zoom…) — the Memory graph
```

**Auth:** Nouride's own, with no auth library: argon2id password hashing through `Bun.password`, opaque session tokens stored in SQLite. First boot generates random admin credentials printed to stdout. RBAC: admin (full control), operator (manage agents/cron, no user management), viewer (read-only dashboard). Nouverse sign-in (OIDC) is a plugin only the Pro editions carry.

**Security notes:**
- API calls via TanStack Query — centralized error/auth handling.
- CSP headers enforced by Hono backend serving the SPA static assets.
- Session cookie `HttpOnly`, `SameSite=Lax` — Lax rather than Strict so the first visit from a link keeps the session.
- Vite build output is static assets — no SSR attack surface.

---

## TD-010: Tool Execution Sandbox

**Status:** Accepted.

**Decision:** All tool execution goes through a controlled sandbox layer using `Bun.spawn()` with strict defaults.

**Security requirements (non-negotiable):**
1. **No shell by default** — `Bun.spawn()` takes an array, no shell interpretation. A command written with shell syntax runs under the *system's* `bash -lc` — never a shell from the agents' `PATH` — and the gate classifies what is inside it.
2. **An exec policy** — three approval levels (`careful`, `balanced`, `trusted`) over one fixed list of what always asks, a fixed set of everyday programs that never ask, and blocked patterns, per agent and per daemon (`SPEC.md` §17.4). Until 0.8.0 a ceiling (`full`, `allowlist`, `deny`) and an `ask` mode sat beside them; the levels said the same thing once.
3. **Timeout** — hard kill after configurable timeout (default 30s); longer work runs as a background job.
4. **Resource limits** — output streamed to disk and capped; `prlimit` memory and CPU ceilings where configured; `nice` for every command.
5. **Environment isolation** — explicit env vars only, no inherited process env; a credential reaches a command only by name, in `exec_secrets`, and is masked wherever it is printed.
6. **Working directory** — locked to agent's workspace, no path traversal. File tools reach only the agent's roots; credential files are read with their values hidden, and the daemon's own install — its binary, its shipped skills — is not the agents' to write.
7. **Human approval gate** — destructive/sensitive commands require human confirmation via chat. Pending approvals stored in SQLite with expiry.

What agents install goes where they can write it — `.nouride/bin`, `.nouride/opt` — by pointing each installer's own setting there, rather than by granting root (`SPEC.md` §7.1).

**Reference:** OpenClaw has a sophisticated approval system with elevated permissions, allow-once grants, and policy-filtered tool access. Nouride starts simpler but with the same security posture: default-deny, explicit allow.

---

## TD-011: Cron System — SQLite-Backed Job Scheduler

**Status:** Accepted.

**Decision:** Built-in cron scheduler with jobs stored in SQLite. No external scheduler dependency.

**Job types:**
- `at` — one-shot at absolute time.
- `every` — recurring interval (ms).
- `cron` — cron expression with timezone support.
- `webhook` — runs when its URL is called, not on a clock.

**Execution:** In-process timer checks due jobs every ~1s. Jobs can trigger:
- `systemEvent` — a message delivered as-is, with no model call.
- `agentTurn` — run agent with a prompt (for background tasks).
- `command` — a host command with no model, its output delivered or handed to one turn.

The job model is `SPEC.md` §8.

**Reference:** OpenClaw's cron system (same job types, SQLite-backed, delivery modes). Nouride mirrors the design.

---

## TD-012: Hooks System — Chat Commands with Lifecycle Actions

**Status:** Accepted, narrowed — the commands are built in; there are no custom hooks.

**Decision:** Slash commands in chat are answered by the harness, with no model call and outside the conversation's queue.

**Built-in hooks (the full list is `SPEC.md` §9.1):**
| Command | Action |
|---------|--------|
| `/new` | Start new conversation, filing the one so far into memory first. |
| `/reset` | Hard reset — as `/new`, plus expire pending approvals and reload config. |
| `/stop` | Pause agent (stops responding, stays connected) and cancel the turn in flight. |
| `/start` | Resume paused agent. |
| `/status` | Show agent status, model, uptime, what the conversation has cost. |
| `/model <name>` | Switch LLM model for current session. |
| `/approve [id]` | Approve pending tool execution. |
| `/deny [id]` | Deny pending tool execution. |

**Edge cases documented in SPEC.md:** concurrent calls, `/reset` while paused, pending approval expiry, `/new` with nothing to clear.

---

## TD-013: Inter-Agent Communication

**Status:** Revised — no message bus.

**Decision:** Agents reach each other through the paths a person's message already takes, never through a bus. They cannot read each other's internal state (memory, conversation history, config).

**Mechanism:**
- In a room, an agent addresses another by mention, and the message is routed like any other. A hop budget bounds a chain of agents answering each other, and a human speaking resets it.
- In a one-to-one chat, where a mention reaches nobody, `ask_agent` runs the peer's turn behind the chat — as the peer, with its own tools, memory and permissions — and returns its answer as a tool result. Since 0.7.19 an ask that takes longer than a minute moves to the background instead of holding the asking turn: the peer works on as a job of the asking agent's, and its answer wakes the asking agent in that chat.

**Security boundary:**
- No shared memory between agents.
- No access to another agent's SOUL/MEMORY/conversation.
- Every turn and tool call either side makes is in the audit trail.
- The hop budget prevents loops (`ARCHITECTURE.md` §12).

**Reference:** OpenClaw's `sessions_send` allows cross-session messaging with similar isolation guarantees.

---

## TD-014: Dependency Inventory & Supply Chain

**Status:** Accepted.

**The daemon's dependency list:**

| Package | Purpose | License | Risk |
|---------|---------|---------|------|
| `hono` | HTTP framework | MIT | Low — ~14KB, zero deps |
| `discord.js` | Discord gateway | Apache-2.0 | Medium — large dep tree (undici, ws) |
| `grammy` | Telegram gateway | MIT | Low — lightweight |
| `@whiskeysockets/baileys` | WhatsApp gateway | MIT | Medium — large dep tree, confined to `packages/wa-bridge`; its GPL `libsignal` replaced by an MIT shim |
| `whatsapp-rust-bridge` | the Signal protocol the `libsignal` shim forwards to | MIT | Low — published by the Baileys organisation, already a dependency of Baileys |

The dashboard's packages (TD-009) are compiled into static assets and never run in the daemon.

**Zero-dep alternatives used:**
- LLM calls → raw `fetch()`
- SQLite → `bun:sqlite` (built-in)
- Process exec → `Bun.spawn()` (built-in)
- File I/O → `Bun.file()` (built-in)
- Crypto → `Bun.password`, and `node:crypto` through `@nouride/runtime` (built-in)
- Dashboard auth → our own, on the two above
- Test → `bun:test` (built-in)

**Total external packages in the daemon: 5.** Highly auditable.

---

## TD-015: SQLite-Native

**Status:** Accepted.

**Decision:** SQLite is the database, not a stand-in for one. Stores may use any part of SQLite's
core (recursive CTEs, window functions, JSON functions, `RETURNING`, partial and expression indexes,
`WITHOUT ROWID`, `BLOB`) and FTS5. Loadable extensions are not used.

**Reasoning:**
- A single-binary, single-writer appliance. Running several instances is the one thing that would
  force a second engine, and nothing plans it. The store/`Port` seam still holds if that day
  comes.
- The portability rule had a measured cost: 48.5 MB of a 76 MB database was a hand-written inverted
  index that FTS5 stores in 4.3 MB.

**Guardrails:**
1. Boot refuses a SQLite without FTS5 or older than 3.43, by name, before any migration runs.
2. No loadable extensions. They would put files beside the binary, the system SQLite on macOS
   compiles `load_extension` out, and loading code at runtime is an attack surface.
3. Tables that hold the only copy of something change shape only for a measured reason. Caches,
   like the memory index, may be dropped and rebuilt freely.
4. `lint:sql` checks that SQL is fast and safe, not that it is portable.

**Alternatives rejected:**
- Keeping portable SQL: the cost above.
- `sqlite-vec`: an extension, and brute-force int8 over a household's vectors takes about 2 ms.
- A C tokenizer for Indonesian: an extension; the TypeScript stemmer fills a `roots` column instead.

**Reference:** the measurements are in the 0.7.0 release notes (`releases/v0.7.0.md`), and the reasoning beside the code — `memory_fts` in `069_baseline.sql`, `modules/memory/memory-fts.store.ts`, `scripts/check-sql.ts`.

---

## Appendix: Nougate Reference Summary

Key patterns borrowed or referenced from Nougate (`nouverse/nougate`):

1. **Monorepo workspace** — `apps/backend` + `apps/frontend`, root `package.json` with workspaces.
2. **Docker multi-stage build** — frontend build → backend deps → slim runtime image.
3. **Single data directory** — all runtime state under one directory (`.nouride/data` here).
4. **Provider as interface** — `IProvider` contract with capability detection (not name matching).
5. **Protocol normalization** — all inputs normalized to common format before processing.
6. **Auth separation** — dashboard auth (session cookies) vs API auth (API keys) are independent systems.
7. **Metrics non-blocking** — buffer in memory, batch-insert on timer.
8. **Atomic file writes** — temp + rename for credential/config files.

Nouride is not a fork of Nougate. It solves a different problem (multi-agent chat harness vs LLM proxy). But it inherits proven operational patterns.
