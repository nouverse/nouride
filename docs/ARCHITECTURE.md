# Nouride — Architecture

> How the code is laid out, which module may import which, and how it runs in dev and prod.
> `SPEC.md` says *what* Nouride does. `TECH_DECISION.md` says *why* the stack was chosen.
> This document says *where things live and what talks to what*.

---

## 1. Repository Layout

Monorepo (Bun workspaces) during development, one image for deployment — per TD-003.

```
nouride/
├── apps/
│   ├── engine/                 # @nouride/engine    — the daemon (the one resident process; MCP servers and coding CLIs are its children, §8)
│   ├── dashboard/              # @nouride/dashboard — React SPA, built to static assets
│   └── site/                   # @nouride/site      — the public website: landing + the manual
├── internals/                  # two private git submodules — not needed for the free edition (§2)
│   ├── pro/                    # nouride-pro: appliance, multi-user, Nouverse sign-in, the private build
│   └── nougate/                # the LLM gateway, bundled into the router editions
├── packages/
│   ├── shared/                 # @nouride/shared    — types, envelope, logger, errors, ids
│   ├── runtime/                # @nouride/runtime   — the ONLY place `Bun.*`/`node:*` is used (TD-001)
│   ├── llm/                    # @nouride/llm       — OpenAI + Anthropic clients, SSE, tokens, cost
│   ├── queue/                  # @nouride/queue     — keyed work queue: ordered per key, parallel across
│   ├── persona/                # @nouride/persona   — agent pack loader (markdown + config.toml)
│   ├── secrets/                # @nouride/secrets   — named credentials: env, or a writable store
│   ├── policy/                 # @nouride/policy    — the exec decision: the fixed list, grants, approval levels
│   ├── mcp/                    # @nouride/mcp       — MCP client: protocol, stdio and HTTP transports
│   ├── acp/                    # @nouride/acp       — ACP both ways: a coding CLI driven as client, agents served to an editor
│   ├── isolation/              # @nouride/isolation — each agent's commands as its own user: the root helper nouride-run (§8)
│   ├── gateways/               # @nouride/gateways  — Discord / Telegram / WhatsApp adapters
│   ├── update/                 # nouride-update     — download, verify and swap a release
│   ├── system-packages/        # nouride-system-packages — `nouride pkg`, and its root service
│   ├── wa-bridge/              # nouride-wa-bridge  — the WhatsApp/Baileys bridge, MIT (§6)
│   ├── wire/                   # @nouride/wire      — the control API's payload types, types only (§3)
│   └── ui-graph/               # @nouride/ui-graph  — the dashboard's graph canvas (§3)
├── content/                    # what a human edits, not what runs (§1.1)
│   ├── agents/                 # persona pack template — copied, never shipped
│   └── skills/                 # skills that SHIP with the daemon — the `builtin` scope
├── .nouride/                    # a local install — config, data, agents, workspace (gitignored, §9)
├── scripts/
│   ├── check-*.ts              # the lints: arch (§3), sql, size, skills link, cli help, dead code, public tree, types
│   ├── build-binary.ts, build/ # the single binary and its editions (§10)
│   ├── install.sh              # the native install, and the root launcher on PATH
│   └── dev-watch.sh            # dev container supervisor (§8)
├── .agents/skills/             # coding-agent skills: contributing, testing, UI kit; links to the private ones
├── .claude/skills/             # symlink to .agents/skills
├── config.example.toml         # template → copy to .nouride/config.toml
├── run-dev.sh                  # one-command local dev
├── Dockerfile                  # multi-stage → single image
├── docker-compose.dev.yml      # dev: source-mounted, watch mode
├── docker-compose.yml          # local build + run
└── docker-compose.prod.yml     # pull published image
```

`apps/*` are processes. `packages/*` are libraries with no side effects on import. `internals/*` are
private repositories the commercial editions link in, and the free edition does without (§3).
`content/*` is neither: it is material a human edits — Markdown, TOML, LaTeX — that no build step
compiles.

**`content/` is a navigation grouping, not a build one, and its two children are not alike.**
`content/skills` ships: the Dockerfile and the tarball both carry it, flattened to `skills/`, and the
daemon loads it at runtime. `content/agents` does not ship at all — it is a template an operator
copies, read by one test that keeps it parsing. Grouping them says only that neither is code.

### 1.1 Three kinds of skill, and why they are not one kind

A skill is a directory holding `SKILL.md`. Three scopes load them at runtime, and the two directories
named `skills` in the tree above are for **different audiences** — worth stating plainly, because a
skill under `.agents/skills/` and `content/skills/document-authoring` look identical and are not.

| Scope | Where | Who it is for | Default |
|---|---|---|---|
| — | `.agents/skills/` (`.claude/skills/` links to it) | the coding agent working **on** Nouride | n/a — never loaded at runtime |
| `shared` | `.nouride/agents/skills/` | every agent this daemon runs | **on**, minus `skills.toml` |
| `builtin` | `content/skills/` in the repo, `skills/` in an install | every agent this daemon runs | **on**, minus `skills.toml` |
| `project` | `<root>/.agents/skills/` | agents with that root in `skill_roots` | on for named roots |

Precedence when two use one name, highest first: `shared`, `builtin`, `project`. The operator's pool
beats what ships; what ships beats what a working directory offers.

**One pool, switched per agent.** There used to be a fourth scope — `local`, an agent's own
`agents/<id>/skills/` — and removing it is the point. A procedure worked out once by one agent was
invisible to the others, so the same thing got re-derived and re-written per pack, and `shared` needed
an opt-in list nobody maintained. Now every skill lives in `agents/skills/`, every agent is offered all
of it, and a pack carries **only exceptions** in `agents/<id>/skills.toml`:

```toml
[skills]
document-authoring = false      # off for this agent, on for the others
```

**Default-on, and the switch is a map of decisions.** An opt-in list has to be rewritten in full on
every toggle and cannot name a skill that does not exist yet, so every skill added later — by an
upgrade, by an operator, by an agent writing one down — would arrive switched off on any install that
had ever touched the list, with nothing to say why. A map also keeps `false` and *absent* distinct, so
the dashboard can tell "on by default" from "on because somebody chose it".

Three things write that file and nothing else does: the **Skills Workshop** (`/skills` in the
dashboard), the agent's own `skill_toggle` tool, and a hand edit. It is deliberately not a table in
`config.toml` — a botched write costs a skill, not a booting agent.

**`builtin` ships rather than seeds.** Copying these into the pool at first run would be less code and
is the wrong shape: a seeded copy becomes the operator's the moment it lands, so a bug in a skill we
wrote would live forever on every install, and re-seeding to fix it would clobber whatever they had
changed. Shipping them read-only means an upgrade updates them, and an operator who wants one to
behave differently copies it into `agents/skills/`, where the pool outranks `builtin` and the copy
simply wins. The switch does not care which scope a skill came from — one name, one answer.

**`requires:` names host software, and gates nothing.** A skill may declare `requires: dot,
playwright` in its frontmatter. Those names are probed against `PATH` and surfaced in the Workshop,
in `nouride skills`, and by `nouride doctor` — but a skill whose program is missing still loads, because
the alternative is an agent that silently does not know how to do something and an operator with
nothing to read.

**Their descriptions are carried in every prompt.** Only the frontmatter loads at boot; the body is
read on demand when a task matches (§6.3 SPEC). That makes the body nearly free and the description
not, so keep the pool small and the descriptions short — with default-on, a description is a line in
*every* agent's prompt.

### Why `site` and not `docs`

It was `apps/docs`, and that named one section of it. The thing is the public website — the front
page, the install, the manual, and whatever pricing or product pages a release needs — and the
manual is one part, the way `src/modules/web/` is one module inside `engine`.

The clash was the stronger reason. `docs/` at the root of this repository is the engineering
documentation: this file, SPEC, DEPLOY, TECH_DECISION. So "docs" pointed at two different
audiences, and every path written from memory needed a beat of thought first. Now `docs/` is for
whoever works on Nouride and `apps/site/` is for whoever uses it.

The three apps read as one sentence: `engine` does the work, `dashboard` is what you log into,
`site` is what anyone may read.

---

### Why `engine` and not `backend`

Nougate's `apps/backend` is an HTTP service — "backend" describes it accurately. Nouride's
daemon is mostly *not* HTTP: it holds gateway sockets, an agent registry, a cron ticker and a
tool sandbox, and happens to also expose an HTTP surface. `engine` names the thing; the HTTP
layer is one module inside it (`src/modules/web/`).

---

## 2. Package Naming

