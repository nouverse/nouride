/**
 * A mission's worktree (0.8.1): where a mission's folder is in a git repository and the machine can hold
 * a second copy, it works in one of its own — on the branch `mission/<id>`, or the one its start named (0.8.7), from
 * the repository's last commit, in its own folder (`missions/<id>/worktree`). What is not committed in the agent's clone is neither taken nor touched, two
 * missions in one repository run side by side, and the mission ends with its branch: the daemon makes and removes
 * worktrees and does nothing else in git — a merge is the agent's, through the gate, as a push is.
 *
 * Only where the machine can hold it: a worktree is the working files again, and coding work in it usually installs
 * its dependencies again too. The memory the agents' commands may hold must have room for a coding CLI's session (the
 * same floor as an external agent's), and the free disk twice the repository's checked-out files — one copy, and as
 * much again for what installing into it adds. Below either, the mission works in its folder and the one-repository
 * queue stays (`decide.ts`).
 */

import { dirname, join, relative } from "@nouride/runtime";

/** A command run as the mission's agent: its exit, and what it printed. */
export type AsAgent = (argv: string[]) => Promise<{ ok: boolean; out: string }>;

/** The folder the daemon makes for a mission, under its agent's own; the worktree goes inside it. */
export function ownFolderOf(privateDir: string, missionId: string): string {
  return `${privateDir.replace(/\/+$/, "")}/missions/${missionId}`;
}

/** Whether a mission's folder is the daemon's own for it — the default folder, or a worktree inside it. */
export function inOwnFolder(workdir: string, own: string): boolean {
  return workdir === own || workdir.startsWith(`${own}/`);
}

/** The branch a mission's worktree is on — the one its start named, else `mission/<id>` — part of its report. */
export function branchOf(mission: { id: string; branch: string | null }): string {
  return mission.branch ?? `mission/${mission.id}`;
}

/** The branch a mission works on, where its folder is its worktree; null for one that works where it was given. */
export function worktreeBranch(mission: { id: string; workdir: string; branch: string | null }): string | null {
  return mission.workdir.includes(`/missions/${mission.id}/worktree`) ? branchOf(mission) : null;
}

/**
 * Which of a mission's result files git tracks where it works (0.8.11): the work it changed stays on its branch, and only
 * the rest reaches the chat. Null where git cannot say — the caller sends them all and says why in the log, rather than
 * hold a file back on a guess.
 */
export async function trackedIn(workdir: string, files: readonly string[], run: AsAgent): Promise<Set<string> | null> {
  if (files.length === 0) return new Set();
  const paths = files.map((file) => relative(workdir, file));
  const listed = await run(["git", "-C", workdir, "ls-files", "-z", "--", ...paths]);
  if (!listed.ok) return null;
  const tracked = new Set(listed.out.split("\0").filter(Boolean));
  return new Set(files.filter((_, at) => tracked.has(paths[at]!)));
}

/**
 * Why a name cannot be a new mission's branch in `repo`, or null: git's own rule for a branch name
 * (`check-ref-format --branch`), and one that is already there — its worktree would be refused, or made on work that
 * is not the mission's. A name git rewrites (`@{-1}` is the branch checked out before) is not the name asked for.
 */
export async function branchRefusal(repo: string, branch: string, run: AsAgent): Promise<string | null> {
  const format = await run(["git", "-C", repo, "check-ref-format", "--branch", branch]);
  if (!format.ok || format.out.trim() !== branch) return `${branch} is not a branch name git takes (git check-ref-format --branch).`;
  const there = await run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (there.ok) return `${branch} already exists in ${repo}: name a new branch, or leave \`branch\` out for mission/<id>.`;
  return null;
}

/**
 * Make the mission's worktree, and say where in it the mission now works — the same place relative to the repository
 * its folder had — or null where it keeps its folder, with why in `told`.
 */
export async function makeWorktree(input: {
  mission: { id: string; workdir: string; branch: string | null };
  own: string;
  repoOf: (workdir: string) => string;
  isRepo: (dir: string) => boolean;
  roomForCli: () => boolean;
  freeBytes: (path: string) => number | null;
  run: AsAgent;
  told: (why: string) => void;
}): Promise<string | null> {
  const { mission } = input;
  const refuse = (why: string): null => {
    input.told(why);
    return null;
  };
  if (inOwnFolder(mission.workdir, input.own)) return null;
  const repo = input.repoOf(mission.workdir);
  if (!input.isRepo(repo)) return null;
  if (!input.roomForCli()) return refuse("no room in memory for a second copy's work");

  const listed = await input.run(["git", "-C", repo, "ls-tree", "-r", "-l", "HEAD"]);
  if (!listed.ok) return refuse(`the repository has no commit to branch from: ${listed.out.trim().slice(0, 200)}`);
  // `<mode> <type> <object> <size>\t<path>`; a submodule's size is `-`.
  const size = listed.out.split("\n").reduce((sum, line) => sum + (Number(/^\S+ \S+ \S+\s+(\d+)\t/.exec(line)?.[1]) || 0), 0);
  const free = input.freeBytes(input.own);
  if (free !== null && free < size * 2) return refuse(`the disk has ${free} bytes free, and a copy needs about ${size * 2}`);

  const worktree = join(input.own, "worktree");
  const made = await input.run(["git", "-C", repo, "worktree", "add", "-b", branchOf(mission), worktree, "HEAD"]);
  if (!made.ok) return refuse(`git worktree add refused: ${made.out.trim().slice(0, 200)}`);
  const within = relative(repo, mission.workdir);
  return within ? join(worktree, within) : worktree;
}

