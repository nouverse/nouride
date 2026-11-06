/**
 * What the versioned git hooks run (`.githooks/`). The pre-commit hook runs `lint:check` and two of the suite's tests
 * that take half a second and each turned a push red that a commit could have caught. A clean merge, which git commits
 * by itself without the pre-commit hook, runs the same through `pre-merge-commit` (0.8.17).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "../../../../.githooks");
/** A hook's commands: its lines that are not comments. */
const commands = (name: string) =>
  readFileSync(join(HOOKS, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pre-commit", () => {
  test("runs lint:check and the two half-second tests, and its summary line names them", () => {
    const run = commands("pre-commit");
    expect(run).toContain("bun run lint:check");
    expect(run).toContain("bun test ./apps/engine/tests/contracts/test-waits.test.ts ./apps/engine/tests/contracts/dashboard-wire.test.ts");
    expect(run.find((line) => line.startsWith('echo "pre-commit: arch'))).toEndWith(" · test waits · dashboard wire\"");
  });
});

describe("a clean merge", () => {
  /** A repository with two branches that merge without a hand, its hooks `.githooks/pre-merge-commit` and a stand-in pre-commit. */
  function repository(preCommit: string): { git: (...args: string[]) => { status: number | null; out: string }; ran: () => number } {
    const dir = mkdtempSync(join(tmpdir(), "nouride-hooks-"));
    dirs.push(dir);
    mkdirSync(join(dir, "hooks"));
    copyFileSync(join(HOOKS, "pre-merge-commit"), join(dir, "hooks", "pre-merge-commit"));
    writeFileSync(join(dir, "hooks", "pre-commit"), `#!/bin/sh\necho ran >> "${join(dir, "ran")}"\n${preCommit}\n`);
    chmodSync(join(dir, "hooks", "pre-commit"), 0o755);
    mkdirSync(join(dir, "repo"));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => {
      const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", `core.hooksPath=${join(dir, "hooks")}`, ...args], { cwd: join(dir, "repo"), env, encoding: "utf8" });
      return { status: run.status, out: run.stdout + run.stderr };
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "repo", "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "--no-verify", "-m", "a");
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "repo", "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "--no-verify", "-m", "b");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "repo", "c.txt"), "c\n");
    git("add", "c.txt");
    git("commit", "-q", "--no-verify", "-m", "c");
    const ran = () => {
      try {
        return readFileSync(join(dir, "ran"), "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    return { git, ran };
  }

  test("runs pre-commit, through pre-merge-commit, which is executable", () => {
    expect(statSync(join(HOOKS, "pre-merge-commit")).mode & 0o111).toBe(0o111);
    expect(commands("pre-merge-commit")).toEqual(['exec "$(dirname "$0")/pre-commit"']);
    const { git, ran } = repository("exit 0");
    expect(git("merge", "--no-edit", "side").status).toBe(0);
    expect(ran()).toBe(1);
    expect(git("log", "-1", "--format=%P").out.trim().split(" ")).toHaveLength(2);
  });

  test("is refused when pre-commit fails, and no merge commit is made", () => {
    const { git, ran } = repository("exit 1");
    expect(git("merge", "--no-edit", "side").status).not.toBe(0);
    expect(ran()).toBe(1);
    expect(git("log", "-1", "--format=%s").out.trim()).toBe("c");
  });
});
