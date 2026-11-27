/**
 * A coding CLI its maker installs with a script of its own, installed for every agent: `nouride agents install
 * <cli>`. Antigravity's, Cursor's and Grok Build's cards had no Set it up, because the orchestrator installs only with a
 * package manager, and their installers leave the CLI in the installing user's HOME. The command runs the maker's
 * script as `tools run` runs an install, copies the CLI into the install's `opt/<id>` and links it into `bin`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_CLIS, type CliRow } from "@nouride/acp";
import type { Client } from "@nouride/cli-kit";
import { installCli, scriptInstall } from "../../../cli/src/commands/agents-install.ts";
import { plain } from "../cli-harness.ts";

const of = (id: string) => BUILT_IN_CLIS.find((row) => row.id === id)!;

describe("which CLIs are installed by their maker's script", () => {
  test("Antigravity, Cursor and Grok Build, each said as the one command that installs it; the npm ones are not", () => {
    const scripted = BUILT_IN_CLIS.filter((row) => row.script).map((row) => [row.id, row.install]);
    expect(scripted).toEqual([
      ["antigravity", "nouride agents install antigravity"],
      ["cursor", "nouride agents install cursor"],
      ["grok", "nouride agents install grok"],
    ]);
    for (const row of BUILT_IN_CLIS.filter((one) => !one.script)) expect({ id: row.id, npm: row.install.startsWith("npm ") }).toEqual({ id: row.id, npm: true });
  });
});

describe("the install, run for real against a stand-in installer", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nr-cli-install-"));
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "bin"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A maker's installer, served from a file: what it writes into HOME is the shell in `body`. */
  function installer(body: string): string {
    const path = join(root, "install.sh");
    writeFileSync(path, `set -e\n${body}\n`);
    return `file://${path}`;
  }

  function run(row: CliRow) {
    const [program, ...args] = scriptInstall(row as CliRow & { script: NonNullable<CliRow["script"]> });
    const ran = spawnSync(program!, args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), NOURIDE_BIN: join(root, "bin") }, encoding: "utf8" });
    return { status: ran.status, stderr: ran.stderr };
  }

  const version = (path: string) => spawnSync(path, [], { encoding: "utf8" }).stdout.trim();

  test("one file: copied into opt/<id> and linked into bin by the name it is started by", () => {
    const url = installer(`mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho agy 1.5.18\\n' > "$HOME/.local/bin/agy"; chmod 755 "$HOME/.local/bin/agy"`);
    expect(run({ ...of("antigravity"), script: { url, binary: ".local/bin/agy" } }).status).toBe(0);
    expect(version(join(root, "bin", "agy"))).toBe("agy 1.5.18");
    expect(existsSync(join(root, "opt", "antigravity", "agy"))).toBe(true);
  });

  test("a link in HOME is followed: Grok's names a file of another name, and that file is what is copied", () => {
    const url = installer(`mkdir -p "$HOME/.grok/bin"; printf '#!/bin/sh\\necho grok 1.0.92\\n' > "$HOME/.grok/bin/grok-linux-x86_64"; chmod 755 "$HOME/.grok/bin/grok-linux-x86_64"; ln -s grok-linux-x86_64 "$HOME/.grok/bin/grok"`);
    expect(run({ ...of("grok"), script: { url, binary: ".grok/bin/grok" } }).status).toBe(0);
    expect(version(join(root, "bin", "grok"))).toBe("grok 1.0.92");
  });

  test("a folder: everything beside the file comes along, and an install again leaves nothing of the one before", () => {
    const body = (v: string, extra: string) =>
      `d="$HOME/.local/share/cursor-agent/versions/${v}"; mkdir -p "$d" "$HOME/.local/bin"; echo ${v} > "$d/${extra}"; printf '#!/bin/sh\\ncat "$(dirname "$(readlink -f "$0")")/${extra}"\\n' > "$d/cursor-agent"; chmod 755 "$d/cursor-agent"; ln -sfn "$d/cursor-agent" "$HOME/.local/bin/agent"`;
    const row = (url: string) => ({ ...of("cursor"), script: { url, binary: ".local/bin/agent", folder: true as const } });
    expect(run(row(installer(body("2026.11.22", "old.txt")))).status).toBe(0);
    expect(version(join(root, "bin", "cursor-agent"))).toBe("2026.11.22");
    expect(run(row(installer(body("2026.11.30", "new.txt")))).status).toBe(0);
    expect(version(join(root, "bin", "cursor-agent"))).toBe("2026.11.30");
    expect(existsSync(join(root, "opt", "cursor", "new.txt"))).toBe(true);
    expect(existsSync(join(root, "opt", "cursor", "old.txt"))).toBe(false);
  });

  test("an installer that leaves nothing where its row says fails, and links nothing", () => {
    const ran = run({ ...of("antigravity"), script: { url: installer("true"), binary: ".local/bin/agy" } });
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("the installer left nothing at ~/.local/bin/agy");
    expect(existsSync(join(root, "bin", "agy"))).toBe(false);
  });

  test("an installer that fails stops it there", () => {
    expect(run({ ...of("antigravity"), script: { url: installer("exit 3"), binary: ".local/bin/agy" } }).status).not.toBe(0);
    expect(existsSync(join(root, "opt"))).toBe(false);
  });

  test("the row's words reach the script as arguments, never as its text", () => {
    const words = scriptInstall({ ...of("antigravity"), script: { url: "https://x/$(id)", binary: ".local/bin/agy" } });
    expect(words.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(words[2]).not.toContain("https://");
    expect(words.slice(3)).toEqual(["install", "https://x/$(id)", ".local/bin/agy", "antigravity", "file", "agy"]);
  });

  test("its script is a script a shell reads", () => {
    const path = join(root, "check.sh");
    writeFileSync(path, scriptInstall(of("cursor") as CliRow & { script: NonNullable<CliRow["script"]> })[2]!);
    chmodSync(path, 0o644);
    expect(spawnSync("bash", ["-n", path]).status).toBe(0);
    expect(readFileSync(path, "utf8")).toContain('curl -fsSL "$1" | bash');
  });
});