| Directory | Package name | Published |
|---|---|---|
| *(root)* | `@nouverse/nouride` | no (private workspace root) |
| `apps/engine` | `@nouride/engine` | no |
| `apps/dashboard` | `@nouride/dashboard` | no |
| `apps/site` | `@nouride/site` | no |
| `packages/shared` | `@nouride/shared` | no |
| `packages/runtime` | `@nouride/runtime` | no |
| `packages/llm` | `@nouride/llm` | no |
| `packages/queue` | `@nouride/queue` | no |
| `packages/persona` | `@nouride/persona` | no |
| `packages/secrets` | `@nouride/secrets` | no |
| `packages/gateways` | `@nouride/gateways` | no |
| `packages/policy` | `@nouride/policy` | no |
| `packages/mcp` | `@nouride/mcp` | no |
| `packages/acp` | `@nouride/acp` | no |
| `packages/isolation` | `@nouride/isolation` | no |
| `packages/ui-graph` | `@nouride/ui-graph` | no |
| `packages/wire` | `@nouride/wire` | no |
| `packages/update` | `nouride-update` | no |
| `packages/system-packages` | `nouride-system-packages` | no |
| `packages/wa-bridge` | `nouride-wa-bridge` | no — MIT, see `packages/wa-bridge/README.md` (§6) |
| `internals/nougate` | `@nouverse/nougate` | separately — its own repo, its own release |

**`internals/` holds two git submodules, both private:** `internals/pro` (`nouverse/nouride-pro` —
appliance, multi-user, oauth, build-pro and the internal docs, a workspace of its own with its own
lockfile) and `internals/nougate`. Neither is needed for the free edition: a clone without them builds
and tests it. With access:

```sh
git clone --recurse-submodules …            # or, in a clone that already exists:
git submodule update --init
cd internals/pro && bun install             # only to build the setup console or run its tests
```

The open parts that every edition carries — `packages/update`, `packages/system-packages`,
`packages/wa-bridge` — are ordinary workspace members, not submodules.

`internals/nougate` is the LLM gateway this daemon talks to, and it is here for the build rather than
because it is a nouride component — nouride *consumes* it over HTTP like any other provider. Its
tests are excluded from `bun run test` for that reason: it has its own root, its own tsconfig and its
own `bun run test`, and running them from here fails on paths that are correct in their own repo.

**The bridge is always compiled in; the gateway is in Router and Pro.** Every edition carries
the WhatsApp bridge in-process (§6). The LLM gateway is otherwise a separate service reached over
HTTP, and Router and Pro compile it into this binary and run it inside, on `18256` — Router by default,
Pro when `[nougate] in_process = true` says so:

| build | what it carries |
|---|---|
| `build:binary` | the bridge, in-process |
| `build:binary --router` (and the private `build:pro --pro`) | + the gateway, on `18256` |

The reason is measured: a second *process* pays for a second Bun runtime — ~36 MB of shared pages
plus ~14.5 MB of private heap — while a second *listener* or a second module pays neither.

The reason not to is one crash domain. A bug in a provider adapter or a WhatsApp reconnect is then
one stack frame from the agent loop.

Each build asserts its own artefact actually contains what the flag promised, because a dynamic
import of an unresolved specifier fails at runtime rather than at build time; the checks look for
`md-app-state` and `nougate.db`.

**Brand assets live in `packages/shared/assets`, and every surface reads that one copy.** The logo was
committed five times — dashboard logo, dashboard favicon, docs logo, docs hero, docs favicon —
byte-identical each time, so a brand change meant five edits and four chances to miss one.

Reached by a `@brand` Vite alias rather than a `@nouride/shared` dependency: these are files, not
modules, so each app hashes them into its own output and none of the package's code follows. A
dependency would also make `import { MessageEnvelope } from "@nouride/shared"` resolve from the
dashboard, and that app is on HTTP only by design (see the diagram above). Astro content collections
take a relative path instead — `image()` resolves from the MDX file and ignores aliases.

Favicons are the exception and are **generated**: `index.html` and Starlight's `favicon` option do not
go through the bundler, so the bytes must exist under `public/`. `scripts/sync-brand.ts` copies them
there before each build and both copies are gitignored — generated rather than committed, which is
how the five duplicates happened.

Internal packages use the short `@nouride/*` scope so imports read as
`import { MessageEnvelope } from "@nouride/shared"` rather than
`@nouverse/nouride-shared`. The workspace root keeps the `@nouverse/` scope to match the rest
of the Nouverse monorepos.

Resolution is by workspace symlink — `bun install` links `node_modules/@nouride/shared` to
`packages/shared`, whose `exports` field points straight at `./src/index.ts`. No build step,
no `tsconfig` path aliases, no stale `dist/`. Within a single app, `@/*` maps to that app's
own `src/` (same convention as Nougate).

---

## 3. Dependency Rules

One-way. `bun run lint:deps` enforces the arrows between packages, and `lint:arch` what a manifest cannot
state: that `packages/shared` imports nothing, the dashboard's line, and that `packages/wire` is types only.

```
apps/engine ──────┬──> packages/wire     ──> packages/shared, packages/acp (types only)
                  ├──> packages/persona  ──> packages/secrets, packages/policy, packages/runtime, packages/shared
                  ├──> packages/secrets  ──> packages/runtime ──> packages/shared
                  ├──> packages/policy   ──> packages/runtime, packages/shared
                  ├──> packages/gateways ──> packages/runtime, packages/shared
                  ├──> packages/llm      ──> packages/shared
                  ├──> packages/mcp      ──> packages/runtime, packages/shared
                  ├──> packages/acp      ──> (nothing)
                  ├──> packages/isolation ──> (nothing)
                  ├──> packages/queue    ──> packages/shared
                  ├──> packages/update, packages/system-packages, packages/wa-bridge ──> packages/runtime
                  ├──> packages/runtime  ──> packages/shared
                  └──> packages/shared   ──> (nothing)

apps/dashboard ───> packages/ui-* ──> packages/ui-* only
       ├──────────> packages/wire, by `import type` alone — nothing of it reaches the bundle
       └──────────> (HTTP only — never imports engine code)
```

The arrows between packages are each package's own `dependencies`, and `lint:deps` holds every
workspace member to its manifest both ways — an import it does not declare, in any spelling, and a
dependency it declares and never imports — and refuses a cycle. `packages/wa-bridge` reaches the
engine by its wire protocol alone (§6).

**Frontend packages are named `ui-*`, and the dashboard imports nothing else from the workspace but the
control API's types.** `@nouride/ui-graph` is the first: a force-directed graph on a canvas — layout, zoom,
hit-testing, click and drag — with no Nouride type in it. The Memory graph tells it colours, sizes and
labels, and it draws. The name is the rule, so a new one needs no list edited; `lint:arch` holds four lines:

- `apps/dashboard` imports only `ui-*` packages, and `@nouride/wire` by `import type` (`dashboard-imports-workspace`).
- A `ui-*` package imports only other `ui-*` packages (`ui-imports-workspace`) — not even
  `@nouride/shared`, or it would become the way engine code reaches the dashboard.
- Nothing else imports a `ui-*` package (`ui-outside-the-dashboard`): browser code stays out of the daemon.
- Browser code lives only in `ui-*` (`browser-code-outside-ui`): a package whose tsconfig adds the
  `DOM` lib, or that has a `.tsx` file, must be named so. The base tsconfig is `ESNext` alone, so
  touching the DOM requires that lib — a signal that cannot be dodged.

**What the control API sends and takes is `@nouride/wire`, one copy that both sides import.** The dashboard
kept its own copy of every payload type — 184 types in 28 files — and `check-wire.ts` compared 32 of their word
lists with the daemon's; a field renamed or retyped passed both, and the page broke only in a browser. The
package holds those types and nothing that runs. The dashboard reads every payload through it, and the engine
imports from it the words it shares with the dashboard: a turn's status and cause, a mission's status, wait and
what a person sees of it, a chat event's kind, a draft's trigger, a plan step's state, a role, a retention scope.
The routes of `/health`, `/status` and `/turns/:id` hold their answers to it with `satisfies`. So a payload changed
in the package fails the dashboard's typecheck, and the engine's where a route is held to it
(`tests/contracts/wire-types.test.ts`).

Where a payload names a word the daemon keeps elsewhere, the package names that type, from `@nouride/shared` or
`@nouride/acp`, and declares no copy. A list the page offers at runtime — a cat's parts, the effort levels — stays a
value in the dashboard, typed as the daemon's own const (`LookParts`, `EffortLevels`), so a word one side has and
the other does not fails the typecheck. `lint:arch` holds the line, through `scripts/wire-rules.ts`: the package
declares types and nothing else (`wire-not-types-only`), names no package but those two (`wire-imports-workspace`),
the dashboard imports it with `import type` alone (`wire-imported-as-value`), and declares no type it exports
(`wire-type-copied`).

**Inside the engine, memory is reached through `modules/memory/index.ts`** (`memory-past-its-barrel`):
the object `createMemory` returns, and the few names the barrel exports for what runs without one — the
CLI, the config check, the tools, the MCP surface. Boot and the daemon's `index.ts` build the stores
memory is given, and are the only files outside it that name its files by path.

What is a package and what stays in the engine follows one test: **could a second
Nouverse tool use this without dragging the daemon along?** Speaking the Anthropic wire
format, ordering work per chat, reading a persona directory — yes, all three. The
tool-call loop, the router and the approval gate — no: they only mean something in terms
of an agent registry and a session store, so they live in `apps/engine`.

