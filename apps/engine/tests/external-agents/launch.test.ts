/**
 * How an external agent's CLI starts (0.8.1): its profile folder and starting files made by a shell step run as the
 * agent, a file already there kept, then the CLI in that step's place; its environment pointing it at the profile.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_CLIS, type CliRow } from "@nouride/acp";
import { launchFor, prepareScript, profileDirOf } from "@/modules/external-agents/launch.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "external-launch-"));
  dirs.push(dir);
  return dir;
};
const row = (id: string): CliRow => BUILT_IN_CLIS.find((one) => one.id === id)!;

describe("the shell step before the CLI", () => {
  test("makes the profile and its starting files, quotes survive, then runs the CLI in its place", () => {
    const profile = join(temp(), "codex", "default");
    const script = prepareScript({ "config.toml": "a = 'it''s'\nb = \"x\"\n" });
    const run = spawnSync("sh", ["-c", script, "nouride-cli", profile, "cat", join(profile, "config.toml")], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("a = 'it''s'\nb = \"x\"\n");
  });

  test("keeps a file the person already has", () => {
    const profile = join(temp(), "p");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "config.toml"), "mine = true\n");
    spawnSync("sh", ["-c", prepareScript({ "config.toml": "theirs = true\n" }), "nouride-cli", profile, "true"]);
    expect(readFileSync(join(profile, "config.toml"), "utf8")).toBe("mine = true\n");
  });
});

describe("the launch", () => {
  test("points the CLI at a profile in the agent's own folder, with its row's environment and no browser", () => {
    const own = temp();
    const launch = launchFor({ row: row("claude-code"), profile: "work", privateDir: own, secrets: { ANTHROPIC_API_KEY: "k" } });
    const profile = profileDirOf(own, "claude-code", "work");
    expect(launch.profileDir).toBe(profile);
    expect(launch.cwd).toBe(own);
    expect(launch.env).toMatchObject({ CLAUDE_CONFIG_DIR: profile, CLAUDE_AGENT_ACP_PROTOCOL: "v1", DISABLE_AUTOUPDATER: "1", NO_BROWSER: "1", ANTHROPIC_API_KEY: "k" });
    // Its account's claude.ai connectors stay off: their tools reach outside Nouride's gate and audit (0.8.1).
    expect(launch.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(launch.cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(launch.cmd.slice(3)).toEqual(["nouride-cli", profile, "claude-agent-acp"]);
  });

  test("a CLI with no profile variable starts as itself, its HOME the profile", () => {
    const own = temp();
    const plain: CliRow = { id: "mine", name: "Mine", command: "mine-acp", args: ["--acp"], install: "", versionArgs: [], instructionFile: "AGENTS.md" };
    const launch = launchFor({ row: plain, profile: "default", privateDir: own, secrets: {} });
    expect(launch.cmd).toEqual(["mine-acp", "--acp"]);
    expect(launch.profileDir).toBeUndefined();
    expect(existsSync(join(own, ".cli"))).toBe(false);
  });
});

/**
 * Where each built-in CLI reads the agent's persona. Codex reads `AGENTS.md` in `CODEX_HOME` whatever folder it works
 * in (codex-rs `codex-home/src/instructions`) and, from a mission's repository, no other the agent owns; Claude Code
 * looks for `CLAUDE.md` up from where it works, which reaches the agent's folder from a mission inside it.
 */
describe("where a built-in CLI reads the agent's persona", () => {
  test("Codex in its profile, read in any folder; Claude Code in the agent's folder", () => {
    expect(row("codex")).toMatchObject({ profileEnv: "CODEX_HOME", profileInstructionFile: "AGENTS.md" });
    expect(row("claude-code").profileInstructionFile).toBeUndefined();
    expect(row("claude-code").instructionFile).toBe("CLAUDE.md");
  });
});
