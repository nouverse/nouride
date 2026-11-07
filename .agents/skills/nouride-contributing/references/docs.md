# Writing documentation

---

## Where docs live

All project documentation lives in `docs/`. The repo root holds only `README.md` (the front
page) and `GETTING_STARTED.md` (installing it, linked from the README as where to start); no other
`.md` doc belongs there.

```
docs/
  README.md           what every document owns. Read it before adding one
  SPEC.md             what Nouride does — features, schemas, edge cases, roadmap scope (§21)
  ARCHITECTURE.md     where code lives and what may import what
  TECH_DECISION.md    why the stack was chosen (TD-nnn)
  CLI.md              the `nouride` CLI — operating the daemon
  DEPLOY.md           putting it on a server
  CONTRIBUTING.md     how to set up, test, and contribute
  SYSTEM_REQUIREMENTS.md   measured cost to run
  releases/           release notes, one per version
  tasks/              (private) each release's execution plan, kept as it was written
  archive/            (private) what 0.7.x closed with: the 2026-10-15 review, its §0 where each finding ended. Not read for 0.8.0

```

`scripts/public-tree.ts` keeps everything marked private out of the public export, and `lint:public` refuses a
published file that points at any of it — a path, a link, a name only a private document has. A published doc that
needs to say where planning lives says it is kept privately. The planning documents themselves (the RFCs, the
backlog, the release runbook) are the maintainers', in a private submodule; their map is the private
`nouride-release-rfc` skill.

**One fact, one home — and it is not advisory.** Six documents once described the status
(`HANDOFF`, `TASK`, `PHASE2_GAPS`, `PHASE3_PLAN`, `PHASE4_PLAN`, `FOUNDATION_GAPS`), 3,700 lines
of it, and they ended up disagreeing: the newest had to open with a table of the claims the other
five got wrong, and was itself ten days stale. All six were deleted on 2026-09-06; what is open now
has one home, the maintainers' index of open work. Do not recreate them under new names.

**A status line inside a design document is the same mistake.** An RFC marked *Implemented* is a
status in a second place; when all of it ships, the RFC is archived, taken off the index of open work, what is left
of it becomes a backlog line there, and the code carries the reasoning. Archived, not deleted (the owner, 2026-10-27): comments cite RFCs by
section, and an archived one is a record — not read for open work, never linked as how things are now.

**History is git's job.** Do not keep a point-in-time document so the reasoning survives — the
reasoning belongs in a comment next to the code it explains, where it is read by whoever is about
to break it.

Component-scoped READMEs (`content/agents/README.md`, `packages/wa-bridge/README.md`) stay next
to the code they describe — they are not project-level docs.

---

## Which file gets the content

| You are writing about… | Put it in |
|---|---|
| A user-facing feature, schema, edge case, or phase task list | `docs/SPEC.md` |
| A module boundary, dependency rule, package split, or deploy topology | `docs/ARCHITECTURE.md` |
| A stack choice and its rationale (new TD-nnn) | `docs/TECH_DECISION.md` |
| A CLI command or flag | `docs/CLI.md` |
| Setup, testing, workflow, invariants for contributors | `docs/CONTRIBUTING.md` |
| How to define or configure an agent pack | `content/agents/README.md` |
| Why the WhatsApp bridge is isolated | `packages/wa-bridge/README.md` |
| A quick orientation to the whole project | `README.md` (repo root) |

When in doubt: if it matters to someone _using_ Nouride, it goes in SPEC. If it
matters to someone _building_ Nouride, it goes in ARCHITECTURE or CONTRIBUTING.

---

## Cross-references

`bun run lint:pointers` (`scripts/check-pointers.ts`, part of `lint:check`) holds every one of these to something that exists: a repo path, a bare file name, a `file:symbol`, a `§N` of a named doc, a relative link and its anchor, a `` `nouride <verb>` ``.
Never a line number — `file.ts` and a number drift with every edit above them; name the function instead.
When a pointer fails, point it at where the thing lives now, or say the thing itself; `NOT_POINTERS` in the script is only for names that were never pointers.

### From code comments

Use the path from the repo root:

```ts
// Good — unambiguous from any file
// See §6 of docs/ARCHITECTURE.md.

// Bad — ambiguous, breaks when the reader is in a subdirectory
// See ARCHITECTURE.md.
```

### From other docs inside `docs/`

Relative links, since they are siblings:

```markdown
See `docs/SPEC.md` §21 for the full task list.
```

### From README.md or anywhere else outside `docs/`

Prefix with `docs/`:

```markdown
`docs/ARCHITECTURE.md` §3
```

### Section anchors

SPEC and ARCHITECTURE use numbered sections (`## 3. Dependency Rules`). Link to
them as `#3-dependency-rules`. TECH_DECISION uses `## TD-nnn: Title`; link as
`#td-nnn-title`.

---

## Style rules

1. **One sentence per line** in `.md` sources. Diffs are per-line; a reworded clause
   should not re-wrap the entire paragraph.
2. **No HTML in markdown.** Use standard markdown. Tables, fenced code, blockquotes.
3. **Code identifiers in backticks.** File paths, config keys, CLI commands, types.
4. **Living documents.** If your code change makes a doc statement wrong, fix the doc
   in the same pass. A stale invariant is worse than an undocumented one.
5. **SPEC sections are numbered.** New sections get the next number; never renumber
   existing ones (external links break).
6. **TD entries are numbered.** `TD-nnn` — pick the next available number. Each entry
   has: title, status, decision, rationale, and (optionally) alternatives considered.

---

## Adding a new doc

1. Create it in `docs/`.
2. Add a row to the table in `docs/CONTRIBUTING.md` § Documentation.
3. Add a row to the table in `README.md` § Documentation.
4. If it is referenced from code comments, use `docs/<filename>.md`.
5. Nothing for `.dockerignore`: it ignores the whole of `docs/`, so a new file is out of the image
   without being listed.
