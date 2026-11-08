# Contributing to Nouride

This guide covers what you need to work on the codebase. A coding agent starts at `AGENTS.md` in the
repository root: the rules the checks enforce, how a change is proven, and where the detail lives — the
contributing skill under `.agents/skills/`, with invariants, task-specific references, and a catalog of past
mistakes, and the testing skill beside it.

---

## Before your first pull request

Nouride is source-available under the Functional Source License (`LICENSE`), and Nouverse sells editions of it:
Pro, a hosted service and Enterprise. So a pull request is merged only once its author has agreed to the
[Contributor Licence Agreement](./CLA.md). You keep the copyright in your work; Nouverse may use it in every edition,
and under other licence terms later.

You agree once, by commenting on your first pull request:

> I have read the CLA Document and I hereby sign the CLA

If you contribute as part of your job, check with your employer first: section 5 of the agreement asks you to. To
agree for a company or organization, contact Nouverse through https://nouverse.com before you start.

---

## Prerequisites

- **Bun 1.4.4** — runtime, package manager, test runner: `.bun-version`, which CI, the images and
  the types all read
- **Docker + Compose** — for containerized dev (`run-dev.sh`), optional for native

```bash
bun install
```

`content/` — the built-in skills and agent packs, MIT — is a folder of this repository: every build ships it and the
tests read it. The private submodules under
`internals/` are not needed for the free edition: a clone without them builds and tests it (`ARCHITECTURE.md` §2).

---

## Running

```bash
./run-dev.sh              # dev container: engine + dashboard, both watching
./run-dev.sh native       # same thing on the host, no Docker
bun run dev               # engine only, bun --watch
bun run dev:dashboard     # Vite on :18255, proxying /api and /health to the engine
```

| Surface | URL |
|---|---|
| Engine + API | `http://localhost:18254` |
| Dashboard | `http://localhost:18254/dashboard/` |
| Health | `http://localhost:18254/health` |

The daemon boots on built-in defaults with no config file. `run-dev.sh` creates
`.nouride/config.toml` from `config.example.toml` on first run as a convenience.

A daemon started from a checkout leaves your own HOME, npm and pip alone: the agents' toolchain
(`.nouride/bin`, the shared Python env) is set up only where HOME is the agents' own — a service unit or
the container image.

---

## Testing

```bash
bun run test                                    # everything (internals/nougate runs its own)
bun test ./packages/llm/                        # one package
bun test ./apps/engine/tests/pipeline/          # one directory
bun test ./apps/engine/ -t "silences"           # by name
```

> **The `./` prefix and trailing `/` matter.** Without them, `bun test` path filters
> can match the suite of the `internals/nougate` submodule, which is not ours to run.

### Key conventions

- **Prove the test catches the bug.** Break the fix → watch the test fail → restore.
- **Test the path the default config takes.** Streaming is on by default; a JSON
  double exercises nothing.
- **Inject, do not monkey-patch.** Use `HttpDeps`, `fetchImpl`, `SecretStore` env
  objects — tests never touch the network.
- **Isolate state.** `mkdtempSync` for directories, cleaned in `afterEach`.
- **Business logic takes a port, not a store.** A test of logic that reads no rows needs no database
  (`ARCHITECTURE.md` §3, rule 5).

---

## Linting & type-checking

```bash
bun run lint:check    # every lint below
bun run verify        # lint:check, then the whole test suite — what CI runs
```

