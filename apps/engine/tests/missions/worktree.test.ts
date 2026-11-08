/**
 * A mission's worktree (0.8.1), against a real git repository: a mission in one, where the machine can
 * hold it, works in a worktree on its own branch from the last commit — what was not committed is neither taken nor
 * touched — at the same place in it as its folder had; two such missions do not queue for the repository; elsewhere,
 * or without room, it keeps its folder and says why; its removal takes the worktree and leaves the branch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExistsSync, runCommand } from "@nouride/runtime";
import { blockedBy, repositoryOf } from "@/modules/missions/decide.ts";
import { branchOf, branchRefusal, helperWorktreeFor, makeWorktree, ownFolderOf, removeExtraWorktrees, removeOwnFolder, trackedIn, worktreeBranch, type AsAgent } from "@/modules/missions/worktree.ts";
import { doneNotice } from "@/modules/missions/notices.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { missionsHarness } from "./harness.ts";

/** Real git, a dozen commands a test: a second or two on a quiet machine, past bun's 5 s while the box is busy. */
const GIT_MS = 30_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run: AsAgent = async (argv) => {
  const out = await runCommand(argv, { cwd: "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir() }, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  return { ok: out.exitCode === 0, out: out.exitCode === 0 ? out.stdout : out.stderr || out.stdout };
};
const git = async (repo: string, ...args: string[]) => (await run(["git", "-C", repo, "-c", "user.email=t@example.test", "-c", "user.name=t", ...args])).out.trim();

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "mission-worktree-"));
  dirs.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "app"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "app", "main.ts"), "export const ok = true;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "first");
  // Not committed: the agent's own work in progress, which a mission's worktree must neither take nor touch.
  writeFileSync(join(repo, "app", "draft.ts"), "unsaved\n");
  const own = ownFolderOf(join(root, "private", "coder"), "m1");
  mkdirSync(own, { recursive: true });
  return { root, repo, own };
}

const input = (over: Partial<Parameters<typeof makeWorktree>[0]> & { mission: { id: string; workdir: string; branch: string | null }; own: string }) => ({
  repoOf: repositoryOf,
  isRepo: (dir: string) => fileExistsSync(join(dir, ".git")),
  roomForCli: () => true,
  freeBytes: () => null,
  run,
  told: () => {},
  ...over,
});