Nine hard rules, all enforced by `bun run lint:check`:

1. **`packages/*` never imports from `apps/*`.** A library that reaches back into the daemon
   is not a library.
2. **`Bun.*`, `bun:*` and `node:*` appear only in `packages/runtime` (and `scripts/`).**
   Business logic imports `@nouride/runtime` instead. This is TD-001's portability discipline —
   swapping runtimes means rewriting the adapter files, not grepping the whole tree.

   Enforced on the module *specifier* in every form — `from "path"` is the same violation as
   `from "node:path"`, and dynamic, side-effect and `require` forms are matched too.

   Three exemptions, all narrow. `bun:test` is the sanctioned test runner rather than a runtime
   API. Test files and `*.config.ts` may import `node:*` freely: a fixture that makes a temp
   directory is not shipped, so putting `mkdtempSync` in the adapter would grow its surface for
   nothing that runs in production. And `internals/` is skipped wholesale, for the reason below.
3. **`packages/shared` imports nothing** except other type-only modules inside itself. It is
   the bottom of the graph: types, the message envelope, the logger, error classes, id
   generation.
4. **SQL lives in a `*.store.ts` file. Everything else takes a store.** One sentence, enforced from
   both ends: `check-arch.ts` refuses a database handle outside one (`db-outside-data-layer`), and
   `check-sql.ts` refuses a query outside one (`SQL outside a store`). The two are not the same
   check — a helper handed a store could still build a query string and pass it in.

   A convention rather than a list, and that is the point: a reader who knows only that sentence can
   place any new file correctly, and

   ```
   find apps packages -name '*.store.ts'      # 31 files — the complete port surface
   ```

   is the whole inventory of what a move to another engine has to rewrite. The files that are
   genuinely not stores are named in `DATA_LAYER`: the adapter, the migration runner, boot and
   `commons/context.ts`, and the operator paths that run with the daemon stopped
   (`gateways/rename.ts`, `cli/commands/gateway-rename.ts`, `cli/commands/db.ts`). Tests are exempt
   from `lint:sql` altogether: nothing in them ships.

   A list of files answers "is this file allowed" and never "where does database code go"; the
   convention answers both.

   The same discipline as rule 2, one layer up, and the precondition for ever moving off SQLite
   cheaply. Bun's SQLite is **synchronous** and `Bun.sql` is not, and there is no bridge from async
   back to sync in JavaScript — so the day a Postgres port happens, every file holding a handle is a
   file that has to grow `await`. Keeping that set small and named is the whole of the preparation.

5. **Business logic depends on a port, not on a store class.** Every store exports
   `Port<TheStore>` (`Port` lives in `@nouride/shared`), and `store-class-in-signature` refuses a
   store class in a type position outside boot and the data layer. Constructing one is still boot's
   job, so `new EventedTurnStore(db, events)` is untouched.

   Not ceremony. `constructor(private readonly db: SqliteDb)` makes a store **structurally
   un-fakeable** — a `private` member is part of the type, so nothing but that class is assignable —
   so a test of logic that never reads a row would otherwise have to open a temp SQLite file and
   migrate it. `keyof` sees only public members, so a port derived from the class drops the handle and
   a plain object becomes assignable. `tests/contracts/store-ports.test.ts` drives real pipeline code
   with no database at all.

   Derived rather than hand-written, deliberately: the stores carry over two hundred public
   methods, and an interface describing what somebody *remembered* a store does is one that drifts.
   Derived from the class, a second implementation that forgets a method is a compile error — the
   migration safety, not a shortcut. `SessionStore.id()` was the last reason business logic imported a store at all
   and is now `sessionIdFor` in `@nouride/shared`: deriving a string from three strings was never a
   database operation.

6. **No `any`, and no file over its budget.** `bun run lint:size` (`scripts/check-size.ts`). Both
   were found by someone reading the code rather than by a check, which is the argument for the
   check — `noImplicitAny` is already on and says nothing about an `any` written on purpose, and no
   compiler has an opinion about length.

   Lines of **code**, not lines of file, because the house style here is dense documentation and a
   total-line rule would punish the files that explain themselves best. The cap is 400, set against a
   median of 84 code lines and a p90 of 287. `policy/src/hardline.ts` and the dashboard's
   `commons/lib/api.ts` were both long, for opposite reasons — one is a documented classifier, the
   other grew into a god file, until its payload types went to `@nouride/wire` — and a rule that cannot
   tell them apart is a rule that gets switched off.

   A **ratchet**, not a threshold: a plain cap would have failed on fifteen files the day it landed,
   so it would have been committed set above all of them — a rule that permits everything present and
   calls that a standard. Each oversized file is recorded at the size it is now, may shrink, may not
   grow; anything unlisted must stay under the cap. `ANY_BUDGET` does the same for the `any` still in
   the test suite. Tests are **not** exempt from the `any` rule: a fake typed `any` cannot disagree
   with the thing it stands in for, which is how a test starts agreeing with the bug —
   `PendingApproval` was narrowed to `{ id: string }`, its fixtures matched, and the CLI printed
   `undefined` for four fields no test could see.

7. **No stray control characters in source.** `control-character` refuses the C0 range apart from tab
   and newline, and a bare carriage return. It is here because it happened twice in one afternoon and
   the second time it *disabled a rule while reporting success*: an edit script wrote a word-boundary
   escape through a language that reads it as a backspace, so a regex carried a literal 0x08, matched
   nothing, and `check-arch` printed a tick. Invisible in a terminal, in a diff, and in the output of
   `RegExp.source` — it took `cat -v`. The rule also found two shipped files using raw NUL bytes as
   key separators where the escape was meant.

8. **The SQL is fast and safe.** SQLite is the database (TD-015), so what `bun run lint:sql`
   (`scripts/check-sql.ts`) asks of every SQL literal in shipped code and every new migration is no
   longer whether it would run on another engine. It asks whether it can be injected, whether it is
   slow by construction, and whether it leans on one of SQLite's footguns. Each finding names its rule
   and what to write instead:

   | | Rules |
   |---|---|
   | Safety | S1 an interpolation that is not `marks()` or listed with why it cannot carry input · S2 SQL built with `+` · S3 `exec()` with an interpolation · S4 a bound `LIKE` without `ESCAPE` · S5 `MATCH` outside `memory-fts.store.ts` · S6 extensions, `ATTACH`, a virtual table other than FTS5 |
   | Speed | P1 a table scan in the query plan · P2 a leading-wildcard `LIKE` · P3 `ORDER BY random()` · P4 a read per item in a loop · P5 `OFFSET` (warning) · P6 a sort an index could provide (warning) |
   | Footguns | F1 `INSERT OR REPLACE`, `REPLACE INTO` · F2 `INSERT OR IGNORE` · F3 SQLite's clock · F4 a double-quoted string · F5 `AUTOINCREMENT` (warning) |
   | Placement | A1 SQL outside a store · A2 `PRAGMA` outside the adapter |

   **The plan check** is the rule that would have caught 0.6's slow keyword search before a box did —
   a prefix `LIKE` that read all 423k rows of the term table for every query word. Every statement that
   reads is run through `EXPLAIN QUERY PLAN` against a fresh database migrated to the schema that
   ships, and a `SCAN` of a real table fails unless the table is in `SCANS_ALLOWED` with its reason.
   With no `ANALYZE` data SQLite treats every table as large, so the plan says whether an index *can*
   be used, which is the question that matters.

   It reads the code through the TypeScript parser. A literal is SQL only when it begins with a verb
   and the keyword that has to follow it — grepping for `GLOB` once found 35 hits, all `Bun.Glob` — and
   comments are not literals. Two floors, statements found and statements planned, fail a run that finds
   too little: a check that matches nothing would otherwise report success forever. Each allowlist
   (`INTERPOLATIONS`, `SCANS_ALLOWED`, `QUERIES_PER_ITEM`) carries a reason per entry, as
   `check-size.ts`'s budget does, and `tests/contracts/check-sql.test.ts` pins every rule from both
   sides. Warnings are counted on every run and listed with `bun run lint:sql --warnings`.

   **Migrations at or below 44 are not re-checked**, for correctness rather than convenience: an
   applied migration never runs again, and editing one refuses to boot (`db/index.ts`).

   A move to another engine would still go through the store seam; the dialect half of that question is
   history since TD-015.

9. **No timer callback lets an exception out.** Nothing is above a `setTimeout` or `setInterval` callback to catch
   what it throws, so a throw there is an uncaught exception, and the daemon shuts down on one on purpose
   (`boot/shutdown.ts`): a table locked at the wrong moment in an hourly check ended every conversation. `bun run
   lint:timers` (`scripts/check-timers.ts`) reads every timer in daemon code and refuses a callback that is not
   `contained(log, "what failed", …)` from `@nouride/shared`, one `try … catch` around its whole body, or a form that
   cannot throw — the `resolve` or `reject` of the promise it is in, `abort()`, `clearTimeout`, an assignment of a
   value. Where failing should do more than be logged — settle a waiter, look again — the body does that itself.