| Script | Holds |
|---|---|
| `lint:arch` | the import boundaries in [ARCHITECTURE.md §3](./ARCHITECTURE.md#3-dependency-rules) — notably that `Bun.*` appears only in `packages/runtime` |
| `lint:deps` | each workspace member's `package.json` against what its files import, both ways, and no cycle among them |
| `lint:sql` | that SQL is fast and safe: no injection, no table scan in a query plan, no read per item in a loop, none of SQLite's footguns (TD-015) |
| `lint:timers` | that no timer callback in the daemon can let an exception out — an uncaught one shuts the daemon down: each is `contained(log, "what failed", …)`, one `try … catch`, or a form that cannot throw |
| `lint:size` | no `any`, and no file past its code-line budget; each budget with one reason of at most 200 characters, and none for a file split on its seams |
| `lint:skills` | `.claude/skills/` is a symlink to `.agents/skills/`, where the skills live: each one written there, or a link to the private one of its name |
| `lint:cli` | every command the CLI dispatches is in `nouride help`, and every flag there is read |
| `lint:deadcode` | no export, table or module that nothing reaches |
| `lint:pointers` | every path, file name, `file:symbol`, section, link and `nouride` verb in a comment, a doc or a skill leads somewhere; no line numbers; no doc comment stacked on another |
| `lint:public` | nothing private — real ids, the homelab's names and addresses, a home directory, a source map — in what would be published, and nothing there that points at a private document: a design note, a plan, the backlog, a skill of this repository's own |
| `lint:types` | `tsc` for every `tsconfig.json` under `apps/`, `packages/`, `scripts/` and the Pro tree, in a pool sized to the machine — except `apps/site`, whose pages are Astro's to typecheck |

---

## A stack trace from a release build

Release binaries and the Docker images' bundle are fully minified, identifiers included, and carry no source map. A
frame reads `at Rie (/$bunfs/root/nouride:41:6983)` from a binary and `at Rie (/app/nouride.bundle.js:41:6983)` from
a container: a position in the bundled code, not a file. Error names are kept, because every error class names itself
with a literal (`override name = "ConfigError"`; `error-names.test.ts` fails on one that does not), so the first line
of a trace still says `ConfigError: …`.

Every build writes a **private** source map for exactly the code it ships, to `dist/`:

- a binary's beside its tarball — `dist/nouride-linux-x64.map`, `dist/nouride-pro-linux-x64.map`, `dist/nouride.map`
  for a host build. It comes from a second compile with the same flags plus `--sourcemap=external`, and the build
  fails unless that binary's code is the shipped one's byte for byte;
- an image's bundle, `--bundle-only`, beside the bundle — `dist/nouride-image.map`, `dist/nouride-pro-image.map`, one
  per edition for every architecture. It comes from the same `bun build` as the bundle, which ships with only Bun's
  trailing `//# debugId=` line cut: byte for byte what a build without a map writes. Inside the image build the map
  leaves only through the Dockerfile's `source-map` stage; `release.yml` exports it, checks its hash against
  `/app/nouride.bundle.js` in the pushed image on each platform (`scripts/release/image-map-fits.sh`), and only then
  uploads it.

The checks are `scripts/build/source-map.ts`. Each map is stamped with the version, the edition, the target (`image`
for an image) and the SHA-256 of the code it maps. The release uploads the maps to the internal release only; a
tarball, an image or a published file that carries one fails the build, the release job or `lint:public`.

```bash
bun run symbolize --version 0.7.10 --edition pro --target linux-x64 crash.txt   # or pipe a journal excerpt in
docker logs nouride 2>&1 | bun run symbolize --version 0.7.10 --edition basic --target image
```

It prints each frame as `file:line:col  in <function>` with the source line, using only a map stamped for that
exact build: `dist/`, then `.cache/symbolize/<version>/`, then `gh release download` from the internal release.
`--offline` skips the download, `--map <file>` names one. When no map fits, it says so and resolves nothing; a
binary's frame is never read with an image's map, nor the other way round.

Builds are reproducible from any directory. Bun writes a CommonJS dependency's `__dirname` into the bundle as its
absolute path, and three do (`@discordjs/ws`, `pino`, `thread-stream`), so until 0.7.11 every artefact named the
checkout it was built in and a build elsewhere was different code. The build now defines `__dirname` and
`__filename` to a path that names no machine (`scripts/build/build-path.ts`), and fails an artefact that still names
its checkout. The same commit built with the Bun in `.bun-version` and a frozen install is the release's code, and its
map is the release's map, wherever it is built; for a release before 0.7.11, only at the path it was built at (the
Dockerfile's `/app` for an image, CI's checkout for a binary).