describe("a mission's worktree", () => {
  test("is made on its own branch from the last commit, and the mission works at the same place in it", async () => {
    const { repo, own } = await repository();
    const moved = await makeWorktree(input({ mission: { id: "m1", workdir: join(repo, "app"), branch: null }, own }));
    expect(moved).toBe(join(own, "worktree", "app"));
    expect(existsSync(join(moved!, "main.ts"))).toBe(true);
    expect(existsSync(join(moved!, "draft.ts"))).toBe(false);
    expect(existsSync(join(repo, "app", "draft.ts"))).toBe(true);
    expect(await git(join(own, "worktree"), "branch", "--show-current")).toBe(branchOf({ id: "m1", branch: null }));
    expect(await git(repo, "branch", "--show-current")).toBe("main");
    expect(worktreeBranch({ id: "m1", workdir: moved!, branch: null })).toBe("mission/m1");
    expect(doneNotice({ id: "m1", summary: "Done.", reviewed: false, checks: [], workdir: moved!, branch: null, reason: null }, false)).toEndWith("\nBranch: mission/m1");
  });

  test("lets two missions work in one repository side by side, where without it one waits", async () => {
    const { repo, own } = await repository();
    const busy = { id: "m1", agentId: "coder", workdir: join(repo, "app"), status: "running", startedAt: 1 } as Mission;
    const next = { id: "m2", agentId: "coder", workdir: join(repo, "app") } as Mission;
    const settings = { perAgent: 2, maxRunning: 4 };
    expect(blockedBy(next, [busy], settings)).toContain("is working in the same folder");
    busy.workdir = (await makeWorktree(input({ mission: busy, own })))!;
    expect(blockedBy(next, [busy], settings)).toBeNull();
  });

  test("is not made outside a repository, in the mission's own folder, or without room — and says why where it could have been", async () => {
    const { root, repo, own } = await repository();
    const told: string[] = [];
    mkdirSync(join(root, "plain"));
    expect(await makeWorktree(input({ mission: { id: "m1", workdir: join(root, "plain"), branch: null }, own }))).toBeNull();
    expect(await makeWorktree(input({ mission: { id: "m1", workdir: own, branch: null }, own }))).toBeNull();
    expect(await makeWorktree(input({ mission: { id: "m1", workdir: repo, branch: null }, own, roomForCli: () => false, told: (why) => void told.push(why) }))).toBeNull();
    expect(await makeWorktree(input({ mission: { id: "m1", workdir: repo, branch: null }, own, freeBytes: () => 10, told: (why) => void told.push(why) }))).toBeNull();
    expect(told).toEqual(["no room in memory for a second copy's work", expect.stringMatching(/^the disk has 10 bytes free, and a copy needs about \d+$/)]);
    expect((await git(repo, "worktree", "list")).split("\n")).toHaveLength(1);
  });

  test("goes with the mission's folder; its branch stays in the repository", async () => {
    const { repo, own } = await repository();
    await makeWorktree(input({ mission: { id: "m1", workdir: repo, branch: null }, own }));
    await removeOwnFolder(own, run);
    expect(existsSync(own)).toBe(false);
    expect(await git(repo, "worktree", "list")).not.toContain(own);
    expect(await git(repo, "branch", "--list", "mission/m1")).toContain("mission/m1");
  });

  test("is kept by the week's sweep while work in it is not committed — its own or a helper's — and goes once it is", async () => {
    // Removed with no look, a week after the mission ended: the work was deleted, and its branch held none of it.
    const { repo, own } = await repository();
    await makeWorktree(input({ mission: { id: "m1", workdir: repo, branch: null }, own }));
    writeFileSync(join(own, "worktree", "app", "fix.ts"), "half done\n");
    expect(await removeOwnFolder(own, run, { keepUnsaved: true })).toEqual([join(own, "worktree")]);
    expect(existsSync(join(own, "worktree", "app", "fix.ts"))).toBe(true);
    await git(join(own, "worktree"), "add", ".");
    await git(join(own, "worktree"), "commit", "-q", "-m", "the fix");
    const helper = await helperWorktreeFor({ mission: { id: "m1", workdir: join(own, "worktree", "app"), branch: null }, own: () => own, exists: existsSync, run });
    if ("refused" in helper) throw new Error(helper.refused);
    writeFileSync(join(helper.path, "app", "notes.md"), "a helper's draft\n");
    expect(await removeOwnFolder(own, run, { keepUnsaved: true })).toEqual([helper.path]);
    rmSync(join(helper.path, "app", "notes.md"));
    expect(await removeOwnFolder(own, run, { keepUnsaved: true })).toEqual([]);
    expect(existsSync(own)).toBe(false);
  }, GIT_MS);

  test("gives each writing helper a worktree of its own inside the mission's, on a branch from the mission's last commit", async () => {
    const { repo, own } = await repository();
    await makeWorktree(input({ mission: { id: "m1", workdir: repo, branch: null }, own }));
    writeFileSync(join(own, "worktree", "app", "mission.ts"), "the mission's own work\n");
    await git(join(own, "worktree"), "add", ".");
    await git(join(own, "worktree"), "commit", "-q", "-m", "mission work");
    const mission = { id: "m1", workdir: join(own, "worktree", "app"), branch: null };
    const helper = () => helperWorktreeFor({ mission, own: () => own, exists: existsSync, run });
    const first = await helper();
    const second = await helper();
    expect(first).toEqual({ path: join(own, "helpers", "1"), branch: "mission/m1-helper-1" });
    expect(second).toEqual({ path: join(own, "helpers", "2"), branch: "mission/m1-helper-2" });
    expect(existsSync(join(own, "helpers", "1", "app", "mission.ts"))).toBe(true);
    expect(await git(join(own, "helpers", "2"), "branch", "--show-current")).toBe("mission/m1-helper-2");
    await removeOwnFolder(own, run);
    expect((await git(repo, "worktree", "list")).split("\n")).toHaveLength(1);
    expect(await git(repo, "branch", "--list", "mission/m1-helper-*")).toContain("mission/m1-helper-2");
  }, GIT_MS);

  test("a helper has none outside a mission, or in a mission that works in its folder", async () => {
    const { repo, own } = await repository();
    expect(await helperWorktreeFor({ mission: null, own: () => own, exists: existsSync, run })).toMatchObject({ refused: expect.stringContaining("is a mission's") });
    expect(await helperWorktreeFor({ mission: { id: "m1", workdir: repo, branch: null }, own: () => own, exists: existsSync, run })).toMatchObject({ refused: expect.stringContaining("works in its folder") });
  });

  test("the folder a mission moved into is kept on it, for its turns, checks and page", async () => {
    const h = await missionsHarness({ prepare: async (mission) => `${mission.workdir}/worktree` });
    const mission = await h.start();
    expect(h.store.get(mission.id)!.workdir).toBe(`${mission.workdir}/worktree`);
  });

  test("its turns let `delegate` give helpers worktrees only when it works in one of its own", async () => {
    const envelope = (id: string) => ({ gatewayId: "web:mission", chatId: id, text: "go", senderId: "nouride:system", raw: { via: "mission" } }) as never;
    const h = await missionsHarness({ prepare: async (mission) => `/srv/agents/coder/missions/${mission.id}/worktree/app` });
    const moved = await h.start();
    const turn = h.missions.shapeFor(moved.agentId, envelope(moved.id));
    expect(turn?.helperWorktrees).toBe(true);
    // The done notice points the person at the branch: work left uncommitted is not on it.
    expect(turn?.text).toContain(`Commit your work on mission/${moved.id} before you call \`mission\` done`);
    const plain = await missionsHarness();
    const kept = await plain.start();
    const shape = plain.missions.shapeFor(kept.agentId, envelope(kept.id));
    expect(shape?.workdir).toBe(kept.workdir);
    expect(shape?.helperWorktrees).toBeUndefined();
  });
});