`scripts/check-arch.ts` greps for violations and exits non-zero. It runs in `lint:check`, so
CI catches drift before review does.

### What `internals/` is

Two private submodules: `internals/pro`, the commercial plugins (appliance, multi-user, Nouverse
sign-in), the private editions' build and the internal docs; and `internals/nougate`, the LLM gateway.
Four properties, and all four are load-bearing:

1. Its own `package.json` and lockfile, **outside the root `workspaces` array**.
2. It may carry a different licence from the engine.
3. It imports nothing from `packages/*` or `apps/*`. The engine reaches a plugin by a dynamic import
   of its package name, against a declaration kept on the engine's side
   (`modules/users/nouride-multi-user.d.ts` and its siblings), and a test fails when the two drift;
   it reaches the gateway over HTTP, or in-process in the router editions.
4. The daemon runs correctly without it. The free edition is built and tested without either, and a
   build that names an absent plugin's feature — an OAuth issuer, say — is refused at boot.

`check-arch.ts` scans `apps/` and `packages/` only, because the rules above describe imports between
workspace members and a submodule is not one.

**What does not go here.** `content/` is content, not a process: no lockfile, no protocol, nothing
to run. It fails every clause (§1.1).

### Why not a `core` package

Tempting: move the agent registry and LLM executor into `packages/core` so they look
reusable. They are not reusable — they are the daemon. Splitting them out buys an import
boundary and costs a layer of indirection on every change. The engine stays one app; if a
second consumer ever appears, extraction is mechanical.

---

## 4. Engine Internals

```
apps/engine/src/
├── index.ts             # boot ORDER (§14.2 SPEC) — one linear read, top to bottom
├── boot/                # what boot does but does not order
│   ├── stores.ts        #   the boot's first long step: the database and every store, opened in order
│   ├── timers.ts        #   the snapshots, then the upkeep: each timer started once what it reads exists
│   ├── turn-machine.ts  #   the turn machine's parts, then the pipeline, scheduler and toolset they make
│   ├── preflight.ts     #   checks that must pass before a message can arrive
│   ├── agent-home.ts    #   the agents' HOME (.nouride/home) and .nouride/bin first on PATH
│   ├── toolchain.ts     #   installers pointed at .nouride, the one PATH, the shared Python env
│   ├── durable.ts       #   closing the turns a dead process left, and what a restart owes (§14.2 SPEC)
│   ├── delivery.ts      #   replies the last process wrote and never delivered
│   ├── interrupted.ts   #   stopping turns at shutdown, and the notice for those that died
│   ├── memory.ts        #   the memory module, its stores, and the vault's one-time moves
│   ├── memory-pass.ts   #   the nightly pass's clock, model and budget
│   ├── maintenance.ts   #   retention, backups, disk — the timers and what they delete
│   ├── tools.ts         #   the built-in toolset, wired to this daemon's stores
│   ├── control-plane.ts #   accounts, setup wizard, config editing, the HTTP server
│   └── shutdown.ts      #   signal handlers + drain order (§14.1 SPEC)
├── cli/
│   ├── main.ts          # dispatch table: one case per command, each call checked against grammar.ts first
│   ├── grammar.ts       # each command's actions and the flags each reads — an unknown one is exit 2
│   ├── usage.ts         # `nouride help` — the one list of commands (lint:cli)
│   ├── client.ts        # the control-API client every command is handed
│   └── commands/        # chat.ts, doctor.ts, cron.ts, … — one file per command
├── db/                  # open SQLite via @nouride/runtime, and the migrations
│   ├── index.ts         #   openAndMigrate: capability check, fingerprint, snapshot, migrate, compact
│   ├── backup.ts        #   snapshots: daily, before a migration, `nouride db`
│   ├── keys.ts          #   which columns hold a gateway, a conversation, a chat, an agent or a person — what a
│   │                    #   rename rewrites and a conversation's delete clears; a contract test walks the schema
│   └── migrations/      #   069_baseline.sql (the schema 0.8.0 left), then 070_* onwards — forward-only, PRAGMA user_version
├── service/             # supervisor detection + systemd/launchd unit generation, the update guard
├── commons/             # cross-cutting: context, audit, notify, activity, log-buffer, file-lock
└── modules/
    ├── pipeline/        # the inbound path (§5)
    │   ├── index.ts     #   composition root: build collaborators, delegate, own nothing
    │   ├── chat-queue.ts #  the gateways' part; slash-commands, wake-ups, turn-control, chat-directory, tool-ports the other callers'
    │   ├── inbox-desk.ts #  written down on arrival, too old to answer, put back after a restart
    │   ├── inbound.ts   #   whether this message gets a turn at all, and whose
    │   ├── turn.ts      #   running one: its phases in order, over one TurnState (turn-state, turn-brain, turn-request)
    │   ├── job-turns.ts #   the scheduler's turns, and where their output goes
    │   ├── admission.ts #   allowlist and pairing, rate limit, one-turn-per-message claim
    │   ├── voice.ts     #   which bot an agent speaks with + the outbound record
    │   ├── conversation-end.ts # the one way a conversation ends — /new, /reset, rollover, delete — and what each clears
    │   └── …            #   room-memory, batcher, attachments, session-lifecycle, subagent, peer-turn
    ├── turns/           # the turn record — a chat's, and a delegate's own in the background — the journal,
    │                    #   delivery, and closing a turn cut short
    ├── events/          # the event stream: one append-only log of what turns do, a turn's steps among
    │                    #   it — its contract is docs/EVENTS.md, locked by tests/contracts/
    ├── config/
    │   ├── defaults.ts  # built-in config, doubling as the schema for unknown-key detection
    │   ├── global/      # .nouride/config.toml → typed GlobalConfig
    │   ├── config-file.ts # the one way a config file is written: locked, checked, backed up (packs reloaded)
    │   └── settings/    # what the dashboard and the CLI edit, one file per section
    ├── sessions/        # sessions.store.ts (keyed by agent, chat, gateway instance), rollover, group context
    ├── router/          # envelope → which agent? (mention > gateway owner > binding > default)
    ├── llm/             # providers, executor (tool loop), prompt, context, budget, usage
    ├── tools/           # registry, approval gate, grants, credential files, builtins/
    ├── toolchain/       # where installs land, the one PATH, the shared Python env, what is installed
    ├── memory/          # the vault, the index, the nightly pass, search, tags (§12 SPEC)
    ├── hooks/           # the slash commands (§9.1 SPEC)
    ├── reflection/      # skill learning: trigger, synthesis, candidates, draft checks, weekly review, drafts
    ├── cron/            # scheduler, store, expression parser (TD-011, §8 SPEC)
    ├── jobs/            # background jobs: the store, the watchdog, the deadline, the wake-up text
    ├── gateways/        # the in-process WhatsApp bridge, the in-process LLM gateway, the web gateway
    ├── external-agents/ # a coding CLI answering an agent's turns over ACP (0.8.1): its process, sessions,
    │                    #   sign-in, version check, and Nouride's tools lent to it over /mcp/agent
    ├── …                # access, attachments, chat-events, rooms, people, users, setup, skills-hub,
    │                    #   mcp-server, system-packages, update
    └── web/
        ├── server.ts    # Hono app: middleware, static dashboard
        ├── health.ts    # GET /health (§15.1 SPEC)
        ├── hooks.ts     # POST /hooks/:token — webhook jobs, the one unauthenticated route
        ├── mcp/         # POST /mcp — Nouride as an MCP server; POST /mcp/agent — an external agent's CLI, mid-turn
        └── control/     # the control API — one file per route domain under routes/,
                         #   wired (and ordered) in control/index.ts; a reply's `plain` (its
                         #   everyday words, beside the CLI's), shared ones in control/plain.ts
```

The agent registry — discovery, pause/resume, reload — is `@nouride/persona`, not an engine module.

The layout matches `apps/dashboard` and the other Nouverse backends: `commons/` for what
everything uses, `modules/<domain>/` for a domain, entry points at the top. Engine-internal
imports use the `@/` alias — `@/modules/pipeline/index.ts`, never `../../../pipeline.ts`.

`modules/<name>` is a **domain** — something the daemon does, that you could name in the
product. Storage (`db/`) and host integration (`service/`) are not domains and sit beside it:
the test is whether the directory would look the same in a different product.

Modules are wired in `index.ts` and passed their collaborators explicitly. No service
locator, no global singletons other than the logger and the DB handle — both created once in
`index.ts` and threaded down.

---

## 5. Runtime Data Flow