**How long the maps are kept.** Each tag puts about 400 MB of them on the internal release. A release keeps its maps
while it is one of the ten newest, or came out less than thirty days ago, or is named with `--keep` — a version the
Nouride Boxes page's Fleet still shows on a Box, or one a pod still pins. The rest lose their `.map` assets, and only
those: `scripts/release/prune-maps.ts` lists what would go and why the rest stays, and deletes only with `--apply`.
The release workflow never prunes on its own, because what is still installed is known only from Fleet. A map pruned
from 0.7.11 on can be built again from its tag, as above.

---

## Where CI runs: one switch

Every job of every workflow — CI, the images, the site, the release and its signing — runs on GitHub's runners
(`ubuntu-24.04`) unless the repository variable `CI_RUNNER` names another, and that one line moves them all:

```bash
gh variable set CI_RUNNER --body '["self-hosted", "build-runner"]'   # the self-hosted build runner
gh variable delete CI_RUNNER                                          # back to GitHub's runners
```

There are no pull requests (the owner, 2026-10-29): work is committed to the release branch and pushed, and `main` is
fast-forwarded to it when the release is tagged. No workflow runs on a pull request — a fork's would run its code on
the machine that builds and signs releases, and GitHub's own runners are refused for billing —
`tests/contracts/workflow-pins.test.ts` holds that. The self-hosted runner keeps its working copy between jobs, so every job starts by
clearing the submodules a job before it left checked out — on GitHub's fresh runners that step has nothing to do. On
the self-hosted runner, the release is signed on a machine that also builds: the trade the switch makes, and the
reason GitHub's runners are the default. Since 2026-10-18 (GitHub's runners would not start for billing), the
variable is set.

---

## Cutting a release

The whole procedure — the checks, the end-to-end run on the live box, the rollout to Boxes — is in the maintainers'
private release runbook. Once a release branch has passed it, publishing moves three refs, and every one of them only
forward:

```bash
git fetch . releases/vX.Y.Z:main && git push origin main             # main is always the last release
git -C internals/pro push origin "$(git rev-parse main:internals/pro)":refs/heads/main   # and the Pro repository's main, to the pin
git tag vX.Y.Z && git push origin vX.Y.Z                                # which starts release.yml
```

The second line is the Pro submodule's `main` following the pin the tag carries, as this repository's `main` follows
the tag; a push that is not a fast-forward is refused, so it cannot move `main` anywhere else. Until 0.7.11 it was
not in the steps, and that `main` stayed at 0.7.8's pin while 0.7.9's and 0.7.10's lived only on release branches.

After the run, the maps of releases nothing runs any more (above):

```bash
bun run scripts/release/prune-maps.ts                    # what would go — check Fleet for a version still on a Box
bun run scripts/release/prune-maps.ts --keep vA.B.C --apply
```

---

## Project layout

```
apps/
  engine/       the daemon — boot, pipeline, tools, memory, web surface
  dashboard/    React 19 + Vite + TanStack + daisyUI SPA
  site/         the public website and the manual

packages/
  shared/       types, envelope, logger, errors — imports nothing
  runtime/      the only Bun.* in the codebase (TD-001)
  secrets/      named credentials: env-first, store-second
  llm/          OpenAI + Anthropic clients, SSE, token estimation
  queue/        keyed queue: ordered per key, parallel across keys
  persona/      agent pack loader, and the agent registry
  policy/       the exec decision: the fixed list, grants, approval levels
  mcp/          MCP client
  gateways/     Discord / Telegram / WhatsApp adapters
  update/       download, verify and swap a release
  system-packages/  `nouride pkg`, and the root service behind it
  wa-bridge/    the WhatsApp bridge (MIT)
  ui-graph/     the dashboard's graph canvas — browser code lives only in ui-*
  wire/         what the control API sends and takes, types only — the engine and the dashboard import it

internals/      two private submodules: pro (the commercial plugins), nougate (the LLM gateway)
content/        what a human edits, not what runs — the built-in skills and agent packs, MIT
  agents/       example persona pack — config-as-code, copied by operators, never shipped
  skills/       skills that ship with the daemon — installed as `skills/` beside the binary
.nouride/        a local install (gitignored): config.toml, data/, agents/, memory/, workspace/
```

Package vs. engine: could a second tool in the Nouverse ecosystem use this without
importing the daemon? If yes → package. If no → engine.

---

## Documentation

