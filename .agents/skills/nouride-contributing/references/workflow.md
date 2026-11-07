# Working on this repo

---

## Running

```bash
bun install

./run-dev.sh              # dev container: engine + dashboard, both watching
./run-dev.sh native       # same thing on the host, no Docker
./run-dev.sh logs         # tail
./run-dev.sh down         # tear down container and volumes

bun run start             # engine only, no watching
bun run dev               # engine, bun --watch
bun run dev:dashboard     # vite on :18255, proxying /api to the engine
bun run build:dashboard
```

- Engine + API → `http://localhost:18254`
- Dashboard → `http://localhost:18254/dashboard/`
- Health → `http://localhost:18254/health`

`run-dev.sh` creates `.nouride/config.toml` from `config.example.toml` and `.env` from
`.env.example` on first run. The daemon boots on built-in defaults with no config file at
all, so those are conveniences, not requirements.

### The dev container polls; it does not watch

`scripts/dev-watch.sh` compares mtimes every two seconds and restarts the engine or
rebuilds the dashboard.

This is not laziness. **A bind mount from a macOS host shows edited file contents but
delivers no inotify events into the Linux VM**, so `bun --watch` and `inotifywait` both sit
there silently — you edit, nothing happens, and nothing says why. Verified on this machine:
the container saw the new bytes via `stat` while no watcher fired. Polling a few dozen files
costs nothing and behaves the same on every host.

Restarts go through SIGTERM, so every dev reload also exercises the graceful shutdown path.

### `node_modules` are named volumes, not bind mounts

Bun (1.4.4, `.bun-version`) uses the **isolated linker**: the root `node_modules` holds the package store under
`.bun/`, and every workspace member gets its own `node_modules` of relative symlinks into
it. There is no `node_modules/@nouride/` directory at the root at all.

Two consequences:

- The dev compose file gives each workspace member its own named volume. A host install is
  macOS/arm binaries and a container install is Linux; sharing either through a bind mount
  breaks whichever ran second.
- The Dockerfile copies **the whole deps stage** (`COPY --from=deps /app/ ./`), not just the
  root `node_modules`. Copying only the root produced
  `Cannot find module '@nouride/gateways'`. Enumerating each member's `node_modules` works
  until a package gains or loses its first dependency, and enumerating manifests in the deps
  stage goes stale the moment a package is added — which it did.

---

## Testing

```bash
bun run test                           # everything — never spell the sweep out by hand
bun test ./packages/llm/               # one package
bun test ./apps/engine/tests/pipeline/pipeline.test.ts
bun test ./apps/engine/ -t "silences"  # by name
```

`bun run test` is the sweep because of what it leaves out: `internals/nougate` is its own product with its
own suite, and `bun test ./internals/` by hand runs it under this repo's setup, where it fails for reasons
that are not this change's.

**The `./` and trailing `/` matter.** `bun test` treats arguments as path *filters*, not
directories. `bun test apps packages` also matches `internals/nougate/apps/backend/...` — the
Nougate submodule — and runs its suite. `./apps/` does not.

### Conventions

- **Prove the test catches the bug.** Break the fix, watch it fail, restore it.
- **Test the path the default config takes.** `llm.streaming.enabled` is true by default, so
  a provider double must return **SSE**, not JSON. A JSON double made the stream parser find
  no events and produce an empty answer that no assertion noticed until the E2E test.
- **Inject, do not monkey-patch.** `HttpDeps` takes `fetchImpl` and `sleep`; `SecretStore.open`
  takes an env object; `ProviderRegistry` takes `HttpDeps`; `KeyedQueue` takes `now`. Tests
  never touch the network and never wait out a backoff.
- **Drive the real pipeline.** `apps/engine/tests/pipeline/pipeline.test.ts` pushes an envelope through
  the actual router, queue, hooks, prompt builder, tool loop, sandbox, SQLite store and wire
  mapping, with only the network and the chat platform faked. Two of Phase 1's worst bugs —
  a paused agent being unroutable, and `drain()` used as "wait for idle" — were invisible to
  unit tests and obvious here.
- **Isolate state.** `mkdtempSync` for `agentsDir` and `dataDir`, removed in `afterEach`.
  Never point a test at the repo's real `.nouride/data/`.
