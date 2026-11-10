---
name: nouride-contributing
description: How to work on Nouride — the runtime adapter boundary, provider profiles and named gateway instances, the secret store, persona packs, the turn executor and tool sandbox, Nouride's design rules for every interface (its soft look and its mascot), the writing rules for every text a person reads, and the mistakes that have actually been made here. Use when touching config, adding a gateway or LLM wire format, changing the prompt or context window, writing tools, running and testing this repo, designing or reviewing UI, or writing or editing docs, release notes and copy — including checking a draft for AI slop.
---

# Contributing to Nouride

Nouride is a single-daemon multi-agent runtime: chat platforms deliver messages, a router
picks an agent, and that agent runs a tool-call loop against any OpenAI-compatible or
Anthropic endpoint. Agents are directories of markdown; everything with a lifecycle is in
one SQLite file.

Read `docs/ARCHITECTURE.md` for the layout and `docs/TECH_DECISION.md` for why the stack is what it
is. This skill is the operational layer on top of them: the invariants that keep the
codebase coherent, and the specific ways it has gone wrong.

Each invariant below corresponds to a bug that was written in this repo. They are not
style preferences.

> **Two unrelated things are called "skills" here.** `agents/*/skills/**/SKILL.md` are
> *agent* skills — instructions loaded into an agent's prompt at runtime, and writable by an
> agent through `skill_create`. This file is a *Claude Code* skill about the codebase. They
> never interact.

> **The CLI is the operator's interface; tools are the agent's.** An agent learns what it can
> do from the generated harness block in its prompt, and acts through typed, individually
> gated tools.
>
> This used to say the agent "deliberately has no path to the `nouride` CLI: the control API needs
> a token". That is wrong about the mechanism, and it was checked. Run the CLI inside `exec`'s exact
> sandbox — argv array, the `PATH HOME LANG TZ TERM` allowlist, no `NOURIDE_TOKEN` — and
> `nouride agents` prints the live agent list. The agent never needs to be handed the token, because
> the CLI's client (`packages/cli-kit`) reads `dataDir/.control-token` itself and `HOME` is in the allowlist. What actually
> stands in front of it is that `nouride` is not in the default exec allowlist — which the default
> `mode = "full"` never consults. One `exec` approval reaches it, and `classifyHardline` returns
> nothing for `nouride approvals allow-always` or `nouride config set security.exec.ask off` (a verb gone since: exit 2).
>
> Since T59 the CLI is itself a tool — `nouride`, an adapter that forwards to `exec`'s gate and
> sandbox — so an agent can hold the daemon's control surface without holding a general shell.
>
> So the case for typed tools is not that the CLI is unreachable. It is that a tool is gated
> individually with a preview of what it will do, audited by name and arguments rather than as one
> command string, and answers the model in a shape it can act on instead of ANSI meant for a
> terminal. And it is the only surface left on an install tightened to `mode = "allowlist"`, where
> the CLI genuinely is gone.

---

## The philosophy: secure without sacrificing UX

The owner's words (2026-10-18): *"dibikin aman/secure tanpa mengorbankan UX, itu filosofi nouride"* — make it safe
without giving up the experience; that is Nouride's philosophy. Nouride runs an agent with a shell on somebody's own
machine, talking to them through the chat apps they already use. A protection that makes that tedious gets switched
off, and then it protects nothing; an experience bought by dropping a protection is a hole somebody falls into later.
Neither side wins by default. Every change that touches either is held to both, and these are what that has meant in
practice:

- **Safe is the default, and the safe path is the easy one.** Credentials are names, never values (invariant 3);
  a secret sent in chat is taken out before anything stores it, and the agent works with a handle instead of the
  value (0.7.17). Nobody has to remember to be careful for these to hold.
- **Security decisions are code, never the model's discretion.** What is redacted, what asks, who may answer: a
  regex, a gate, a rule in `@nouride/policy`. A model can be talked out of anything; a deterministic check cannot.