/**
 * A worktree for one of a mission's helpers that writes (`delegate` with `isolated`): inside the mission's own folder
 * (`helpers/<n>`), on a branch of its own from the mission's last commit — so two helpers do not write over each other or
 * over the mission, and each hands back a branch. The mission merges it, through the gate, as it would any.
 */
async function makeHelperWorktree(input: { mission: { id: string; branch: string | null }; own: string; exists: (path: string) => boolean; run: AsAgent }): Promise<{ path: string; branch: string } | { refused: string }> {
  let n = 1;
  while (input.exists(join(input.own, "helpers", String(n)))) n += 1;
  const path = join(input.own, "helpers", String(n));
  const branch = `${branchOf(input.mission)}-helper-${n}`;
  const made = await input.run(["git", "-C", join(input.own, "worktree"), "worktree", "add", "-b", branch, path, "HEAD"]);
  return made.ok ? { path, branch } : { refused: `git worktree add refused: ${made.out.trim().slice(0, 200)}` };
}

/**
 * A helper's worktree for the mission a turn is, or why there is none: a turn that is no mission's, and a mission that
 * works in its folder rather than a worktree, have no branch to give a helper.
 */
export async function helperWorktreeFor(input: { mission: { id: string; workdir: string; branch: string | null } | null; own: (missionId: string) => string; exists: (path: string) => boolean; run: AsAgent }): Promise<{ path: string; branch: string } | { refused: string }> {
  const { mission } = input;
  if (!mission) return { refused: "`isolated` is a mission's: its helpers each get a worktree of the mission's. Here, run them without it." };
  if (!worktreeBranch(mission)) return { refused: "this mission works in its folder, not in a worktree of its own, so its helpers cannot have one: run them without `isolated`." };
  return await makeHelperWorktree({ mission, own: input.own(mission.id), exists: input.exists, run: input.run });
}

/**
 * Remove a mission's own folder — its worktree with it — once it has been kept long enough: the worktree's entry in the
 * repository pruned, its branch left there. `keepUnsaved`: not where a worktree in it — the mission's, or a helper's —
 * holds work nobody committed; those are named, and nothing is removed. Removed with no look, the work was deleted a
 * week after the mission ended, and the branch its notice named held none of it.
 */
export async function removeOwnFolder(own: string, run: AsAgent, how: { keepUnsaved?: boolean } = {}): Promise<string[]> {
  const worktree = join(own, "worktree");
  if (how.keepUnsaved) {
    const unsaved = await uncommitted(own, run);
    if (unsaved.length > 0) return unsaved;
  }
  const common = await run(["git", "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const removed = await run(["rm", "-rf", own]);
  if (!removed.ok) throw new Error(removed.out.trim() || `${own} could not be removed`);
  if (common.ok && common.out.trim()) await run(["git", "--git-dir", common.out.trim(), "worktree", "prune"]);
  return [];
}

/** The worktrees in a mission's folder holding changes nobody committed: its own, then its helpers' (`helpers/<n>`, from 1). */
async function uncommitted(own: string, run: AsAgent): Promise<string[]> {
  const found: string[] = [];
  // A helper's worktree is made only inside a mission's, numbered without a gap: the first that is not one ends the list.
  for (let n = 0; ; n += 1) {
    const path = n === 0 ? join(own, "worktree") : join(own, "helpers", String(n));
    const status = await run(["git", "-C", path, "status", "--porcelain"]);
    if (!status.ok) return found;
    if (status.out.trim()) found.push(path);
  }
}

/** Whether a folder is the mission's own worktree or one of its helpers' — the daemon's, kept with the mission's branch. */
function daemonMade(own: string, path: string): boolean {
  return path === join(own, "worktree") || /^helpers\/\d+$/.test(path.slice(own.length + 1));
}

/**
 * The worktrees a mission made itself inside its folder (0.8.7) — `git worktree add ../baseline` for a comparison, a
 * scratch checkout — removed when it ends: left, each stayed registered in its repository, its branch checked out there
 * and refused to every other worktree, until a person found it. The daemon's own (the mission's worktree, its helpers')
 * stay with the mission's branch until the folder goes. One holding changes nobody committed is kept and named; git
 * refuses to remove it without `--force`, which this never passes.
 */
export async function removeExtraWorktrees(own: string, run: AsAgent): Promise<{ removed: string[]; kept: string[] }> {
  // A linked worktree has a `.git` *file* naming its repository; four levels down covers `extra/<repo>` and the like.
  const found = await run(["find", own, "-maxdepth", "4", "-name", ".git", "-type", "f"]);
  const removed: string[] = [];
  const kept: string[] = [];
  if (!found.ok) return { removed, kept };
  const paths = found.out.split("\n").map((line) => line.trim()).filter(Boolean).map((file) => dirname(file));
  for (const path of paths.sort()) {
    if (daemonMade(own, path)) continue;
    // A linked worktree's git dir is its own, inside the repository's common one. A submodule checked out in a
    // worktree has a `.git` file as well, but its git dir is the common one: no worktree to remove, and `worktree
    // remove` refused it, so the mission's own `internals/pro` was reported as kept for uncommitted work.
    const dirs = await run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
    const [gitDir, common] = dirs.ok ? dirs.out.trim().split("\n") : [];
    if (!gitDir || !common || gitDir === common) continue;
    const gone = await run(["git", "--git-dir", common, "worktree", "remove", path]);
    if (gone.ok) removed.push(path);
    else kept.push(path);
  }
  return { removed, kept };
}