- **`await expect(promise).rejects.toThrow()`** — never `expect(await fn()).rejects`.

`apps/engine/tests/helpers.ts` has `FakeGateway` (implements the real `Gateway` interface),
`scriptedOpenAI` (SSE, in order), `writeAgentPack`, `envelope` and `tempDir`.

**When turns run at once, answer by who is asking, not in order.** `scriptedOpenAI` answers the n-th request
with the n-th turn, which is right for one conversation and wrong the moment a helper in the background, a
person's second message and a wake-up interleave — the order is the scheduler's, not the test's.
`tests/pipeline/background-helpers.test.ts` has a provider that reads each request (a helper's system prompt
says it is one, its brief names its goal; a wake-up opens `[System event`; a wrap-up is not streamed) and
answers accordingly, with a gate per helper the test opens when it wants that helper to finish. That is how
"the turn ends before the helper does, the person is answered meanwhile, the report arrives by itself" and
"two helpers, no barrier" are asserted rather than slept on. `tests/pipeline/background-asks.test.ts` does the same
for an ask that moves to the background (0.7.19), each agent known by the `(agent id: …)` its prompt names, with the
ask's wait (`waitMs`) short enough to sit through.

---

## Talking to the daemon without a bot token

Nothing reaches an agent unless a gateway delivers it — so with no Telegram or Discord token you
talk to the daemon through its own local connection, which every install has (`[control] chat`):

```bash
nouride chat                       # the orchestrator, or the only one running
nouride chat nox                   # a specific agent
printf 'hello\n/quit\n' | nouride chat     # scripted: approvals are printed, not prompted
```

The dashboard's chat is the same connection. From a script, `POST /api/control/chat/send` with the
control token (`x-nouride-token`, from `.nouride/data/.control-token`) sends one message without waiting, and
`GET /api/control/sessions/<id>/live` reads the turn back as it runs — what the dashboard does.

It is a real `LocalGateway` registered like any other, so an injected message travels the
identical path — allowlist, routing, hooks, queue, prompt assembly, tool loop, session. A
shortcut into the executor would verify a path nobody runs.

`/prompt` returns the exact system prompt the agent is running with — the fastest way to see why
an agent is behaving oddly. DM only, because it contains SOUL and MEMORY.

> An earlier version of this page described `[dashboard] dev_message_endpoint` and `POST /api/dev/message`.
> Neither exists (D13): the local connection and the control API replaced them.

---

## Live testing against a real endpoint

Sometimes the wire format has to be checked against the actual upstream — a proxy's
response shape is not something a fixture can tell you. Two real findings came from this:
Nougate omits `usage` entirely, and its model ids carry an `antigravity:` prefix that made
every context-window lookup fall back to the 32k default.

Rules:

- Script goes in a scratch directory *inside a workspace member* (`apps/engine/tmp/`), so
  `@nouride/*` resolves — the isolated linker means the repo root cannot import them. Delete
  the directory afterwards.
- **Key comes from the environment on the command line**, never written into a file:
  `NOUGATE="sk-…" bun run apps/engine/tmp/live.ts`.
- **Never paste a real credential into a test fixture**, not even truncated. A prefix of a
  live key was once used as a "looks like a credential" example in
  `packages/secrets/tests/secrets.test.ts`; fixtures use obvious placeholders
  (`sk-EXAMPLE-not-a-real-key-000000`).
- Grep before you finish: `grep -rl "<key prefix>" --exclude-dir=node_modules --exclude-dir=.git .`
- A key that has been pasted into a chat or a terminal transcript should be rotated. Say so.

---

## Confirming your change is actually running

```bash
docker compose -f docker-compose.dev.yml logs --since 60s | grep -iE "rebuilt|restarting|error|ready"
```

The dashboard is built **inside** the container, so its bundle hash will not match a local
build. That is normal. A missing "Dashboard rebuilt" or "Engine change detected" line is
not — it means you are still looking at the previous build, however clean your local
typecheck was.

The engine logs JSON lines. `log_pretty = true` in `[daemon]` (or `LOG_LEVEL=debug`) makes
them readable while you work.

---