- **Friction only where the danger is, and once.** An approval that fires on every call teaches people to wave it
  through. Ask for the narrow case — a secret used after the turn read a web page, a recursive delete outside a temp
  root — and ask once per turn rather than per call.
- **Cheap to answer.** One tap (Approve and Deny buttons on Telegram and Discord), the consequence said in the
  question, the safe answer one keystroke away (`useConfirm`).
- **Say why, and say how to turn it off.** A prompt that asks names what triggered it and the command or setting that
  stops it for this agent — for the people allowed to change it. Turning a protection *off* is guarded (an admin,
  the dashboard, `config.toml`: `/approvals trusted` cannot be set from a chat, because a chat sender is not
  authenticated); turning it back *on* never is.
- **Recoverable mistakes.** A false positive has an undo; a delete has a confirmation; a migration has a snapshot
  and `nouride db restore`.
- **Simple to run.** One switch, not two; one rule, not a rule and its exceptions; delete means deleted everywhere.
  The owner's words (2026-10-18): *"itu saja simple jangan dibikin ribet"* and *"tinggal ganti 1 baris"*. So
  `CI_RUNNER` moves every job of every workflow, signing included, and deleting a secret takes it out of every
  agent's `exec_secrets` too, with the question naming what uses it. A second knob for a special case is one more
  thing somebody has to remember, and the one they forget.

When a change cannot satisfy both, say so in the change and ask the owner which way to lean — do not quietly trade
one for the other. Ask in plain words: what it is, the risk, your recommendation, in a few sentences and with a
one-word answer to give — not a list of options full of job names and variables. A direct instruction from the
owner is carried out, and reported briefly.

---

## The sixteen invariants

**1. `Bun.*`, `bun:*` and `node:*` appear only in `packages/runtime`.** Business logic imports
`@nouride/runtime`. That is TD-001's portability discipline, and `bun run lint:arch`
fails the build if it drifts.

The Node half is the one that leaked: `Bun.*` was enforced from the start so nobody
wrote it, while `import { join } from "node:path"` sat in fifty files — and "what would
a port have to touch" stopped being answerable from the dependency graph. Some of what
the barrel now re-exports (paths, hashes) is pure computation every runtime ships; it
goes through the barrel anyway, because the value is the single list, not the indirection.

The rule is on the *specifier*, in every form one can appear — so `from "path"` is the
same violation as `from "node:path"`, and a dynamic `import("node:os")` or a bare
`import "node:worker_threads"` is caught too. The first version of the lint matched only
`from "node:…"` and let four spellings through; each one is now planted in a comment
above the check so the next narrowing has to argue with them.

Three exemptions, all narrow. `bun:test` is the sanctioned test runner rather than a
runtime API. **Test files and `*.config.ts` may import `node:*` freely** — a fixture that
makes a temp directory is not shipped, so putting `mkdtempSync` in the adapter would grow
its surface for nothing that runs in production. And `internals/` is skipped wholesale: a
private plugin is its own repository and may not import `packages/*` at all (§3
ARCHITECTURE). `packages/wa-bridge` is not one of those — it is a workspace member and follows
the rule like every other package, through `@nouride/runtime`.

```ts
// Right
import { join, readTextFile, openDatabase } from "@nouride/runtime";

// Wrong — both of these, and invisible until someone tries another runtime
import { join } from "node:path";
import { join } from "path";
const text = await Bun.file(path).text();
```

A module-relative path is worth a second look while you are here. `new URL("../../../x",
import.meta.url)` encodes a depth count that no test covers and no type checks, so it
silently breaks the moment the file moves — which is exactly what happened to the
dashboard lookup in `web/server.ts` during the `modules/` split: `/health` stayed green
and `/dashboard/` served 503. Count from `moduleDir(import.meta.url)` and say in a
comment what the levels are counting to.

**2. Never branch on a platform or provider id.** A Discord message limit belongs inside
the Discord adapter; the engine hands `send()` arbitrary text and the adapter chunks it.
If behaviour differs per platform, it is the adapter's job, not a conditional in shared
code. Same for LLM wire formats: `kind` selects an implementation, and nothing downstream
asks which vendor it is.

