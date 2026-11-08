/**
 * `nouride tools run` (0.8.1): an installer installing, updating or removing a program for every agent — nothing else.
 * It runs as the daemon's user, who owns every pack, the database and the secret store; on the live box the trusted
 * orchestrator ran `cat`, `cp` and `python3 -c` on other agents' config.toml through it, and `su` to one of them.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notAnInstall } from "@/modules/toolchain/installers.ts";
import { usageFor } from "@/cli/usage.ts";
import { runCli } from "../cli-harness.ts";
import { tempDir } from "../helpers.ts";

describe("nouride tools run", () => {
  test("runs on an install with no .nouride/home, as a plain `nouride start` in a person's own home leaves it, and makes it", async () => {
    const root = tempDir("tools-run-home");
    const data = join(root, ".nouride", "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(root, "config.toml"), `[daemon]\ndata_dir = "${data}"\n`);
    // `npm --version` is no install: refused before it runs, it shows nothing. An install the folder decides is.
    const run = await runCli(["tools", "run", "--", "npm", "i", "-g", "--dry-run", "--offline", "left-pad-not-here"], { cwd: root, config: join(root, "config.toml") });
    // What it failed with in a folder that was not there: the spawn itself, said as a missing `setsid`.
    expect(run.err).not.toContain("posix_spawn");
    expect(existsSync(join(root, ".nouride", "home"))).toBe(true);
  }, 60_000);

  test("runs an installer's install, update or removal", () => {
    for (const command of [
      ["npm", "i", "-g", "@agentclientprotocol/claude-agent-acp"],
      ["npm", "update", "--global", "typescript"],
      ["bun", "add", "-g", "@oh-my-pi/pi-coding-agent"],
      ["pipx", "install", "ruff"],
      ["uv", "tool", "install", "ruff"],
      ["pip", "install", "requests==2.32.0"],
      ["cargo", "install", "ripgrep"],
      ["go", "install", "golang.org/x/tools/gopls@latest"],
      ["rustup", "update"],
      ["claude", "update"],
    ]) {
      expect({ command, refused: notAnInstall(command) }).toEqual({ command, refused: null });
    }
  });

  test("refuses anything else — what the orchestrator ran on the live box among it", () => {
    for (const command of [
      ["cat", "/srv/nouride/.nouride/agents/nix/config.toml"],
      ["cp", "-a", "/srv/nouride/.nouride/agents/nix/config.toml", "/tmp/x"],
      ["python3", "-c", "open('x').read()"],
      ["su", "-s", "/bin/bash", "nr-nix", "-c", "claude --version"],
      ["ls", "-la", "/srv/nouride/.nouride/workspace/private/nix"],
      ["npm", "i", "left-pad"],
      ["npm", "exec", "-g", "x"],
    ]) {
      expect(notAnInstall(command)).toContain("runs an installer");
    }
  });

  test("refuses a flag that puts it elsewhere, and a path in place of a package's name", () => {
    for (const command of [
      ["npm", "i", "-g", "--prefix", "/srv/nouride/.nouride/agents/nix", "x"],
      ["npm", "i", "-g", "--prefix=/tmp", "x"],
      ["pip", "install", "-r", "/srv/nouride/.nouride/data/secrets.json"],
      ["pip", "install", "--target", "/srv/nouride/.nouride/agents"],
      ["npm", "i", "-g", "/srv/nouride/.nouride/agents/nix"],
      ["npm", "i", "-g", "./local"],
      ["cargo", "install", "--root", "/srv", "x"],
    ]) {
      expect(notAnInstall(command)).toContain("is not taken here");
    }
  });

  test("reads a flag by its name before `=`, and a path or a file URL anywhere in a word", () => {
    // Only the bare word was read: `--report=<data>/secrets.json` passed, and pip writes its report over the secret store,
    // `--log=` over an agent's SOUL.md — what the daemon's user owns, joined to a flag the list did not name.
    for (const command of [
      ["pip", "install", "--dry-run", "--report=/srv/nouride/.nouride/data/secrets.json", "x"],
      ["pip", "install", "--report", "report.json", "x"],
      ["pip", "install", "--log=/srv/nouride/.nouride/agents/nox/SOUL.md", "x"],
      ["pip", "install", "-t/tmp/x", "x"],
      ["pip", "install", "--target=x/../../data", "x"],
      ["pip", "install", "git+file:///srv/nouride/.nouride/agents/.git"],
      ["pip", "install", "x", "@", "file:///tmp/x"],
      ["npm", "i", "-g", "x", "--userconfig=/srv/nouride/.nouride/data/secrets.json"],
      ["npm", "i", "-g", "x", "--script-shell=/tmp/sh"],
      ["npm", "i", "-g", "git+file:///tmp/repo"],
      ["bun", "add", "-g", "x", "--cwd=/srv"],
      ["pipx", "install", "--pip-args=--target=/tmp/x", "x"],
      ["uv", "tool", "install", "--with-requirements=reqs.txt", "x"],
      ["cargo", "install", "--path=/tmp/x"],
      ["cargo", "install", "--git=/tmp/repo", "x"],
      ["go", "install", "-toolexec=/tmp/x", "golang.org/x/tools/gopls@latest"],
      ["go", "install", "--modfile=x.mod", "golang.org/x/tools/gopls@latest"],
    ]) {
      expect({ command, refused: notAnInstall(command)?.includes("is not taken here") }).toEqual({ command, refused: true });
    }
    // And what only looks like one stays an install: a version range, a scoped name, a remote URL, Go's own flags.
    for (const command of [
      ["npm", "i", "-g", "typescript@~5.4", "@scope/pkg@1.2.3", "--registry=https://registry.example/"],
      ["pip", "install", "--pre", "requests~=2.32"],
      ["uv", "tool", "install", "--python", "3.12", "--from", "git+https://github.com/astral-sh/ruff", "ruff"],
      ["cargo", "install", "-f", "--locked", "ripgrep"],
      ["go", "install", "-trimpath", "golang.org/x/tools/gopls@latest"],
    ]) {
      expect({ command, refused: notAnInstall(command) }).toEqual({ command, refused: null });
    }
  });

  test("its help says whose it is and what it runs — an agent reads it before it calls the command", () => {
    // The orchestrator reads `nouride help` before a command it does not know. The help said the shared install was
    // "where each agent is its own user" and called it "the orchestrator's" in a parenthesis it read as an aside.
    const help = (usageFor("tools") ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
    expect(help).toContain("Install or update a program every agent runs, as the daemon's user: the orchestrator's job; an agent's own installs stay in its HOME.");
    expect(help).toContain("An installer only: npm or bun with -g, pipx, uv tool, pip, cargo, go install, rustup, claude update");
  });
});