```
  Discord WS        Telegram poll       WA bridge (in-process, or ws)      web (dashboard, nouride chat)
      │                  │                    │                                  │
      └────────── packages/gateways ──────────┴──────────── modules/gateways ─────┘
                         │  MessageEnvelope (normalized, §5.1 SPEC)
                         ▼
          room log  ── every message, before anything decides who answers
                         │
                         ▼
          admission ── the access gate: paired, allowlisted, or a pairing code
                         │
                         ▼
          inbox     ── written down before anything acts on it · redelivery and staleness
                         │
                         ▼
          queue/    ── per chat FIFO · dedup · depth cap · slash commands skip it (urgent)
                         │
                         ▼
          router/   ── mention? gateway owner? channel binding? orchestrator? → claim → rate limit
                         │
                         ▼
          hooks/    ── is it a slash command? handle and stop.
                         │  no
                         ▼
   persona registry ── the pack: persona, tools, skills
                         │
                         ▼
         llm/prompt → llm/context → llm/executor ──┐      every message → turns/ journal
                         ▲                          │ tool_calls?
                         │                          ▼
                         │              tools/registry → approval? → executor
                         └──────────── tool results ─┘
                         │  final text — journal folded into the session
                         ▼
                gateway.send(OutboundMessage) → reply marked delivered
```

One flow per **connection**, not per message. A platform hands a channel message to every bot in the
channel, so a daemon running one bot per agent walks this path once per connection and has to collapse
the results — see §12.

Side channels, all SQLite-backed so they survive a restart:

- `cron/scheduler` runs a due job and delivers the result itself, through `pipeline.runCronTurn` rather than through `queue/`. It is the one inbound path that does not go through the queue, because the queue's contract is "answer into the conversation this came from" and a scheduled job's output may belong somewhere else — another chat, a webhook, or nowhere — and has to come back as text either way, for the run record.
- `ask_agent` runs a peer's turn behind the chat (`pipeline/peer-turn.ts`), and `delegate` runs blank helpers as the caller (`pipeline/subagent.ts`); both answer as a tool result — except a helper started with `background: true`, which is a job of its own (`pipeline/background-helper.ts`, `jobs/helper-jobs.ts`) whose handoff wakes the agent when it ends, and an ask that outlasts its wait (a minute) or was asked with `background: true`, whose peer turn carries on as a job of the asking agent's (`pipeline/background-ask.ts`, 0.7.19) and whose answer wakes it.
- `jobs/` wakes the agent that started a background command, helper or ask when it ends, as a turn in that conversation.
- `tools/approval` parks a tool call until a human answers in chat or on the dashboard.
- `memory/` cuts conversations from the turn log and the room log, never from the session, and files them at night (`boot/memory-pass.ts`).
- `web/` reads the same tables the daemon writes — no separate API state.

---

## 6. WhatsApp Bridge — the Module Boundary

The bridge is a module of its own, and two properties keep it that way even though every edition
compiles it into the binary:

1. **`packages/wa-bridge` is a workspace member that depends on `@nouride/runtime` and nothing else
   in the repo** — not `@nouride/shared`, not the engine. Baileys lives only there, and its one
   copyleft dependency, `libsignal`, is replaced by an MIT shim through `overrides` in the root
   `package.json`; a contract test fails if the real package reaches `bun.lock`.
2. **The only coupling to the engine is the wire protocol**: newline-delimited JSON, typed in
   `packages/shared/src/types/bridge.ts` on our side and hand-copied in the bridge's `src/protocol.ts`.
   The duplication is the point: the protocol is small enough to read. What keeps the copies equal is
   `scripts/check-seams.ts` (`bun run lint:seams`), which fails on a field one side has and the other
   does not, or a version bumped on one side — not the handshake, which compares the version alone and
   so let `voice` exist on one side only, at the same version.

**Transport.** The bridge runs in the daemon's own process, which is what `bridge_transport` unset or
`"inproc"` means, and the only shape left. A config naming `ws`, which dialled a bridge somewhere else that
nothing in this repository ever served, is refused at load (0.7.10); so, since 0.8.0, is one naming the old
`stdio` transport or its `bridge_command`, which named the second executable `stdio` spawned. The bridge keeps
its connection at module scope, so it is one WhatsApp number per daemon.

Crash isolation is weaker in-process — the bridge shares a crash domain with the agent loop — and that
is the trade for not paying for a second Bun runtime.

The operational detail — the Baileys version, LID addressing, the stdout hazard, error 463 — is in
`packages/wa-bridge/README.md` and the comments in `packages/wa-bridge/src/` (`index.ts` says which file
holds what) and `packages/gateways/src/channels/whatsapp/gateway.ts`. Read them before changing the bridge.

Two consequences of pairing that shape the code:

- **The QR is protocol traffic, not a log line.** Baileys prints it to stdout by default; stdout
  here is the protocol, so its logger is redirected to stderr and the code travels as a `qr` event
  the control API serves to the dashboard. The person holding the phone is not the person reading
  `journalctl`.
- **The session is a login, so it is encrypted at rest** under `[gateways.whatsapp.*]
  encryption_key`. `packages/wa-bridge/src/auth.ts` implements Baileys' `AuthenticationState` over
  AES-256-GCM files rather than using `useMultiFileAuthState`, which writes plain JSON that anyone
  copying a backup can sign in with.

---

## 7. Configuration

Three sources, each with one job:

| Source | Holds | Lifetime |
|---|---|---|
| `.nouride/config.toml` | daemon settings, provider profiles, gateway instances, `[[people]]` | partly live — what is read per message applies at once; gateways and ports need a restart (§14.3 SPEC) |
| `agents/<id>/config.toml` | per-agent model, channels, tools, MCP servers | reloaded with the pack |
| `agents/<id>/skills.toml` | which pooled skills this agent has switched off (§1.1) | reloaded with the pack |
| `agents/skills/` | the skill pool every agent draws from | reloaded with the pack |
| `.env` / `.nouride/data/secrets.enc` | **credentials only** | env needs a restart; the store does not |

### Provider profiles

The unit of LLM configuration is the **endpoint**, not the vendor:

```toml
[providers.nougate-anthropic]
kind = "anthropic"                                     # which wire format, not which company
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                                    # a secret NAME

[providers.nougate-openai]
kind = "openai"
base_url = "https://nougate.nouverse.tech/openai/v1"
api_key = "nougate"                                    # the same credential
```

An agent then says `provider = "nougate-anthropic"`, and switching it to a different
deployment is a one-word change.

The earlier shape — one environment variable per vendor, `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` — could not express this at all. A credential belongs to a base URL,
and one Nougate key serves both of its protocol endpoints. Naming the secret once and
referencing it twice says exactly that. `kind` is deliberately *only* the wire format:
the model behind `antigravity:claude-sonnet-4-6` on an OpenAI-shaped endpoint is
Claude, and nothing in the engine needs to care.

No profile exists by default: `nouride setup`, the dashboard or `nouride provider add` creates each
one, with its credential in the secret store.

### Gateway instances

Every connection is **named**, because a multi-agent daemon wants a bot identity per
agent:

```toml
[gateways.telegram.nouva]        # instance id: telegram:nouva
enabled = true
token = "telegram-nouva"         # a secret name
agent = "nouva"                  # this bot belongs to Nouva

[gateways.telegram.nox]          # a second Telegram bot, same daemon
enabled = true
token = "telegram-nox"
agent = "nox"
```

A single `DISCORD_BOT_TOKEN` could only ever describe one bot, which quietly capped
the whole product at one identity. The instance id flows through everything that has
to tell two bots apart: session keys, channel bindings, outbound routing, the
dashboard.

`agent = "..."` is the "one bot per agent" case and ranks above channel bindings in
the router (§5): if you gave Nouva her own bot, everything it receives is hers, and
enumerating chat ids would break the first time someone starts a new conversation.

That last sentence stops being true the moment two of these share a channel — "everything it receives
is hers" is then true of every bot at once. §12 is what that arrangement requires.

### Secrets

Config names a secret; the value is resolved **environment first, store second**:

```
api_key = "nougate"  →  $NOUGATE  →  $NOURIDE_SECRET_NOUGATE  →  .nouride/data/secrets.enc
```

Environment wins so a container platform can pin a value that a stale file in the
data volume cannot override. The store exists because env-only cannot serve the
dashboard: adding a bot token would mean a redeploy. The store is 0600,
gitignored, and **write-only from the outside**: `inventory()` returns names,
origins and what is said about each (its fields), never values, so no HTTP route
can read a credential back out.

**Encrypted at rest (0.8.19).** `secrets.enc` is the whole store, AES-256-GCM, under
a key derived from `NOURIDE_ENCRYPTION_KEY` (`packages/secrets/src/store-key.ts`,
`store-file.ts`); its header names the key's fingerprint, so a wrong key is said
rather than taken for damage. What the encryption is worth is how far the key is
from the data, so the daemon knows and says where it found it:

| Where the key is | Who puts it there | What a copy of `.nouride/` carries |
|---|---|---|
| root's `/etc/nouride/nouride.env`, loaded by the unit's `EnvironmentFile=-` (systemd reads it as root) | `install.sh`, a Box's root daemon | no key |
| `~/.config/nouride/nouride.env` on a Mac, named in the plist | `install.sh` | no key |
| the container's environment, or a file named in `NOURIDE_ENCRYPTION_KEY_FILE` | the operator | no key |
| a line in the install's `.env`, beside `.nouride/` | the daemon, on an install that only updated | no key; a copy of the whole install folder does |
| `.nouride/encryption.key` | the daemon, in a container given none | the key |