```ts
// Wrong: every new platform now needs edits in the engine
if (envelope.gateway === "discord") text = text.slice(0, 2000);
```

**3. Credentials are *names* in config, never values.** `api_key = "nougate"` names a
secret; `@nouride/secrets` resolves it environment-first, store-second. Never log a
resolved value, never return one from an HTTP route — `inventory()` deliberately exposes
names and origins only. A value pasted where a name belongs is refused, because that
mistake commits a live key into `config.toml` and still appears to work.

**4. Never invent a number, and flag every estimate.** Nougate returns no `usage` field
at all on its OpenAI-compatible path. Recording that silence as zero made the daily cost
cap fail open — a spend limit that never trips. Usage we compute ourselves carries
`estimated: true`. An unpriced model is reported unpriced, not given a plausible rate.

**5. Unimplemented throws.** A `NourideError` (`@nouride/shared`) that names what is
missing. A stub that returns `[]` or resolves silently looks like a working feature that
found nothing, and costs hours to diagnose. This is why a build without the gateway refuses
`[nougate] in_process = true` at boot rather than ignoring it.

**6. Truncate conversation history in whole turns.** A `tool_result` whose `tool_use` was
trimmed away is rejected outright by Anthropic and confuses OpenAI, so a mid-turn cut
converts a long conversation into a hard error — exactly what truncation exists to avoid.
`groupTurns()` is the unit; never slice a message array directly.

**7. Fail at load, not at an agent's first message.** A mistyped provider profile, a stale
gateway binding, a skill named in a pack that is not on disk: all validated while loading
the pack, with the file and field in the message. Credentials are resolved lazily (a
profile nobody uses should not need a key), so boot *warns* about an active agent whose
secret is missing rather than letting it fail hours later at the first turn.

**8. Errors are shaped for their audience.** Chat users get `toUserMessage(err)` — never a
stack trace, a status code, an upstream body, or a filesystem path. Logs get everything.
Tool failures are returned as tool *results* with `isError: true`, not thrown: the model
reads them and adapts, which is a better recovery path than aborting the turn.

**9. Prove the test catches the bug, and test the path that actually runs.** Break the
fix, watch the test fail, restore it. And check which code path the default config takes:
`llm.streaming.enabled` defaults to true, so a test double returning JSON exercised
nothing — the stream parser found no events and quietly produced an empty answer.

**10. Inter-package imports follow each package's `package.json`.** A package imports the siblings its
manifest declares and no others; with Bun's isolated linker that is also what resolves after a clean install,
so the manifest *is* the matrix. `bun run lint:deps` (`scripts/check-deps.ts`) enforces both directions — an
import the manifest does not declare, in any spelling including `await import(…)`, and a declared dependency
nothing imports — and refuses a cycle. A new cross-package dependency is one line in `package.json` and the
import that needs it. `lint:arch` keeps the rules a manifest cannot state: `shared` imports nothing, and only
the dashboard and other `ui-*` packages import a `ui-*` one.

```
shared   →  (nothing)
runtime  →  shared
secrets  →  shared, runtime
llm      →  shared
queue    →  shared
policy   →  shared, runtime
persona  →  shared, runtime, secrets, policy
gateways →  shared, runtime
mcp      →  shared, runtime
update, system-packages, wa-bridge  →  runtime
```

Inside the engine, each folder of `src/modules/` is a domain, and one imports another only by a link
`lint:domains` has recorded (`scripts/domain-links.ts`). The links there when the rule began are listed as
found; before adding one, ask whether the caller can be handed what it needs through a port at boot, which is
what `boot/` is for. If not, add the link with the reason the one domain needs the other.

**11. Import from the barrel, not the internals.** `from "@nouride/llm"` — never
`from "@nouride/llm/src/anthropic"`. Every package's public API is its `index.ts`;
reaching past it couples callers to internal file layout and makes any refactor breaking.
`lint:arch` catches deep imports automatically.

**12. One file, one concern — and no file grows past a few hundred lines.** A file you have
to scroll to navigate is one nobody reads before editing, and the failure it produces is
always the same: two places that should have agreed, and nobody noticed they had drifted.