/**
 * A branch named at start (0.8.7): repositories with `feat/`/`fix/` names had their missions' work pushed from
 * `mission/<id>` by hand. Git says what a branch name may be, and one already there is refused — its worktree would be
 * refused, or made on work that is not the mission's. Unnamed, it stays `mission/<id>`.
 */
describe("a branch named at start", () => {
  test("is taken when git takes it and it is new — the worktree, the done notice, the page and the helpers are on it", async () => {
    const { repo, own } = await repository();
    expect(await branchRefusal(repo, "feat/mission-ux", run)).toBeNull();
    const mission = { id: "m1", workdir: join(repo, "app"), branch: "feat/mission-ux" };
    const moved = (await makeWorktree(input({ mission, own })))!;
    expect(await git(join(own, "worktree"), "branch", "--show-current")).toBe("feat/mission-ux");
    expect(await git(repo, "branch", "--list", "mission/*")).toBe("");
    expect(worktreeBranch({ ...mission, workdir: moved })).toBe("feat/mission-ux");
    expect(doneNotice({ id: "m1", summary: "Done.", reviewed: false, checks: [], workdir: moved, branch: mission.branch, reason: null }, false)).toEndWith("\nBranch: feat/mission-ux");
    expect(await helperWorktreeFor({ mission: { ...mission, workdir: moved }, own: () => own, exists: existsSync, run })).toEqual({ path: join(own, "helpers", "1"), branch: "feat/mission-ux-helper-1" });
    // Its removal takes the worktrees and leaves the branch, named or not.
    await removeOwnFolder(own, run);
    expect(await git(repo, "branch", "--list", "feat/mission-ux")).toContain("feat/mission-ux");
  });

  test("is refused when git would not take it as a branch name, or rewrites it into another", async () => {
    const { repo } = await repository();
    await git(repo, "checkout", "-q", "-b", "other");
    await git(repo, "checkout", "-q", "main");
    for (const name of ["a..b", "-x", "feat/", "has space", "HEAD", "@{-1}"]) {
      expect(await branchRefusal(repo, name, run)).toBe(`${name} is not a branch name git takes (git check-ref-format --branch).`);
    }
  });

  test("is refused when the repository already has it", async () => {
    const { repo } = await repository();
    expect(await branchRefusal(repo, "main", run)).toBe(`main already exists in ${repo}: name a new branch, or leave \`branch\` out for mission/<id>.`);
  });

  test("goes through start to the row and the page; unnamed, it stays mission/<id>", async () => {
    const h = await missionsHarness({ prepare: async (mission) => `/srv/agents/nova/missions/${mission.id}/worktree` });
    const named = await h.start("ship it", { workdir: "/srv/repo", branch: "fix/queued-reason" });
    expect(h.store.get(named.id)!.branch).toBe("fix/queued-reason");
    const page = h.missions.shapeFor("nova", { gatewayId: "web:mission", chatId: named.id, text: "go", senderId: "nouride:system", raw: { via: "mission" } } as never)?.text;
    expect(page).toContain("a worktree on the branch fix/queued-reason");
    h.missions.stop(named.id, "Gading");
    const unnamed = await h.start("ship it too", { workdir: "/srv/repo" });
    expect(h.store.get(unnamed.id)!.branch).toBeNull();
    expect(worktreeBranch(h.store.get(unnamed.id)!)).toBe(`mission/${unnamed.id}`);
  });

  test("needs a workdir: the mission's own folder is never a repository", async () => {
    const h = await missionsHarness();
    expect(h.missions.start({ agentId: "nova", goal: "x", startedBy: "1", gatewayId: "telegram:nova", chatId: "1", branch: "feat/x" })).toEqual({
      refused: "`branch` names the worktree's branch, so it needs a `workdir` in a git repository.",
    });
  });
});