The daemon never makes a key while a store needs another: it refuses to start,
naming the key it needs and the two ways out (that key, or `nouride secret restore`
with the backup passphrase, whose sealed copy is made again at each change). Given
a better key later, the daemon's store encrypts again with it and forgets the one
it made; `install.sh` moves a made key out of the install as it is. `secrets.json`
is moved once no update is pending, since the guard's way back reads it. The key's
variables leave the daemon's own environment once read, so nothing it starts
inherits them. A command run by root goes through the `nouride` launcher, which runs
the CLI as the service account, who cannot read root's file: the launcher hands the
key over in the environment, never as an argument, and the CLI sets it aside as it
starts (`keepStoreKeyAside`), so `secret decrypt`, `secret restore` and a rollback
open the store and nothing a command starts inherits it. Not covered, and said: root,
the running daemon, a whole image of a disk with no TPM, and blocks of the old plain file.

A value pasted where a name belongs is refused (`sk-…`, `xoxb-…`, a Telegram bot
token shape), because that mistake otherwise commits a live key into `config.toml`
and still appears to work.

TOML parsing uses `Bun.TOML.parse` — zero dependencies.

Not `import("…toml")`, which is what this used at first. Bun's module loader does parse
TOML, but it caches by path and ignores both `?v=` and `#fragment`, so a file edited and
re-read in the same process returned its *previous* parse for the lifetime of the daemon.
That silently broke hot reload, `/reload`, and every tool that writes config and reloads:
they reported success while the daemon kept using the old values. Reading the text and
parsing it explicitly has no cache to defeat.

## 8. Process Topology

**Dev (`./run-dev.sh`)** — one container, one supervisor:

```
┌─ nouride-dev (oven/bun:1.4.4-alpine) ───────────────────┐
│  scripts/dev-watch.sh                                  │
│    ├─ bun apps/engine/src/index.ts     :18254        │
│    └─ poll → SIGTERM+restart / vite build → dist       │
│  mounted: apps/engine/src, apps/dashboard/src,         │
│           apps/site, packages/, content/skills,        │
│           .nouride/                                    │
└────────────────────────────────────────────────────────┘
```

The supervisor **polls** rather than using inotify or `bun --watch`. A bind mount
from a macOS host shows edited file contents but delivers no filesystem events into
the Linux VM, so an event-based watcher silently never fires — you edit, nothing
happens, and nothing tells you why. Polling a few dozen files every two seconds
costs nothing and behaves identically on every host. Restarts go through SIGTERM, so
every dev reload exercises the graceful shutdown sequence.

`./run-dev.sh native` runs on the host without Docker — for pairing a WhatsApp QR
code with a phone, or attaching a debugger.

**Prod** — one image, one process:

```
┌─ nouride ───────────────────────────────────────────────┐
│  docker-entrypoint.sh — restarts the daemon if it exits │
│    └─ bun --no-install run nouride.bundle.js start      │
│         ├─ Hono         :18254  (dashboard + /api + /health)
│         ├─ Discord gateway  (outbound WS)               │
│         ├─ Telegram gateway (long poll)                 │
│         ├─ WhatsApp bridge  (in-process)                │
│         ├─ LLM gateway      :18256 (router image only)  │
│         └─ cron ticker, nightly memory pass             │
│  volume: .nouride/ (config, data, agents, workspace,    │
│          memory, the agents' bin/opt/home)              │
└────────────────────────────────────────────────────────┘
```

The native install is the same process under systemd or launchd instead of the entrypoint
(`nouride service`, `DEPLOY.md`): the compiled binary rather than the bundle, and the same `.nouride/`.

Its children are not drawn: each stdio MCP server an agent uses, and since 0.8.1 one coding CLI per external agent,
started at the agent's first turn and stopped after five quiet minutes (`modules/external-agents/`). A CLI is the
largest of them — a few hundred MB with a session open and idle (`SYSTEM_REQUIREMENTS.md`) — which is why none is
offered with less than 512 MiB for the agents' commands.

The dashboard is static assets served by the engine at `/dashboard/` — no second process, no
SSR attack surface (TD-009).

**Each agent its own user (0.8.0).** On a Linux host with systemd, an agent's commands run as `nr-<agent>`, not as the
daemon's user. The daemon runs with `NoNewPrivileges` and no capabilities, so it cannot change user itself; a root
helper does it for it, by fixed rules, one process per command and nothing resident:

```
nouride (service user, sandboxed)
  └─ nouride-run exec --agent nouva -- <command>        the client: the daemon's child, in the commands cgroup
        │ /run/nouride-run.sock — root:<service group> 0660, Accept=yes
        ▼
     nouride-run serve (root, nouride-run@.service)      one per connection
        └─ the agent's command: the daemon's mount namespace and cgroup,
           nr-nouva's user and groups, no_new_privs, Landlock where the kernel has it
```