This is not a style preference either. `web/control.ts` reached 1813 lines and 72 routes
inside a single `mountControlRoutes`, so route ordering — which Hono decides by
registration order — was an accident of position in a long file rather than a stated
rule. The old `modules/pipeline.ts` reached 2629 lines and twenty-eight private members, which meant the
three things that run turns all had to live in it to reach the five helpers they shared.

Rules of thumb, in the order they actually help:

- **Split by concern, not by size.** Cutting a 900-line file in half at line 450 produces
  two files that are each half a thing. Ask what the file *is* — routes for one domain, a
  gate that owns a table, the strings a person reads — and cut on that seam.
- **A directory with an `index.ts` is the shape.** `web/control/` wires and does not
  handle; `web/control/routes/*.ts` handle and do not wire. `modules/pipeline/index.ts`
  is a composition root: build the collaborators, delegate the public API, own nothing.
- **State goes with the code that maintains it.** The three bounded tables in the pipeline
  — rate limit, claim, drop-notice throttle — have each grown without bound at least once.
  Together in `Admission` they are one file where "does this table have a ceiling" is a
  question you can answer by reading it.
- **Pure functions come out first, and they are the cheap win.** The body parsers in
  `control/payloads.ts` and the strings in `pipeline/messages.ts` were the testable part
  of a handler, buried in it.
- **Name the coupling instead of hiding it.** When a split needs a caller to reach eight
  things, pass them in a constructor (`TurnContext`) rather than reaching back through the
  parent. The argument list *is* the documentation, and a long one is a finding, not a
  failure.
- **A long file that is one list is fine.** `policy/hardline.ts` is a data table and
  `config/defaults.ts` *is* the schema; splitting either would hide the thing it exists to
  show. So is `src/index.ts`, up to a point: boot order is what it documents, so lift out
  everything that is *not* ordering (see `src/boot/`) and leave the sequence linear.

If you are adding to a file that is already over ~500 lines, the split is part of the
change, not a follow-up someone else will do. The same holds inside a file: `lint:functions` refuses a
named function past 150 lines of code, and a recorded one that grows (`scripts/function-lengths.ts`).

**13. An export is a claim that something else needs it.** `lint:deadcode` fails when an
exported function, const or class is named by no other file — the case `noUnusedLocals`
structurally cannot see, because TypeScript counts the `export` keyword itself as a use, so a
symbol nobody imports still looks live from inside the module that declares it. Who imports what is
resolved by specifier (`scripts/export-graph.ts`), not matched by name: a barrel's re-export passes a
use through rather than being one, a namesake in another file is not one, and a test is counted
apart — an export only tests import, and nothing in its own file uses, is production code its test
keeps alive. Move a test double into the tests, delete the wrapper, or — for a real seam, a reset
of module state or a list a contract test holds — name it in `TEST_ONLY_EXPORTS` with its reason. It also fails on
a table a migration creates and no SQL names, and a module no `import` reaches statically or
dynamically.

The fix is almost never "add a caller". Drop the `export` and let `tsc` decide: if the symbol is
still used inside its own file it compiles and the surface shrank; if it is not, `noUnusedLocals`
fires and the honest answer is to delete it — git has it, and a two-line wrapper is cheaper to
re-add than to carry. Exported *types* are deliberately not checked: an interface used only by its
own signatures costs nothing at runtime, and checking them produced 239 findings against 44 real
ones, which is the ratio at which people learn to skip a rule.

**14. The event stream is a contract, not an implementation detail.** Its readers are not upgraded
with the daemon — a dashboard tab left open, `nouride events` pointed at another box, an editor —
so a row that changes shape breaks them silently. 0.7.4 shipped a stream whose rows were whatever
each writer happened to pass, and a `waiting` row meant two different things before anyone wrote
down what it carried.

