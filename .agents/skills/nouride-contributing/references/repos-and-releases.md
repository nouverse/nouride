# The repositories, a first clone, and how a release goes out

Read this before your first change, and again before you cut a release. The detail of running and testing is in
`workflow.md` and `docs/CONTRIBUTING.md`; this is the map around them.

## Which repository holds what

| Repository | Where it sits in a checkout | Visibility | What it is |
|---|---|---|---|
| `nouverse/nouride` | the root | public | The daemon (`apps/engine`), the dashboard, the CLI, the site, the shared packages, `content/` (the built-in skills and agent packs, MIT). Every release is tagged here. |
| `nouverse/nouride-pro` | `internals/pro` (submodule) | private | The Pro plugins (multi-user accounts, the bundled gateway's wiring, the appliance), the release's private half (its CI, signing, the Pro editions), the maintainers' docs: the RFCs, the runbook, the e2e scripts, and the private skills linked into `.agents/skills/`. |
| `nouverse/nougate` | `internals/nougate` (submodule) | public | Nougate, the LLM gateway: its own product, with its own rules (`internals/nougate/.agents/skills/nougate-contributing`), its own CI and its own deploys. Nouride pins a commit of it and bundles it in the Pro editions. |
| `nouverse/nouride-android-appliance` | `apps/android-appliance` (a separate clone, gitignored) | its own | Nouride Home, the Android app that runs Nouride. Linked from the README; its commits and releases are its own. |

`internals/` is optional: a clone without the submodules builds and tests the free edition. The Pro edition and the
release need both.

## A first clone

```bash
git clone https://github.com/nouverse/nouride.git
cd nouride
git submodule update --init internals/nougate          # public, anyone can
git submodule update --init internals/pro              # the maintainers: needs access to nouride-pro
bun install                                            # the version is .bun-version; also points core.hooksPath at .githooks
bun test ./apps/engine/tests/<area>/                   # what you touch, first
bun run lint:check                                     # everything the checks enforce
```

A second release's work beside the first is a second worktree, not a second clone:
`git worktree add ../nouride-0837 releases/v0.8.37`, then `git submodule update --init` inside it.

## Branches

- `main` is always the last release. Nothing is committed to it directly.
- `releases/vX.Y.Z` holds the work of the next release, from `main`, and each commit is pushed there; a push runs
  the lint and the contract tests (`ci.yml`). The private repository has a branch of the same name, and the pin in
  this repository points at its commit.
- What is found after a release is tagged goes on the next release's branch, never on the one just released.
- Somebody outside proposes a change by a pull request to `main` (or to a release branch); `pr.yml` runs the lint and
  the whole suite on it, and `cla.yml` asks that its author agreed to the CLA.

## How a release goes out

The order, since 0.8.36:

1. **On the release branch:** the version (`./bump-version X.Y.Z`), the notes (`docs/releases/` names a file for each version, and they are
   the release page, word for word), the release's RFC closed in the private tree (what is done archived, what is
   left a backlog line), the checks (`bun run verify`, `bun run audit`). Push the private branch first, then this one.
2. **A pull request** from `releases/vX.Y.Z` to `main`. It runs the whole suite and the CLA check. Beside it, the
   maintainers run the release gate: the upgrade from the last release on real data, a fresh install of each edition
   in Docker, the build on their own box.
3. **Merge it with a merge commit**, never a squash: every commit stays in `main`, so a hash a note or a comment cites
   is still there. Delete the branch.
4. **The tag on `main`'s merge commit.** That commit is new, so ask for the whole suite on it first
   (`gh workflow run ci.yml --ref main`) and wait for it to end green. Move the private repository's `main` to the pin
   `main` carries (it moves only forward). Then `git tag vX.Y.Z <merge commit>` and push the tag: `release.yml` builds,
   signs and publishes, and starts the public half (`public-release.yml`).
5. **After the tag:** a fresh install from the public address and the last release's own `nouride update` to the new
   one, then the installs the maintainers run.

A published tag is never moved: its binaries are signed against its commit. A fix after the tag is the next release.
