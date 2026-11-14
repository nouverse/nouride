import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileAtomic, readPlainTextFile, resolveWithin, writeFileAtomic, writeTextFileAtomic } from "../src/fs.ts";

describe("resolveWithin", () => {
  // On macOS /tmp is a symlink to /private/tmp. resolveWithin now resolves symlinks, so the
  // expected output uses the real path of /tmp as the prefix.
  const base = "/tmp/nouride-workspace";
  const realTmp = realpathSync("/tmp");
  const resolvedBase = `${realTmp}/nouride-workspace`;

  test("resolves a plain relative path", () => {
    expect(resolveWithin(base, "notes.md")).toBe(`${resolvedBase}/notes.md`);
    expect(resolveWithin(base, "sub/dir/notes.md")).toBe(`${resolvedBase}/sub/dir/notes.md`);
  });

  test("allows an absolute path that is already inside the base", () => {
    expect(resolveWithin(base, `${base}/notes.md`)).toBe(`${resolvedBase}/notes.md`);
  });

  test("normalizes interior traversal that stays inside", () => {
    expect(resolveWithin(base, "sub/../notes.md")).toBe(`${resolvedBase}/notes.md`);
  });

  test("a name that merely starts with two dots is inside — `..notes.md` was refused as a way out", () => {
    expect(resolveWithin(base, "..notes.md")).toBe(`${resolvedBase}/..notes.md`);
    expect(resolveWithin(base, "..drafts/a.md")).toBe(`${resolvedBase}/..drafts/a.md`);
    expect(() => resolveWithin(base, "../notes.md")).toThrow();
  });

  // This is the sandbox boundary from §7.1 SPEC — every one of these is a way a
  // model-supplied path could try to read outside the agent's workspace.
  test.each([
    ["parent traversal", "../secrets.txt"],
    ["deep traversal", "../../../../etc/passwd"],
    ["traversal after a valid segment", "sub/../../../etc/passwd"],
    ["absolute path elsewhere", "/etc/passwd"],
    ["sibling with a shared prefix", "/tmp/nouride-workspace-evil/x"],
  ])("refuses %s", (_label, candidate) => {
    expect(() => resolveWithin(base, candidate)).toThrow(/escapes workspace/);
  });
});

describe("escapes", () => {
  test("is `..` itself, `..` and a separator, or an absolute path — never a name that starts with two dots", async () => {
    const { escapes } = await import("../src/path.ts");
    expect(["..", "../x", "../../x", "/elsewhere"].map(escapes)).toEqual([true, true, true, true]);
    expect(["", "x", "..x", "..creds/token.json", "a/../b"].map(escapes)).toEqual([false, false, false, false, false]);
  });
});

describe("readPlainTextFile", () => {
  // A file in a folder another user writes, read with the daemon's rights (0.8.1): never through a link or from a device.
  test("a plain file is read, and one that is not there is null", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-plain-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "the person's lines");
      expect(readPlainTextFile(join(dir, "AGENTS.md"), 1024)).toBe("the person's lines");
      expect(readPlainTextFile(join(dir, "missing.md"), 1024)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a link, a pipe and a file past its size are refused, not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-plain-"));
    try {
      writeFileSync(join(dir, "elsewhere.txt"), "not this folder's");
      symlinkSync(join(dir, "elsewhere.txt"), join(dir, "linked.md"));
      expect(() => readPlainTextFile(join(dir, "linked.md"), 1024)).toThrow("is a link");
      expect(spawnSync("mkfifo", [join(dir, "pipe.md")]).status).toBe(0);
      expect(() => readPlainTextFile(join(dir, "pipe.md"), 1024)).toThrow("is not a plain file");
      writeFileSync(join(dir, "big.md"), "x".repeat(2048));
      expect(() => readPlainTextFile(join(dir, "big.md"), 1024)).toThrow("more than the 1024");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * An atomic write that reaches the disk. A rename can land before the data it points at: after a power cut the name
 * held zero bytes, and a `secrets.json` that empty opened as no secrets at all (0.8.17). What is synced, and when, is
 * read off the calls into `node:fs`: a power cut itself cannot be staged in a test.
 */
describe("an atomic write syncs the new file before the rename and its folder after", () => {
  const dirs: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The syncs and renames of one write, in order: the temp file, the folder, or the rename. */
  function recorded(dir: string, failSync: "temp" | "folder" | null = null): string[] {
    const steps: string[] = [];
    const paths = new Map<number, string>();
    const [open, fsync, rename] = [fs.openSync, fs.fsyncSync, fs.renameSync];
    const what = (path: string) => (path === dir ? "folder" : path.endsWith(".tmp") ? "temp" : path);
    spies.push(
      spyOn(fs, "openSync").mockImplementation(((path: string, ...rest: never[]) => {
        const fd = (open as (...args: unknown[]) => number)(path, ...rest);
        paths.set(fd, String(path));
        return fd;
      }) as typeof fs.openSync),
      spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
        const step = what(paths.get(fd) ?? "");
        steps.push(`sync ${step}`);
        if (step === failSync) throw Object.assign(new Error(`EIO: i/o error, fsync`), { code: "EIO" });
        fsync(fd);
      }),
      spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
        steps.push("rename");
        rename(from, to);
      }),
    );
    return steps;
  }

  function fresh(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nouride-durable-")));
    dirs.push(dir);
    return dir;
  }

  test.each([
    ["writeTextFileAtomic", (path: string) => writeTextFileAtomic(path, "new\n")],
    ["writeTextFileAtomic with a mode", (path: string) => writeTextFileAtomic(path, "new\n", { mode: 0o600 })],
    ["writeFileAtomic", (path: string) => writeFileAtomic(path, new TextEncoder().encode("new\n"))],
    ["copyFileAtomic", (path: string) => {
      writeFileSync(`${path}.source`, "new\n");
      copyFileAtomic(`${path}.source`, path);
    }],
  ])("%s", async (_writer, write) => {
    const dir = fresh();
    const path = join(dir, "secrets.json");
    writeFileSync(path, "old\n");
    const steps = recorded(dir);
    await write(path);
    expect(steps).toEqual(["sync temp", "rename", "sync folder"]);
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });

  test("a folder that cannot be synced is not an error: the write is as atomic as it was", async () => {
    const dir = fresh();
    const path = join(dir, "secrets.json");
    recorded(dir, "folder");
    await writeTextFileAtomic(path, "new\n");
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });

  test("a new file that cannot be synced is: the old one stays whole, and no temp file is left", async () => {
    const dir = fresh();
    const path = join(dir, "secrets.json");
    writeFileSync(path, "old\n");
    const steps = recorded(dir, "temp");
    await expect(writeTextFileAtomic(path, "new\n")).rejects.toThrow(/EIO/);
    expect(steps).toEqual(["sync temp"]);
    expect(readFileSync(path, "utf8")).toBe("old\n");
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  });
});

describe("the space on the disk a folder is on", () => {
  test("a folder that is there says its filesystem's size and what is free; one that is not says nothing, never 0", async () => {
    const { diskSpace, freeDiskBytes } = await import("../src/fs.ts");
    const here = diskSpace(import.meta.dir);
    expect(here).not.toBeNull();
    expect(here!.totalBytes).toBeGreaterThan(0);
    expect(here!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(here!.freeBytes).toBeLessThanOrEqual(here!.totalBytes);
    // The same count of free bytes the boot's own check reads.
    expect(Math.abs(here!.freeBytes - freeDiskBytes(import.meta.dir)!)).toBeLessThan(here!.totalBytes * 0.05);
    expect(diskSpace("/no/such/folder/anywhere")).toBeNull();
  });
});