What a kind carries is declared once, in `EVENT_CONTRACT` (`packages/shared/src/types/events.ts`);
the types are derived from it, `docs/EVENTS.md` describes it, and `docs/contracts/events.lock.json`
is it written out. Within a major version a change only *adds*: a new kind, or a new key that is
optional. Never remove, rename, retype or reuse a key, and never cut an identity key (`step`,
`callId`, `name`, `phase`, `status`, `from`, `reason`) when a row is too large. Changing it is
three edits a reviewer sees together — the contract, `bun run scripts/events-contract.ts --write`,
and a minor version with a line in `docs/contracts/EVENTS_CHANGELOG.md` — and
`tests/contracts/events-contract.test.ts` refuses anything less: it runs the daemon's own writers
and checks every row against the contract, holds the lock to the frozen 1.0 baseline, and compares
the dashboard's kinds and the doc's table with it.

Two rules follow from "a reader ignores what it does not know". A writer never relies on a reader
knowing a new kind or value. And rows that belong together are written in one transaction
(`EventStore.batch`), because a reader is told about a row only once it is committed — the `audit`
row and the `tool_done` of one tool call arrive together or not at all.

**15. No timer callback lets an exception out.** Nothing is above a `setTimeout` or `setInterval`
callback to catch what it throws, so a throw there is an uncaught exception — and the daemon shuts
down on one, deliberately (`boot/shutdown.ts`). 0.7.10 found the provider-resume timer reading a
database a few minutes after it failed: a busy or closed database at that moment would have ended
every conversation on every gateway to report one retry. Wrap the body in `contained(log, "what
failed", body)` (`@nouride/shared`) — one line in the component's own log, and the timer carries on
— or, where failing should do more (settle a waiter, try again later), do that in the body and let
`contained` hold what is left. `lint:timers` refuses any other timer callback in daemon code unless
it is a form that cannot throw: a promise's own `resolve`/`reject`, `.abort()`, a clear, an
assignment. An event's listener is held the same way — `.on`, `.once`, `addEventListener`, `signal.onabort` — since
whatever emits it is the event loop too, and `contained` passes the event's arguments through.

**16. Work nobody watches says what it did, and a failure that repeats reaches where an operator looks.** Every
background process — compaction, the memory pass, reflection, delegation, jobs, a fallback to another model — logs its
start, its success and its failure, each with its model, its numbers (tokens, turns, items, how long) and its reason.
A failure that keeps happening is put where an operator already looks — `nouride doctor`, `/health`'s issues, the
dashboard — not left as one `warn` at a time in a journal nobody tails.

The reason is one debugging session. On 2026-10-20 a WhatsApp group had Nouva verify 52 audit documents over four
hours; the conversation reached 453 messages and ~150k tokens a request, the agent lost its place, and finding out why
took inference at every step. Compaction had been failing all afternoon — a pass model that had gone away, one `warn`
each time. Replies had been cut at the output limit three in a row, and that was read off output counts that stopped at
exactly 8192, because nothing kept the provider's `length`. A delegate was nudged to stop and report, and whether the
nudge ever reached it could not be read: its steps were its job's log and nothing else.

What holds it now, and what a new background process owes:

- **Every model call is recorded through the one seam, with its purpose and its stop reason** — `meter()` in
  `llm/metered.ts`, a row of `llm_usage` with `purpose` and `stop_reason` (`069_baseline.sql`). The reason
  rides on the provider's own usage, so a caller that passes the usage on cannot drop it, and one that writes it out by
  hand can. `tests/contracts/usage-recorders.test.ts` reads every call site: the store written by the meter alone,
  every meter and every metered provider naming a purpose, every executor metered, no usage written by hand but for
  the two purposes that are no generation.
- **Delegated work is a turn of its own** (`pipeline/delegated-turn.ts`): a helper or an ask in the background is
  recorded like a chat turn — its steps, each nudge it read, its report — and its job's log names it.
- **Each request says what it carried** — a `context` row per model request: about how big, the tool results cleared
  out of it and where they were kept, whether a summary was in it.
- **A failure that repeats is counted where it is shown** — `llm/helper-trouble.ts` reads the day's log for
  compaction, the memory pass and the fallback, and `/health` and `doctor` say what has been failing.