## Git hygiene

- Commit only when asked.
- `.nouride/` is entirely gitignored: `config.toml`, and `data/` with SQLite, `secrets.json`
  and attachments. Nothing in it should ever appear in a diff.
- `internals/nougate` is a submodule and its own product. Its suite is not ours to fix — just
  keep test filters from reaching into it, which `bun run test` does. lint:seams compiles its backend, so a checkout
  with it installs that the way CI does: `bun install --frozen-lockfile` in `internals/nougate/apps/backend`. Frozen
  takes what its lockfile pins and writes nothing; a plain `bun install` rewrites version lines in that lockfile, which
  is its repository's to refresh, not ours.
- `apps/dashboard/src/routeTree.gen.ts` is generated and gitignored. The build's Vite plugin writes it, and so do
  `mount.test.ts`, lint:deadcode and lint:types, through `apps/dashboard/scripts/routes.ts` — a fresh worktree needs no
  build first.
- `docs/SPEC.md`, `docs/TECH_DECISION.md` and `docs/ARCHITECTURE.md` are living documents. If a
  change makes one of them wrong, update it in the same pass — a stale invariant is worse
  than an undocumented one. The same applies to this skill: if you hit a bug that an
  invariant would have prevented, add it.
- **Edit skills in `.agents/skills/`.** `.claude/skills/` is a symlink to it for tooling that
  looks there, and `bun run lint:skills` (part of `lint:check`) fails if the link is ever
  replaced by a real directory or a plain file.

---

## Things that have actually gone wrong here

| Symptom | Cause |
|---|---|
| Dashboard rendered blank, no console error worth reading | Hono drops `Content-Type` when `c.header()` runs after `await next()`; with `nosniff`, the browser refused the CSS and JS |
| `Cannot find module '@nouride/gateways'` in Docker only | copied the root `node_modules`; Bun's isolated linker keeps a `node_modules` per workspace member |
| Docker build broke the moment a package was added | deps stage enumerated each manifest by hand |
| Edits in the dev container did nothing, silently | inotify events do not cross a macOS bind mount |
| Second and later messages in a test vanished | `drain()` is one-way; used as "wait for idle", it left the queue refusing work |
| `/start` could never resume a stopped agent | the router matched `active()`, which excludes paused agents, so the command had no recipient |
| Cost cap never tripped | provider reported no `usage`; zero was recorded as fact |
| 200k-context model trimmed as if it had 32k | model id carried a proxy prefix, so no pattern matched |
| A test asserted a reply and got `undefined` | the double returned JSON while the default config streams |
| A fragment of a live API key sat in a committed test | used as a "this looks like a credential" example |
| Example agent pack failed to load after a schema change | `[channels]` keys became gateway instance ids; the template was not updated with the parser |
| Credentials never reached the container | compose enumerated `NOUGATE_API_KEY`, `TELEGRAM_BOT_TOKEN` — names from before secrets were named in config, which cannot be enumerated |
| Slash commands did nothing in group chats | you must address the agent to be routed (`nouva: /new`), and the parser only accepted text starting with `/` |
| The bot answered "Please slow down." in channels it was never addressed in | rate limiting ran before routing, so unaddressed chatter both burned the sender's budget and drew a reply |
| An agent saw its own name at the start of every message | `stripAddressPrefix` was written and never called |
| A security setting did nothing | per-agent `sender_allowlist` was parsed, documented, and never checked |
| Session JSON grew for the life of a chat | `max_conversation_turns` was parsed and enforced nowhere |
| An agent promised to run `exec`, was refused every time, and looked broken | nothing told it the approval gate did not exist |
| Docker became unreachable after a security fix | binding `127.0.0.1` *inside* a container defeats `-p` — the port forward reaches the container's interface, not its loopback. The image sets `HOST=0.0.0.0`; the default stays loopback for native runs |
| `/stop` could not stop anything | `cancelTurn()` was written and never called — the feature existed in the diff and not in the behaviour |
| `/health` blamed the provider for a bad agent config | every turn failure incremented the provider counter, not just `LLMError` |

The pattern behind most of them: **a value trusted where it should have been checked, or a
default that hid a failure instead of surfacing it.**
