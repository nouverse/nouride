# docs

Each file owns something no other file may restate — the previous set had six documents describing the
same status, and they ended up disagreeing.

**What is not built yet** is planned in private documents, which the public export leaves out: one index
of what is open, the proposals, each release's execution plan, and where each finding of the 2026-10-15
review stands. A proposal is archived the day its work ships, and its reasoning moves into the code it
explains — so nothing published points at one.

## Reference — the answer lives here

| | |
|---|---|
| [SPEC.md](./SPEC.md) | What Nouride does — features, schemas, edge cases, and the roadmap's *scope* (§21). |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Module boundaries. §3 is enforced by `scripts/check-arch.ts`, so it is executable rather than decorative. |
| [TECH_DECISION.md](./TECH_DECISION.md) | The numbered decisions (TD-001…) other files and code comments cite. |
| [EVENTS.md](./EVENTS.md) | The event stream's contract — every kind, what a reader can rely on, how it may change. Locked by [contracts/](./contracts/). |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to work in this repo. |
| [CLA.md](./CLA.md) | The Contributor Licence Agreement a pull request's author agrees to before it is merged. |

## Operating it

| | |
|---|---|
| [DEPLOY.md](./DEPLOY.md) | First install, and the change→ship→watch loop. |
| [CLI.md](./CLI.md) | Every `nouride` command. |
| [DASHBOARD.md](./DASHBOARD.md) | The web dashboard — its structure, and the rules its UI keeps. |
| [SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md) | Measured figures, not estimates. ([id](./SYSTEM_REQUIREMENTS.id.md)) |
| [releases/](./releases/) | Release notes, one file per version. |

## Planning — never published

Each release's execution plan and the improvement backlog are tracked beside these files, and
`scripts/public-tree.ts` leaves them out of the public tree; the contributing skill says where each lives.

## Removed

`git log --diff-filter=D -- docs/` finds any of these.

- **2026-10-12:** `rfc/`. Proposals still open moved to the private tree; the rest were built or not
  worth building, and were deleted. The appliance vision moved with them: it carried pricing.
- **2026-09-30:** the internal documents — status, the sandbox gap, distribution, the thesis and vision —
  moved to the private tree.
- **2026-09-06:** eleven files of status that restated each other (`HANDOFF`, `TASK`, the phase plans,
  `FOUNDATION_GAPS`, an audit and a fix report).
