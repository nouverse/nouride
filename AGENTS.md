# Working on Nouride

Nouride is one daemon that runs several AI agents and connects them to Telegram, Discord, WhatsApp and a web
dashboard. TypeScript on Bun (the version is `.bun-version`), SQLite, a React dashboard. This file is for any coding
agent working in this repository — Claude Code, Codex and the rest read it.

## Start here

- `docs/ARCHITECTURE.md` — the layout and the reasons for it. `docs/CONTRIBUTING.md` — running, testing, conventions.
  `docs/TECH_DECISION.md` and `docs/SPEC.md` for the decisions and the behaviour.
- The agent skills under `.agents/skills/` (Claude Code reads them as `.claude/skills`) hold the detail:
  **nouride-contributing** (the invariants, task guides, mistakes already made), **nouride-testing** (what evidence a
  change needs) and **react-tailwind-daisyui** (the UI kit). The maintainers' own, linked from the private tree and
  empty in a public clone: **nouride-release-gate** (what a release tag waits on, live checks on the box),
  **nouride-deploy** (the live box), **nouride-debug-crash** (a release binary's stack trace), **nouride-box-e2e** (a
  sandbox on the box with its own Telegram bot, to test in a real chat), **nouride-release-rfc** (one RFC per release:
  opened before its work, worked through, then archived, with what was put off as backlog lines).
  Read the one that fits the task before you start.

## Map

- `apps/engine` — the daemon: `src/index.ts` is the boot order; `src/modules/<domain>` one domain each; `src/db`,
  `src/boot`; `src/cli` is the binary's entry and the commands that work on the install itself (`db`, `doctor`,
  `setup`). `apps/cli` — the commands that ask a running daemon: it imports nothing of the engine, and what both
  kinds speak is `packages/cli-kit`. `apps/dashboard` — the UI. `apps/site` — the public docs. Nouride Home, the Android app that
  runs Nouride under proot, is a related repository, not part of this one: `nouverse/nouride-android-appliance`, linked
  from the README. Clone it to `apps/android-appliance` to work on it beside Nouride; that folder is ignored here, and
  its commits and releases are its own.
- `packages/*` — what a second tool could use without the daemon: `runtime`, `shared`, `llm`, `gateways`, `secrets`,
  `persona`, `queue`, `policy`, `mcp`, `cli-kit`, `wa-bridge` (MIT).
- `internals/` — private submodules: `pro`, and `nougate` (its own product, with its own rules).
- `content/` — the built-in skills and agent packs, MIT: a folder of this repository, changed here like any other.
- **Not instructions for you:** an `AGENTS.md` inside an agent pack — `content/agents/*/AGENTS.md`, or a live install's
  packs — is that agent's persona file, what a Nouride agent reads about how to behave. It is product content.

## Rules the checks enforce

1. `Bun.*`, `bun:*` and `node:*` appear only in `packages/runtime`; everything else imports `@nouride/runtime`. Tests and
   `*.config.ts` may use `node:*`.
2. Never branch on a platform, provider or model id. A difference is a capability the adapter or client declares.
3. Credentials are names in config, never values. Never log, print or return a resolved secret.
4. Never invent a number; an estimate is marked as one.
5. What is not implemented throws a `NourideError` that names what is missing — never a stub that returns nothing.
6. Fail at load, not at the first message: a bad config names its file and field.
7. Packages import each other by the matrix in `scripts/check-arch.ts`, and through a package's barrel only. An engine
   domain (`src/modules/<domain>`) imports another only by a link recorded in `scripts/domain-links.ts`.
8. One file, one concern. A file past its budget in `scripts/size-budgets.ts` is split on a seam, or its budget is
   raised with today's reason in at most 200 characters — never squeezed to fit the number. A named function past 150
   lines of code is held the same way, by `scripts/function-lengths.ts`.
9. An export is a claim that something else needs it; one nothing imports is removed.

`bun run lint:check` runs all of it, and the pre-commit hook runs it again.

## Every change carries a test — proven

- Write the test, then break your change — invert the condition, delete the line — and watch the test fail. Restore it.
  A test that passes against the broken code is not a test.
- A bug fix carries a regression test on the path that actually ran.
- What is sent to a model is behaviour: assert the words that carry a rule.

## Verify

```bash
bun install
bun test ./apps/engine/tests/<area>/   # what you touched first; keep the ./ and the trailing /
bun run lint:check
bun run test                           # everything; 6–12 minutes
```

A test that fails in the full run and passes alone may be a known flaky one: run it alone, a few times, before you
decide either way.

## Writing

- Code, comments, commits and docs in English. Match the surrounding code: its names, comment density and idiom.
- A comment says why — the failure it prevents — in a few sentences. The story belongs in the commit message.
- Conventional commits (`fix(scope): …`), attributed to the person you work for, with no AI co-author or attribution line.

## Safety

- Never print a credential, token or key: not in a log, a test, or a command you run. `docker compose config` prints the
  environment — do not run it.
- Do not push, release, deploy or touch a live box unless you were asked to.