So a new background process logs its three lines, meters its model calls through `meter()` with a purpose of its own —
added to `USAGE_PURPOSES`, which the contract test then makes you place as a generation or not — and, if its failure
can repeat, is added to what `helper-trouble.ts` watches. "It logs a warning" is not done.

---

## Repo map

The engine follows the same shape as `apps/dashboard` and the other Nouverse backends:
`commons/` for what everything uses, `modules/<domain>/` for a domain, and entry points at
the top. Engine-internal imports go through the `@/` alias (`@/modules/pipeline/index.ts`),
never a relative `../../..` chain.

**`modules/<name>` is a domain — something the daemon *does*, that you could name in the
product.** How the daemon is stored, hosted or built is not a domain and lives outside it:
`db/` is the schema, `service/` is how a host keeps the process alive. The test is not "who
imports it" — half the domains are widely imported too — it is *"would this file be
identical in a different product?"* If yes, it is not a module.

```
apps/
  engine/src/
    index.ts        boot ORDER + graceful shutdown — read this first
    boot/           what boot does but does not order: its three long steps (stores,
                      timers, turn-machine), preflight, maintenance, tools,
                      control-plane, shutdown
    cli/            main.ts is the binary's entry: it hands apps/cli the install it runs in.
                      commands/<name>.ts here is a command that works on the install itself
                      (db, doctor, config, setup, service), daemon up or down
    db/             open SQLite, apply migrations, and the migrations themselves.
                      Storage, not a domain — the whole directory would be the same
                      in any product with a SQLite file
    service/        supervisor detection + systemd/launchd units. About the machine,
                      not about agents — `nouride service install` is its only caller
                      besides boot
    commons/        cross-cutting: audit, notify, activity, context, log-buffer
    modules/        one directory per domain; the ones met first:
      pipeline/     gateway → router → queue → hook or turn → reply.
                      index.ts composes; inbound.ts decides; turn.ts runs;
                      admission/voice/room-memory own their own tables
      config/       defaults.ts IS the schema; global/ parses onto it
      sessions/     conversation persistence, keyed by gateway INSTANCE
      router/       mention > gateway owner > channel binding > default
      llm/          providers (profiles→clients), executor (tool loop), prompt, context
      tools/        registry, approval gate, builtins/{files,exec,memory,web}
      hooks/        slash commands, handled instead of an agent turn
      gateways/     the engine's own half: the in-process WhatsApp bridge and nougate,
                      the local gateway
      web/          Hono: /health, static dashboard, and control/ — one file per
                      route domain, wired in control/index.ts
  cli/src/          the commands that ask a running daemon over the control API: run.ts is
                      the dispatch table, commands/<name>.ts one command, install.ts what the
                      binary's entry hands in. Imports nothing of the engine (lint:arch)
  dashboard/        React 19 + Vite + TanStack + daisyUI, base /dashboard/

internals/          private, two submodules, never workspace members
  pro/              nouride-pro: appliance, multi-user, oauth, build-pro, docs (own workspace)
  nougate/          the LLM gateway, its own product

packages/
  wa-bridge/ the WhatsApp bridge, run in-process — MIT, `packages/wa-bridge/LICENSE`
  update/    checking for and installing a release
  system-packages/  nouride-pkg: system packages through a root service
  shared/    types, envelope, logger, errors — imports nothing
  cli-kit/   what a command speaks on either side: output, arguments, help text, the
               client, the answers the CLI expects — imports nothing of the engine
  runtime/   the only Bun.* and node:* in the codebase
  secrets/   named credentials: env, or a writable store
  llm/       OpenAI + Anthropic clients, SSE, token estimation, price book
  queue/     keyed queue: ordered per key, parallel across keys
  policy/    exec permissions: the fixed list, approval levels, grant identity
  persona/   agent pack loader, and the registry: discovery, pause/resume, hot-reload
  gateways/  Discord / Telegram / WhatsApp adapters
  mcp/       MCP client: stdio and HTTP transports
  wire/      the control API's payload types, types only: a payload the engine and the dashboard
               share is declared here once, never copied into the dashboard (ARCHITECTURE §3)

content/
  agents/    an example pack an operator copies — never shipped, never loaded
  skills/    the built-in skills every install ships
.nouride/     a local install (gitignored) — one directory per install:
               config.toml, data/ (SQLite, secrets, attachments), agents/ (the packs and
               the skill pool), workspace/
               workspace/shared is every agent's working directory; workspace/private/<id>
               is one agent's own. The pack is NOT a workspace — see references/agents-and-turns.md
```