describe("`nouride agents install`", () => {
  let lines: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];
  class Exit extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }
  beforeEach(() => {
    lines = [];
    spies = [
      spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? "")))),
      spyOn(console, "error").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? "")))),
      spyOn(process, "exit").mockImplementation(((code: number) => {
        throw new Exit(code);
      }) as never),
    ];
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  /** A daemon whose scan says `installed` before the install and `after` once it ran; each install's words kept. */
  function daemon(installed: boolean, after: boolean) {
    const ran: string[][] = [];
    const client = {
      get: async () => ({ room: { enough: true, bytes: 0, needs: 0 }, clis: [{ id: "antigravity", name: "Antigravity", command: "agy", install: "", login: true, installed: ran.length > 0 ? after : installed, version: "1.5.18" }] }),
    } as unknown as Client;
    return { client, ran, install: async (command: readonly string[], exitCode = 0) => (ran.push([...command]), { exitCode, shared: exitCode === 0 ? { ok: true } : null }) };
  }

  test("runs the maker's script as `tools run` installs, and says it is there for every agent", async () => {
    const { client, ran, install } = daemon(false, true);
    await installCli(client, ["antigravity"], install);
    expect(ran).toEqual([scriptInstall(of("antigravity") as CliRow & { script: NonNullable<CliRow["script"]> })]);
    expect(lines.join("\n")).toContain("Antigravity 1.5.18 is installed for every agent");
  });

  test("installed already: nothing is run", async () => {
    const { client, ran, install } = daemon(true, true);
    await installCli(client, ["antigravity"], install);
    expect(ran).toEqual([]);
    expect(lines.join("\n")).toContain("Antigravity is installed already, at 1.5.18");
  });

  test("an installer that did not finish, or a CLI not found after it, fails and says which", async () => {
    const failed = daemon(false, false);
    await expect(installCli(failed.client, ["antigravity"], (command) => failed.install(command, 1))).rejects.toThrow("exit 1");
    expect(lines.join("\n")).toContain("Antigravity's installer did not finish (exit 1)");
    lines = [];
    const missing = daemon(false, false);
    await expect(installCli(missing.client, ["antigravity"], missing.install)).rejects.toThrow("exit 1");
    expect(lines.join("\n")).toContain("`agy` does not run where the agents run it");
  });

  test("an npm one is pointed at the install it has, and one not built in is refused, with nothing run", async () => {
    const { client, ran, install } = daemon(false, true);
    await expect(installCli(client, ["claude-code"], install)).rejects.toThrow("exit 1");
    expect(lines.join("\n")).toContain("nouride tools run -- npm i -g @agentclientprotocol/claude-agent-acp");
    await expect(installCli(client, ["vim"], install)).rejects.toThrow("exit 2");
    expect(ran).toEqual([]);
  });
});