The client's stdin, stdout, stderr and exit are the command's, so timeouts, output caps, process groups and stops are
unchanged. The rules — which users it makes, which folders it gives which group, what it refuses — live in one Rust
program with `libc` as its only dependency (`packages/isolation/root/nouride-run`, its design table in
`packages/isolation/README.md`). What the daemon writes into an agent's own folders goes through the same helper
(`put`), so each file there has one owner. Since 0.8.1 the long-lived processes an agent has go through it too: its
stdio MCP servers, and an external agent's coding CLI, each as the agent with its HOME and installs
(`spawnLongLived`'s `agent` in `@nouride/runtime`). The daemon's own CLI, run for an agent by the `nouride` tool —
`nouride tools run` among it — stays the daemon's. In a container, on macOS, or on a host without the helper, commands,
servers and CLIs run as the daemon's user, and boot and `nouride doctor` say so and why — never passed off as
isolated; there an external agent's *Free in its folder* asks as *Ask when risky* does. A Box's daemon is root
and applies the same rules in the client's own process.

### Compose files

| File | Use |
|---|---|
| `docker-compose.dev.yml` | source-mounted dev container, watch mode — driven by `run-dev.sh` |
| `docker-compose.yml` | build the image from this checkout and run it |
| `docker-compose.prod.yml` | pull the latest `ghcr.io/nouverse/nouride` (DEPLOY.md § The upgrade floor) |

Same split as Nougate, same reasoning: dev mounts source, `docker-compose.yml` proves the
Dockerfile builds, prod never builds on the box it serves from. Both run files allow 45 seconds to
stop (`stop_grace_period`) rather than Docker's 10, so a running turn stops at a step and says so
(§14.1 SPEC).

---

## 9. Storage Layout

```
.nouride/                       # the install — one mounted volume
├── config.toml                # daemon config (from config.example.toml)
├── data/                      # the daemon's own state
│   ├── nouride.db              # SQLite: sessions, turns, the inbox, jobs, cron, approvals, audit,
│   │                           #   usage, logs, and the memory index (§18 SPEC); `daemon_state`, the daemon's own
│   │                           #   small state, a row each: which agents are asleep, the alert cooldowns, each external
│   │                           #   agent's CLI sessions, versions, models and accounts, when each agent was first seen,
│   │                           #   the boot's advisories, where the install is (0.8.18; JSON files beside it before,
│   │                           #   moved in by the first start and left there for the way back to 0.8.17)
│   ├── nouride.db-wal          # WAL mode — concurrent read/write
│   ├── nouride.lock            # this install's daemon, by PID — what `nouride stop` signals
│   ├── last-run-version        # the version that last started here — what install.sh and every release since 0.8.0
│   │                           #   read for the upgrade floor
│   ├── secrets.enc            # 0600, encrypted (0.8.19), write-only from outside
│   ├── .control-token         # 0640, the CLI's credential — the service group reads it
│   ├── backups/               # db/ (daily, and before a migration), agents/, memory/ (§14.2 SPEC)
│   └── whatsapp/              # Baileys session, AES-256-GCM at rest
├── attachments/<agent>/<conversation>/<date>/ # inbound media, GC'd on [retention] session_days
├── jobs/<agent>/              # background jobs' logs
├── tool-output/<agent>/       # tool results too large for the context, per conversation
├── credentials/               # file-shaped credentials, $NOURIDE_CREDENTIALS_DIR (unless `credentials_dir` names one)
├── agents/
│   ├── <id>/                  # persona packs — git-trackable identity
│   │   ├── SOUL.md IDENTITY.md AGENTS.md MEMORY.md
│   │   ├── config.toml
│   │   └── skills.toml        # this agent's exceptions to the pool (§1.1)
│   └── skills/<name>/SKILL.md # the pool
├── memory/                    # the vault: episodes/, archive/, days/ (by month), people/, shared.md (§12 SPEC)
├── workspace/                 # what the agents produce
│   ├── shared/                # every agent — the working directory, and how work is handed over
│   └── private/<id>/          # one agent, unreadable by the others — its HOME where each agent is its own user:
│                              #   .scratchpad/; .cli/<cli>/<profile>/, an external agent's CLI sign-in and settings;
│                              #   the CLI's CLAUDE.md or AGENTS.md with Nouride's block; missions/<mission>/, with
│                              #   worktree/ and helpers/<n>/ for a mission in a repository (SPEC §13.5)
├── bin/                       # what agents install — first on every command's PATH (§7.1 SPEC)
├── lib/, opt/                 # what those installs are made of; opt/python is the shared Python env
└── home/                      # the agents' HOME under a service unit or the container image
```

**What an agent's command reaches is beside `data/`, never in it** (0.8.0). `data/` is the daemon's alone, `0750`, and
where each agent is its own user no command enters it. What a command is handed a path to — a job's log, an
attachment, a long tool result — sits in `jobs/`, `attachments/` and `tool-output/`, each `<folder>/<agent>` the
service user's with the agent's group, setgid, `2750`: its agent reads it, nobody writes it but the daemon, no other
agent reaches it. The first 0.8.0 start moves them out of `data/`, with every row that names a file in them
(`boot/kept-folders.ts`). `workspace/shared/` is every agent's (`nr-agents`, `2770`); `workspace/private/<id>/` is the
agent's own, and its HOME; a pack is its agent's to read and the daemon's to write; `bin/`, `lib/` and `opt/` are every
agent's to run and the daemon's to change — what an agent installs lands in its own `~/.local`; `memory/` and the
packs' git history are the daemon's alone.

Three keys rather than one directory (`data_dir`, `agents_dir`, `workspace_dir`), because the three
differ in backup policy, sensitivity and size — `workspace_dir` on another disk is a supported
arrangement, and the pack is deliberately not a workspace. `[memory] dir` is a fourth, and never
inside `agents_dir`. `bin/`, `lib/`, `opt/` and `home/` sit beside `data/` (`dirname(data_dir)`), so
they survive restarts, updates and container recreates and never land in a scratchpad.

That folder, `dirname(data_dir)`, is the install, and it can be moved or copied whole (0.8.18). The database names
paths in it (a job's log, an attachment, a mission's folder, the directory a grant is bound to, a file named in a
conversation), so the folder is recorded in `daemon_state`, with `workspace_dir` and `agents_dir`, and a start that
finds one of them elsewhere renames every such path under where it was to where it is before anything reads one,
keying again the grants bound to a directory there (`boot/install-root.ts`, `boot/moved-paths.store.ts`). Each is
followed on its own, the most specific first: a `data_dir` set to another disk takes what is beside it, and a workspace
that stayed under the old folder is set aside while that rename passes, so it keeps its paths. What records what
happened (the audit log, the event stream) keeps the paths it had, and a path outside them, which did not move, stays.

One SQLite file for all engine state (TD-005, TD-015). Schema in `apps/engine/src/db/migrations/`,
forward-only and numbered; `PRAGMA user_version` tracks what has been applied.

**One baseline, then forward migrations.** `069_baseline.sql` is the schema 0.8.0 left: every migration up to 69,
folded by `scripts/squash-migrations.ts` on 2026-10-26 from 0.8.0's chain — `068_baseline.sql`, which had folded 032
to 068 on 2026-10-24 and hashed identically to a live box's 0.7.28 database, and 0.8.0's own `069` — and verified to
give the same `sqlite_master`, row for row. A baseline keeps its version rather than becoming `001_`, because version
numbers are the only thing deciding what a database still needs: renumbered, it would leave the boxes already past it
with nothing pending forever. A database at 69 holds the fingerprint the chain gave it, so the baseline states that
fingerprint rather than hashing its own text (`db/migrations.ts`), and a database it makes still opens under 0.8.0.
Each change after it is a file of its own, from `070_*.sql`.

The cost is stated where it lives (`db/migrations.ts`): a database below 69 can no longer be upgraded by this build.
That is affordable because every release after 0.8.0 starts only on data 0.8.0 has run on, and 0.8.0 brought every
database to 69 — so one below it is refused, "install 0.8.0 first" (`db/index.ts`). Each squash before was
affordable the same way: into `032_baseline.sql` in September 2026, when the only two installs were both at 32, and
into `068_baseline.sql` for 0.8.0, which started only on data 0.7.28 had brought to 68. A migration is SQL only — no code
step after it — since 0.8.0's migrations add tables and features and bring no old form forward.

**An applied migration must never be edited**, and that is now enforced rather than remembered.
`user_version` records how many have run and never what they said, so editing one after it has been
applied leaves existing installs on the old schema and fresh ones on the new, silently. `PRAGMA
application_id` holds a fingerprint folded over the version, filename and text of every applied
migration, and a boot whose fingerprint disagrees **refuses to start** — naming both ways out, one
of which is `NOURIDE_ALLOW_SCHEMA_DRIFT=1`. An unset fingerprint is a mismatch like any other: 0.8.0 stamped every
database it ran on.

In `application_id` rather than a checksum table: it keeps TD-005's reasoning (an integer the file
format already ships) instead of working around it, and a table would be circular — introducing one
is itself a migration, which cannot verify itself.

Markdown files are the source of truth for identity; SQLite is the source of truth for
everything with a lifecycle. The split is deliberate: personas are meant to be edited by
hand and diffed in git, sessions and approvals are not.

---

## 10. Build & Deploy

Two artefacts from one build script, `scripts/build-binary.ts` (the editions are `scripts/build/`):

- **The binary** — `bun build --compile`: the engine and the CLI in one executable that needs no Bun
  on the target, shipped as a tarball with `dashboard/`, `skills/`, `pkg/` and `config.example.toml`
  (`CLI.md`, The single binary). `install.sh` installs it natively (`DEPLOY.md`).
- **The image** — `Dockerfile`, by stage:
  1. **deps** — copy every workspace `package.json` + `bun.lock`, `bun install --frozen-lockfile`.
     Cached until a manifest changes.
  2. **dashboard-builder** — copy dashboard source, `vite build` → `dist/`.
  3. **engine-builder** — the same build script with `--bundle-only`: one `nouride.bundle.js` for the
     edition named by `EDITION` (`basic`, `router`, `pro`).
  4. **runtime** — `oven/bun:${BUN_VERSION}-alpine@${BUN_DIGEST}` (`.bun-version`, and the image pinned by digest
     beside the tag; each stage refuses a Bun that is not that version) with `bash`, `openssh-client`, `util-linux`, `ripgrep`,
     `su-exec`, `socat` and any `EXTRA_PACKAGES`; the bundle, the built dashboard, the built-in skills, and
     `nouride-pkg` with its container service. The entrypoint fixes ownership of `.nouride/` as root, starts the
     package service and installs again what agents installed (0.8.15), then runs the daemon as the `bun` user with
     `HOME=/app/.nouride/home`, restarting it if it exits.

Either way the dashboard is built, because browsers do not run TypeScript.

---

## 11. Phase Map

The roadmap's scope, phase by phase and with what each phase built, lives in SPEC.md §21. What is still
open, and where each finding of the 2026-10-15 review stands, is planned in private documents the
public export leaves out ([README.md](./README.md)).

---

## 12. Several Bots on One Platform

The arrangement `agent = "..."` (§7) invites: one bot token per agent, all of them in the same
channel.
It is the shape a multi-agent daemon is *for*, and it was the shape nothing had been exercised
against.
Everything below was found on a live Discord with six agents in one channel, and every rule here
exists because its absence produced a specific, visible failure.

The one fact the whole section follows from:

> **A platform delivers every channel message to every bot in the channel.**
> Six bots means the daemon receives six copies of one message, each on a different connection, and
> routes each independently.

### 12.1 Fan-out

```
                        one message in #infra-ops
                                   │
        ┌──────────┬───────────┬───┴───────┬───────────┬──────────┐
        ▼          ▼           ▼           ▼           ▼          ▼
   discord:      discord:   discord:    discord:    discord:   discord:
    nouva          nix        nero        nox         nexa      nestor
   (nouva)       (nix)      (nero)      (nox)       (nexa)    (nestor)
        │          │           │           │           │          │
        └──────────┴───────────┴───┬───────┴───────────┴──────────┘
                                   ▼
                     admit → classify → route → claim
                                   │
                            at most one turn
```

Anything that fires *per connection* fires six times.
Anything that does not name an agent is true on all six at once.
Those two sentences explain every bug in this section.

### 12.2 Addressing is required, and what counts as addressing

A rule that names no agent — "the owner of this connection answers", "fall back to the default
agent" — is true six times over, so six agents answer one message.
Both shipped, and both produced six replies to a one-word message.

`answerUnaddressed` (pipeline → router) turns off *both* fallbacks when more than one enabled
instance shares the platform and the chat is not a DM.
In that arrangement a message has to be addressed:

| Signal | Resolves to | Notes |
|---|---|---|
| Platform tag of this bot (`mentionsSelf`) | the connection's own agent | the only unambiguous one |
| Agent id or display name in the text (`nox:`, `@nox`) | that agent | works from any connection |
| Reply to a message an agent wrote | that agent | names exactly one, cannot fan out — see below |
| Channel binding in the pack | that agent | explicit operator opt-in |
| **Platform tag of somebody else** | **nobody** — `addressed_elsewhere` | the guard that stops the storm |
| Nothing | nobody | `no_match` |