**Package or engine?** One test: *could a second Nouverse tool use this without dragging
the daemon along?* Speaking a wire format, ordering work per chat, reading a persona
directory — yes. The tool loop, the router, the approval gate — no, they only mean
something in terms of an agent registry and a session store.

---

## Task guides

Load the file that matches what you are doing:

| Doing this | Read |
|---|---|
| Running, testing, debugging, verifying a change is live | `references/workflow.md` |
| Operating the daemon: chat, doctor, approvals, gateways | `docs/CLI.md` (repo root) |
| Adding a config key, provider profile, gateway instance, secret | `references/config-and-secrets.md` |
| Persona packs, prompt assembly, context window, the turn executor | `references/agents-and-turns.md` |
| Adding or changing a chat platform adapter | `references/gateways.md` |
| Adding an LLM wire format, streaming, usage, cost | `references/llm-providers.md` |
| Writing a tool, touching the sandbox or approval gate | `references/tools.md` |
| Writing or reorganizing documentation | `references/docs.md` |
| Designing or reviewing an interface — the dashboard, the site, any Tailwind and daisyUI screen: palette, type, motion, layout | `references/design-rules.md` (a public page: also `references/design-book/taste.md`), and the `react-tailwind-daisyui` skill for the code |
| Writing anything a person reads — docs, release notes, UI copy, a reply's wording — or checking a draft for AI slop, in English or Indonesian | `references/writing-rules.md` |
| Proving a change, fixing a bug: which evidence | the `nouride-testing` skill; a release's gate (maintainers): `nouride-release-gate` |

---

## Every change comes with a test

**Not "should". A change with no test is not finished**, whatever the suite says about the rest of
the repo.

The reason is specific rather than doctrinal. This codebase has several thousand tests, so "all tests pass" is
the default state of a broken change and reads exactly like a working one. Two guards were shipped
here that nothing exercised, and it took deleting them to notice: the suite was still green with
both of them commented out.

So the bar is behavioural:

**Sabotage it and watch it fail.** Break the thing you just wrote — invert the condition, delete the
line, return the wrong value — and confirm a test goes red. Then put it back. If nothing fails, the
test is decoration and you have not tested the change. Do this before you claim it is done; it takes
one command and it is the only evidence that the test is attached to the behaviour.

Four ways a test passes for the wrong reason, all of them found in this repo:

- **The guard was never reached.** A traversal test asked for `../../../config.toml`, which does not
  exist from a temp directory, so it missed for the wrong reason and passed with the boundary
  deleted. Plant a real file the guard is the only thing standing in front of.
- **The loop never went round twice.** A round-cap test scripted a provider that asked once, so the
  cap was never exercised. Make it ask forever.
- **The first branch shadowed the one under test.** A cooldown test used the *create* path, where
  "a skill of that name already exists" fires long before the code being tested. Use the path the
  failure actually took.
- **The property was true anyway.** A stability test asserted that two identical queries return the
  same order — which SQLite does regardless. Assert the property only your change provides.

**Test the decision, not the plumbing.** If reaching the behaviour means building five
collaborators, that is the code telling you the decision wants to be a function. Extract it and test
that; the extraction is usually the better shape anyway.

**Which evidence a change needs beyond its unit test** — a regression test for a bug, the upgrade run for anything an
older install can hold, a manual end-to-end for what no test reaches — is in the `nouride-testing` skill. Read it
before saying a fix is done; the gate a release tag waits on is the maintainers' `nouride-release-gate`.