| Document | Answers |
|---|---|
| **Start here** | |
| [README.md](./README.md) | what every document owns — read it before adding one |
| the private RFC index | what is open, and the proposals for it — the only home for either, and not in the public export |
| **Reference — living, keep correct** | |
| [SPEC.md](./SPEC.md) | what Nouride does — features, schemas, edge cases, and the roadmap's scope (§21) |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | where code lives and what may import what |
| [TECH_DECISION.md](./TECH_DECISION.md) | why the stack was chosen (TD-nnn) |
| [CLI.md](./CLI.md) | the `nouride` CLI — operating the daemon |
| [DASHBOARD.md](./DASHBOARD.md) | the web dashboard — its structure, and the rules its UI has to keep |
| [DEPLOY.md](./DEPLOY.md) | putting it on a server — native binary or container — and upgrading it |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | how to set up, test, and contribute |
| [SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md) | what it costs to run, measured, and what to run it on ([id](./SYSTEM_REQUIREMENTS.id.md)) |
| [releases/](./releases/) | release notes, one per version |
| [content/agents/README.md](../content/agents/README.md) | how to define an agent |

These are living documents. If a change makes one of them wrong, update it in the
same commit.

[SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md) is the one that goes wrong **silently**: it holds
measured figures, and nothing fails when a dependency or a new resident cache moves them. It carries
the commit it was measured at and the commands to reproduce it, so re-measure rather than adjust the
prose — and see its own "Keeping this current" section for what invalidates it.

---

## The invariants

These are not style preferences — each one corresponds to a bug that was written in
this repo. The full list with rationale is in the
contributing skill (private), but the short
version:

1. **`Bun.*`, `bun:*` and `node:*` only in `packages/runtime`** — portability discipline (TD-001)
2. **Never branch on a platform or provider id** — adapters own the difference
3. **Credentials are names, never values** — `api_key = "nougate"` names a secret
4. **Never invent a number; flag every estimate** — usage silence ≠ zero
5. **Unimplemented throws** — a capability that is not there says so, never a silent empty return
6. **Truncate in whole turns** — orphaned `tool_result` is a hard error
7. **Fail at load, not at first message** — validate config eagerly
8. **Errors shaped for their audience** — chat gets `toUserMessage()`, logs get everything
9. **Prove the test catches the bug** — and test the path that actually runs
10. **Inter-package imports follow each package's `package.json`** — `lint:deps`, both directions
11. **Import from the barrel, not the internals** — `@nouride/llm`, never `@nouride/llm/src/…`
12. **One file, one concern** — and no file grows past its budget (`lint:size`)
13. **An export is a claim that something else needs it** — `lint:deadcode`
14. **The event stream is a contract** — within a major version a row only gains: `EVENT_CONTRACT`, its lock and `EVENTS_CHANGELOG.md` change together
15. **No timer callback lets an exception out** — `contained(…)` around the body; `lint:timers`
16. **Work nobody watches says what it did** — start, success and failure with its model, numbers and reason; a failure that repeats reaches `doctor`, `/health` and the dashboard; every model call records its `purpose` and `stop_reason` (`tests/contracts/usage-recorders.test.ts`)

---

## Git hygiene

- Commit only when asked.
- `.nouride/` is entirely gitignored — an install never appears in a diff. The tracked
  `content/agents/` is seed material, not a live install.
- Edit skills in `.agents/skills/`. `.claude/skills/` is a symlink to it, and `lint:skills`
  fails if it stops being one. A skill about the maintainers' own machines is private: it lives in the private
  submodule, and `.agents/skills/` holds a link to it of the same name.
- Never paste a real credential into a test fixture. Use obvious placeholders — `lint:public` fails on
  a real id or address in anything that would be published.

---

## License

The [Functional Source License 1.1, ALv2 Future License](../LICENSE), Nouverse Technologies: Nouride may be used, changed
and shared for any purpose but a competing product, and each version becomes Apache 2.0 two years after its release. The
WhatsApp bridge, `packages/wa-bridge`, and the built-in skills and agent templates, `content/`, are MIT. A pull request
is merged once its author has agreed to the [Contributor Licence Agreement](./CLA.md), as [above](#before-your-first-pull-request).