**Who wrote the quoted message** comes from two places (`Voice.replyAuthor`). The outbound record — which agent sent
which message id — first, because it is the only answer when several agents share one bot; it is in memory, sixty
messages a chat. Then the platform's word: the adapter sets `repliesToSelf` when the quoted message is its own bot's
(Telegram's `reply_to_message.from`, Discord's `mentions.repliedUser`, WhatsApp's quoted participant against both of
its addresses), and the reply goes to that connection's agent — so a reply still lands after a restart. Ending a
conversation (`/new`, `/reset`, the rollover) resets the hop count and keeps the record: a reply to an answer from
before the reset is addressed to its author, and brings the quoted words with it.

A DM keeps both fallbacks: a private message to Nero's bot is unambiguously Nero's, however many
other bots exist.
A platform with one enabled instance keeps them too — that is most installs, and withholding them
there would make a single bot stop answering ordinary messages.

The orchestrator (`[daemon] orchestrator`, 0.7.18 — `default_agent` before) gives the "Nothing" row an answer:
`frontDeskFor` (`router/front-desk.ts`) passes it to the router as `frontDesk` where `answerUnaddressed` is false, the
chat is not a DM and the room does not require a mention (and, in a room with a member list, only when it is a
member). The router ranks it below a channel binding and above `ambiguous`/`no_match` (reason `front_desk`). It names
the same agent on every copy, so the (message, agent) claim lets one through, and `voiceGatewayId` speaks through its
own bot; where ids differ per connection, `admit` leaves it to that bot's own copy. Its OTHER AGENTS section tells it
the untagged message is its to answer or hand on.

### 12.3 Mention resolution

A bot's platform *name* is not its agent's name.
`@Nero | Infra Agent` is the Discord application's name; the agent id is `nero`; comparing them
matched nothing, so an explicit tag resolved to nobody and every connection fell through to its
owner.

```
inbound  <@1111111111111111111> hidup?
             │
             ├─ adapter: is that id mine?  ──► mentionsSelf: true   (discord:nero)
             │                              └► mentionsSelf: absent (every other connection)
             │
             ▼
   router:  mentionsSelf + gatewayOwner ──► that agent            "mention"
            id / display name in text   ──► that agent            "mention"
            mentions present, none ours ──► nobody          "addressed_elsewhere"
```

Outbound, the same fact in reverse: the prompt hands each agent the **exact token to type** for every
other agent, taken from that agent's own connection (`Gateway.selfMention`).
Discord gives `<@id>`, Telegram gives `@username`; the engine never formats a mention itself, because
the syntax belongs to the platform.
An agent with no connection of its own falls back to `@<agentId>`, which the text matcher understands.

The adapter also strips *leading tags of itself* from the text.
Discord sends `<@self> /approve`, and both the command parser and the queue's urgency check only
recognise text that starts with `/` — so a tagged command was neither a command nor urgent, and
queued behind the very turn that was waiting to be approved.

### 12.4 Authorship, and the hop budget

Recognising our own bots is what separates a handover from a stranger's bot, and it is keyed on the
**message id**, not on the bot's user id — several agents can share one token, and then the author is
not knowable from the sender.

That record is keyed by **platform**, not by connection.
Keyed by connection it answered correctly only on the connection that *sent* the message and
answered *wrongly* everywhere else — `classifyInbound` reads "no known author" as somebody else's
bot and drops the message.
Handovers between agents on separate tokens could not work at all: the sender's connection deferred
to whoever was addressed, and the addressee's connection threw the message away as foreign.
Nobody ran, and nothing was logged as an error.

```
nouva ──sends──► "<@nexa> tolong riset"        recorded: (discord, chat, id) → nouva
                        │
     platform fans out  ├──► discord:nouva   author=nouva · tag is not mine → addressed_elsewhere
                        └──► discord:nexa    author=nouva · tag is mine     → nexa runs
                                                    │
                                              hops += 1
```

The hop budget lives beside that record and is therefore also per platform + chat.
Per connection it was six separate budgets for one exchange.
A human speaking resets it to zero; the exhausted notice is sent **after** routing, because it reads
"nouva and I have gone back and forth four times" and nothing knows who "I" is until then.

### 12.5 One turn per message

Where the routing signal is the same on every connection — a name in the text, a reply, the default
agent — all six reach the same conclusion, and the agent answers six times.

The claim is taken after routing and before any side effect, keyed by
`platform : chat : messageId : agentId`.

Keyed by agent as well as message on purpose: two connections that reach *different* conclusions are
not in conflict.
One message tagging two bots resolves to two different agents, and both should answer — collapsing on
the message alone would silence whichever arrived second.

### 12.6 One identity, four outputs

An agent says four kinds of thing, and each had its own idea of which connection to use.
The visible result was Nexa's request for approval posted under Nouva's name and avatar, followed by
"Nouva is typing…" for the whole time Nexa was working — and then `@Nouva /approve` looking for a
request that was never Nouva's.

```
                  voiceGatewayId(agentId, inboundGatewayId)
                                   │
      ┌───────────────┬────────────┴─────────┬────────────────────┐
      ▼               ▼                      ▼                    ▼
  final answer   progress bubble        approval prompt      typing indicator
  (pipeline)     (ChatProgress)         (index.ts notice)    (executor onTyping)
```

The resolver prefers the agent's own enabled, connected instance on the same platform, and falls back
to the inbound connection.
It cannot tell whether that bot was invited to *this room* — nothing in config says which channels a
bot is in — so a send may still fail, and the answer path falls back again rather than going silent.
A failed fallback is logged as `an agent's own connection could not deliver here`, and that log line
means one thing: **invite the bot to the channel.**

Approvals are answered per *conversation*, not per addressed agent, for the same reason: an agent
whose bot is absent cannot be addressed at all, so scoping the lookup to the addressed agent left the
operator with a prompt they could see and no way to answer it.

### 12.7 The access gate runs first

`admit()` is the first thing an inbound message meets — before the bot check, before routing.
Two consequences, both of which were live:

- **A bot must never be offered a pairing code.** A code is something a human reads and forwards; a
  bot does neither, and on a platform that fans out every message that code becomes a new unknown
  sender for every other connection. One tag produced twelve messages: three codes to the human, then
  three more for each bot that answered. Bots now pass the gate and are judged by `classifyInbound`,
  which is where "is this ours" has always belonged.
- **In a room, only the bot a stranger addressed pairs them.** The gate fires once per connection, and
  a platform hands a channel message to every bot in it, so every bot issued a code — a wall of codes,
  for messages that often named no agent. For a while the answer was a DM-only code, which left the
  room in silence and still opened a request on every connection. Now a connection treats a stranger
  as pair mode only when the message is for it — its bot tagged, its agent named, or a reply to what its
  agent said (`Admission.addressedHere`); every other connection answers as the allowlist would. The
  one that is addressed posts the code under the message, and the operator is alerted once.

---

## 13. Rooms

A **room** is one chat id on one connection, where one conversation lives: a WhatsApp group, a Telegram group or forum topic, a Discord channel, a Discord thread, a dashboard room.
Rooms are flat.
No server, guild or workspace is modelled above them, and no room has a parent.
A thread has a chat id of its own, so it is a room of its own.

What a room gets, with nothing per platform in the engine: its own conversation per agent, its background chatter (the room log), its `/mention` setting, its memory file, a row on the dashboard's Groups page, and a name `send_message` takes.

A room's name is read in one place, `roomName` (`apps/engine/src/modules/rooms/room-names.store.ts`): a dashboard room's own title; otherwise the operator's rename from the Groups page; otherwise the platform's name, asked of the adapter (`Gateway.roomTitle`) when a group message arrives and the name is missing or a day old, never awaited by the message.
Names are kept by the room as the platform sees it (platform + chat id), like `/mention`: several of our bots in one group read one name.
The memory vault's `groups/<…>.md` is storage, not a name.

A thread's opening message (`MessageEnvelope.threadOpener`) is filled by the adapter and put in front of the first question of a conversation in that thread (`pipeline/turn-request.ts`).

### 13.1 What a new platform's adapter does

Slack, Mattermost, Teams or the next one is an adapter, not a redesign:

- **`chatId` is the room where one conversation lives** — a group, a channel, a DM. A thread is its own room: its own id, or folded into `chatId` (Telegram's `${chat}:${topic}`). Never a server or workspace.
- **`chatType`**: `dm` for one person, `group` or `channel` for a room.
- **`roomTitle(chatId)`**, optional: the room's own name as people see it — a group's subject or title, `#channel`, a thread's own name. Never the server's or workspace's, nothing for a DM, `undefined` when unknown, never a throw for a room the bot cannot see. The engine asks rarely and does not wait.
- **`threadOpener`**, optional: on a message in a thread started from another message, who wrote that message, its text, and where. Fetched once per thread; never for the message that is the thread's start.
- **`senderName` is the platform's display name** and `senderId` the account `[[people]]` holds; the engine names the person by `[[people]]` wherever it shows a name.

Everything in the paragraph on what a room gets, above, then comes with it.

