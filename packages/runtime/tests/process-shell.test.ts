/**
 * The shell a command line runs in is never one from the directories agents can write, and the PATH it
 * runs with survives a login profile that resets it.
 *
 * Both through `runCommand`, the way `exec` reaches them: a `bash` planted in the bin directory, which
 * comes first on every command's PATH, is exactly the shadow this exists to refuse.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../src/process.ts";
import { systemProgram, withBinFirst } from "../src/process-shell.ts";

const sandbox = { cwd: tmpdir(), timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };
let root: string;
let bin: string;
let home: string;

function program(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-shell-"));
  bin = join(root, ".nouride", "bin");
  home = join(root, ".nouride", "home");
  mkdirSync(home, { recursive: true });
  program(bin, "bash", "echo planted");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the shell", () => {
  test("a bash in the agents' bin directory is not the one that runs the command", async () => {
    const env = { PATH: `${bin}:/usr/bin:/bin`, NOURIDE_BIN: bin, HOME: home };
    const result = await runCommand(["bash", "-lc", "echo real"], { ...sandbox, env });
    expect(result.stdout.trim()).toBe("real");
  });

  test("anything under .nouride is skipped, the Python env and HOME's tool directories included", () => {
    program(join(root, ".nouride", "opt", "python", "bin"), "tar", "echo planted");
    const path = `${bin}:${join(root, ".nouride", "opt", "python", "bin")}:/usr/bin:/bin`;
    expect(systemProgram("tar", { PATH: path, NOURIDE_BIN: bin })).not.toContain(".nouride");
  });

  test("a shell named by its full path is the caller's choice", () => {
    expect(withBinFirst([join(bin, "bash"), "-c", "x"], { NOURIDE_BIN: bin })[0]).toBe(join(bin, "bash"));
  });
});

describe("the PATH after a login profile", () => {
  test("NOURIDE_PATH is put back whole, not only the bin directory", async () => {
    const env = join(root, ".nouride", "opt", "python", "bin");
    program(env, "hello-env", "echo hi");
    writeFileSync(join(home, ".bash_profile"), "PATH=/usr/bin:/bin\n");
    const composed = `${bin}:${env}:/usr/bin:/bin`;
    const result = await runCommand(["bash", "-lc", "command -v hello-env || echo missing"], {
      ...sandbox,
      env: { PATH: composed, NOURIDE_BIN: bin, NOURIDE_PATH: composed, HOME: home },
    });
    expect(result.stdout.trim()).toBe(join(env, "hello-env"));
  });
});