**A prompt is behaviour too.** Instructions sent to a model are asserted on directly — the wording
that carries a rule, the order of sections where order decides which rule wins, and the *absence* of
anything install-specific. Prompts ship in the binary, so a test that they name no real skill, host
or address is the thing that stops somebody's infrastructure reaching a release.

## Before you say you are done

```bash
bun run verify    # lint:check (every static check — the table in docs/CONTRIBUTING.md) + the whole suite
```

Or the two halves separately, which is what `verify` runs:

```bash
bun run lint:check                 # imports, SQL, size, dead code, pointers, public tree, types…
bun run test                       # never `bun test ./internals/` by hand — see below
```

**The pre-commit hook runs only the first half**, from `.githooks/pre-commit`: lint, the skills link, the
dead-code rules and every typecheck, and two contract tests that take half a second (`test-waits`, `dashboard-wire`),
about half a minute on a laptop. A clean merge runs the same through `.githooks/pre-merge-commit`. Both are versioned
rather than left in `.git/hooks`, which is not cloned; `bun install` points `core.hooksPath` at them through the
`prepare` script, so a fresh checkout is covered without being told.

**So a green commit does not mean the tests pass.** They used to run here and were the slow half by
a factor of five — 28 seconds against 6, on every commit including the ones that only touch a
comment — and a commit on a branch is usually a checkpoint rather than a claim that anything works.
Run `bun run verify` before you push; that is where the claim is made. There are no pull requests: commit to the
release branch and push it; `main` is fast-forwarded to it when the release is tagged.

Nothing about the *value* of the whole suite changed, and it is still the whole suite rather than a
staged-files subset, because this repo's failures are consistently the kind a static check misses: a
rename inside a SQL string that only the tests could see, a config change that only shows up at
boot, a deleted tool leaving a dead name in a defaults list. `git commit --no-verify` skips even the
lint half, for a work-in-progress commit on a branch and not for main.

Always run the suite through `bun run test`, never by spelling the sweep out. `internals/nougate` is a
submodule with its own root and its own test command, and the script's `--path-ignore-patterns`
excludes it. `verify` respelled the sweep without that flag for a while, so it failed on tests that
were never ours to run — and it was the pre-commit hook, which did use the script, that hid it.

`lint:types` is `scripts/check-types.ts` — every `tsconfig.json` under `apps/`, `packages/`, `scripts/` and the
Pro tree, found rather than listed, run concurrently; `typecheck-coverage.test.ts` fails on a TypeScript file
none of them takes in. It used to be two (`apps/engine`, `apps/dashboard`). Package *source* was still covered, because the engine imports it,
but package *tests* were checked by nothing: `gateways`, `runtime` and `shared` excluded them from
their own `include` and `packages/mcp` had no tsconfig at all. Twelve real type errors were sitting
in them — a fixture missing a required field, a test reaching past `protected`, an assertion naming a
persona slot deleted a year earlier. `bun test` does not typecheck, so every one of them passed.

`noUnusedLocals` and `noUnusedParameters` are on. They exist because a deleted tool left its helper
behind and nothing noticed: dead code here is usually the tail of a removal, and the compiler finds
it for free. A parameter that is deliberately ignored takes a `_` prefix — `buildApprovalPreview`'s
`_tool` is the example, and its own doc comment says why.

Then, for the surface you touched:

- **Boot it.** `PORT=3999 bun run apps/engine/src/index.ts` — `/health` returns 200 and
  the log has zero `"level":"error"` lines. A config change that breaks pack loading shows
  up here and nowhere else.
- **Docker, if you touched the Dockerfile, a package manifest, or compose.**
  `docker build -t nouride:check .` then run it and hit `/health`. Bun's isolated linker
  makes this fail in ways local dev cannot reproduce.
- **A real endpoint, if you touched the LLM path.** See the live-testing rules in
  `references/workflow.md` — scratch directory, key from the environment, deleted after.

Report what you actually verified. "Tests pass" means you ran them. If something is
unverified — a gateway with no bot token, for instance — say so plainly instead of
implying coverage.

Commit only when asked.
