---
name: nouride-testing
description: How a Nouride change is proven before it ships — which evidence each kind of change needs (an automated test with a sabotage check, a regression test for every bug, an upgrade from an older install, a manual end-to-end on a real platform, browser or machine), how to find the tests that pass for the wrong reason, and how to report what was and was not verified. Use when finishing any change, fixing a bug, writing release notes, or deciding whether something is tested enough.
---

# Proving a change before it ships

**Every change ships with evidence that would have caught it being wrong.** A change without it is not done, and
"the suite is green" is not evidence: with several thousand tests, green is the default state of a broken change.

Three kinds of evidence. The change decides which it needs — usually more than one:

1. **Automated** — a test in `bun run test`, with a sabotage check: break the change, watch the test go red, put it
   back. The rules for writing one are in `nouride-contributing` (§ Every change comes with a test, and
   `references/workflow.md` § Testing).
2. **Regression** — every bug, wherever it was found (a user, an end-to-end run, a review, a live install), gets a test
   that fails on the code before the fix. Write the test first, against the bug, and see it fail for the reason the
   bug report gives. A bug fixed without one comes back.
3. **Manual end-to-end** — what a test cannot reach: a real platform, a real browser, a real upgrade of real data, a
   real machine. Written as a checklist before it runs, run, and its result recorded where the change is (the commit,
   the release's notes). **A manual check done twice becomes a script.**

The maintainers' release gate, and the live checks they run on their own box and chat, are the private
`nouride-release-gate` skill.

## Which evidence a change needs

| The change | Evidence it needs |
|---|---|
| Logic, a parser, a decision | Unit test of the decision + sabotage |
| A control route, a CLI command | The route's status and body, the command's exit code (0 / 1 refused / 2 misuse) and `--json` envelope + sabotage |
| A config key, a refusal, a default | The loader refuses it by its path; `nouride config check` shows it; **if an older install can hold it, an upgrade from that install** |
| A migration, the vault format | A test on a database of the previous schema; an upgrade from the previous release on real data, including the way back (`nouride db restore`) |
| Memory search, the vector store, a memory migration | The above where it applies + the bench at 1k, 10k and 50k items before and after, both in the change: `references/memory-at-scale.md` |
| Boot order, anything that can refuse a start | A refusal writes nothing first (schema, `config.toml`, vault), seen on an upgrade |
| A pack's loading | `config check` and `doctor` name a pack that will not load; `agent reload` loads it once fixed |
| A gateway, a platform's behaviour | `FakeGateway` test + a real send on that platform, from a test bot in a real chat |
| The dashboard | Route/component test + the real page in a browser, both themes, a hidden tab, a failed load |
| Update, install, the release pipeline | Contract tests + after the tag: a signed `--tarball` install, and the previous release's own `nouride update` through to `update confirmed` |
| A timer or background task | `contained(…)` + a test that its body throwing leaves the daemon up |
| The service unit, a cgroup, a resource limit | The unit's text and its drift, tested + a systemd machine with the old unit and the new, a command eating memory while `/health` is timed |
| The container image: what it holds, what an agent's installs survive | The candidate image run for real: an install into the volume, a recreate on the same volume, what was installed still there |
| A service Nouride asks (Nouverse's MCP catalog, a hub) | A fake answering in the service's own shape + sabotage; then the service's real code over real data, the daemon pointed at it by its override, through the CLI, the agent's tool in a chat, and the dashboard |
| Where something an agent has is declared (moving it from the pack to the install, as the MCP library did) | A fold test that each agent runs the same thing after as before — same command, same credential, still logged in — run twice for the same answer; then an old build's real files on a copy of an install, booted on the new build |
| A prompt | The wording that carries the rule, asserted directly |
| What asks: the approval levels, the fixed list, a tool's gate, the texts that name them | The policy tables + each level's words asserted + each preset seen in a real chat |
| Credentials: what is taken out of a message, masked, redacted or guarded | The registry's own rows (examples and near-misses) + a search of every place text goes, on disk and on the wire |
| Docs and release notes | **Every claim checked against the running build.** 0.7.10's notes said a pack with two MCP servers of one name "stops 0.7.10 at boot"; it stops that agent and the daemon runs — found only by running it |

When a test would need five collaborators, extract the decision and test that. When a behaviour has no test you can
write, say so in the change and do the manual check — do not leave it implied.

## Regressions and the areas nobody reviewed

- **Sabotage per fix**, not per release: `git stash` the fix or invert its condition, run the one test file, see it
  fail, restore. Note it in the commit body ("sabotage: …").
- **The four ways a test passes for the wrong reason** — the guard never reached, the loop never going round twice,
  the first branch shadowing the one under test, the property true anyway — are in `nouride-contributing`. Check
  each new test against them.
- **A mutation sweep** for a whole area whose tests were never reviewed one by one: mutate each decision (flip a
  condition, drop a statement, change a boundary), run the area's tests, and every mutant that survives is a missing
  test. The root helper (`packages/isolation/root`) has its sweep written down: `bun run mutate:helper` after any
  change to it — a mutant it lets live is a rule of a root process nothing holds it to (`scripts/mutate-helper.ts`,
  Docker, about twenty minutes).

## Reporting

Say what ran and what it showed; say what did not run. "Verified" means it was run — on which build, which data,
which surface. A check that could not be done (no hardware, no token, a permission refused) is named as not done,
with what would do it.

Credentials never go into a container, a fixture or a transcript for a test: where a model is needed and a live key is
not, a stand-in model answers. Test artefacts made on live data are removed afterwards; a live config is backed up
before a test changes it and restored after.