describe("the worktrees a mission made itself (0.8.7)", () => {
  test("are removed when it ends — from their repository too — the daemon's own kept, and one with uncommitted work kept", async () => {
    const { repo, own } = await repository();
    await makeWorktree(input({ mission: { id: "m1", workdir: join(repo, "app"), branch: null }, own }));
    await helperWorktreeFor({ mission: { id: "m1", workdir: join(own, "worktree", "app"), branch: null }, own: () => own, exists: fileExistsSync, run });
    // What the agent made itself: a baseline checkout, and a scratch one it left changes in.
    await git(repo, "worktree", "add", "-q", "--detach", join(own, "baseline"), "main");
    await git(repo, "worktree", "add", "-q", "--detach", join(own, "scratch", "repo"), "main");
    writeFileSync(join(own, "scratch", "repo", "wip.txt"), "unsaved\n");
    const before = (await git(repo, "worktree", "list")).split("\n").length;

    const { removed, kept } = await removeExtraWorktrees(own, run);
    expect(removed).toEqual([join(own, "baseline")]);
    expect(kept).toEqual([join(own, "scratch", "repo")]);
    expect(fileExistsSync(join(own, "baseline"))).toBe(false);
    expect(fileExistsSync(join(own, "scratch", "repo", "wip.txt"))).toBe(true);
    expect(fileExistsSync(join(own, "worktree", "app", "main.ts"))).toBe(true);
    expect(fileExistsSync(join(own, "helpers", "1"))).toBe(true);
    const list = await git(repo, "worktree", "list");
    expect(list.split("\n").length).toBe(before - 1);
    expect(list).not.toContain(join(own, "baseline"));
  }, GIT_MS);

  test("a submodule checked out in the mission's worktree, or a helper's, is no worktree of its own: neither removed nor kept", async () => {
    // Its `.git` is a file too, as a linked worktree's is, and `worktree remove` refused it: this repository's own
    // `internals/pro` was reported as kept for holding uncommitted work.
    const { root, repo, own } = await repository();
    const lib = join(root, "lib");
    mkdirSync(lib);
    await git(lib, "init", "-q", "-b", "main");
    writeFileSync(join(lib, "index.ts"), "export const lib = 1;\n");
    await git(lib, "add", ".");
    await git(lib, "commit", "-q", "-m", "lib");
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor");
    await git(repo, "commit", "-q", "-m", "a submodule");
    await makeWorktree(input({ mission: { id: "m1", workdir: join(repo, "app"), branch: null }, own }));
    await helperWorktreeFor({ mission: { id: "m1", workdir: join(own, "worktree", "app"), branch: null }, own: () => own, exists: fileExistsSync, run });
    for (const checkout of [join(own, "worktree"), join(own, "helpers", "1")]) {
      await git(checkout, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
      expect(fileExistsSync(join(checkout, "vendor", ".git"))).toBe(true);
    }

    expect(await removeExtraWorktrees(own, run)).toEqual({ removed: [], kept: [] });
    expect(fileExistsSync(join(own, "worktree", "vendor", "index.ts"))).toBe(true);
    expect(fileExistsSync(join(own, "helpers", "1", "vendor", "index.ts"))).toBe(true);

    // A worktree the mission made of the submodule's own repository is a linked one all the same, and goes.
    await git(join(own, "worktree", "vendor"), "worktree", "add", "-q", "--detach", join(own, "vendor-baseline"));
    expect(await removeExtraWorktrees(own, run)).toEqual({ removed: [join(own, "vendor-baseline")], kept: [] });
    expect(fileExistsSync(join(own, "vendor-baseline"))).toBe(false);
  }, GIT_MS);

  test("a mission's end asks for it", async () => {
    const tidied: string[] = [];
    const h = await missionsHarness();
    const mission = await h.start();
    (h.missions as unknown as { deps: { tidy: (m: Mission) => Promise<{ removed: string[]; kept: string[] }> } }).deps.tidy = async (m) => (tidied.push(m.id), { removed: [], kept: [] });
    h.missions.stop(mission.id, "Gading");
    expect(tidied).toEqual([mission.id]);
  });
});

/**
 * Its result files (0.8.11): what git tracks where it works is the work on its branch, which the notice names, and stays
 * there. 20 of the 25 files Nix's last nine missions sent were the code they changed.
 */
describe("what of its files stays on its branch", () => {
  test("a tracked `.ts` stays; a `.png` the work made, and a file in a folder git never saw, are sent", async () => {
    const { repo, own } = await repository();
    const moved = (await makeWorktree(input({ mission: { id: "m1", workdir: join(repo, "app"), branch: null }, own })))!;
    writeFileSync(join(moved, "main.ts"), "export const ok = false;\n");
    writeFileSync(join(moved, "chart.png"), "png");
    mkdirSync(join(moved, "out"), { recursive: true });
    writeFileSync(join(moved, "out", "notes.md"), "notes");
    const files = [join(moved, "main.ts"), join(moved, "chart.png"), join(moved, "out", "notes.md")];
    expect([...((await trackedIn(moved, files, run)) ?? [])]).toEqual([join(moved, "main.ts")]);
    // Where git cannot say, it says so: nothing is held back on a guess, and the caller logs why.
    expect(await trackedIn(join(own, "nowhere"), files, run)).toBeNull();
  }, GIT_MS);
});
