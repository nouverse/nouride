/**
 * The install steps say what is true on this host, and the agent is told what it already has.
 *
 * The steps used to recommend `uv tool install` on a box with no uv and `pip install --user`, which
 * PEP 668 refuses, and said "a person approves each one" to agents nobody is asked about anything for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import { installLadder } from "@/modules/llm/prompt/harness-skills.ts";
import { installedLine, toolchainLines } from "@/modules/llm/prompt/harness-toolchain.ts";
import { fakeAgent } from "../helpers.ts";

const host = { root: false, sudo: false, manager: "apt-get install -y <pkg>", packages: { state: "ready" as const } };

describe("the install steps", () => {
  test("on a service: the installers this host has, landing in the bin directory as written", () => {
    const text = installLadder("/srv/nouride/.nouride/bin", {
      host: { ...host, redirected: true, installers: ["`npm i -g`", "`bun add -g`", "`cargo install`"], python: true },
    });
    expect(text).toContain("`npm i -g`, `bun add -g` and `cargo install` already land in `/srv/nouride/.nouride/bin`");
    expect(text).toContain("`pip install` goes into the shared Python env");
    expect(text).toContain('install -m 755 <file> "$NOURIDE_BIN/<name>"');
    expect(text).toContain("`/srv/nouride/.nouride/opt/<name>-<version>/`");
    expect(text).not.toContain("uv tool install");
    expect(text).not.toContain("pip install --user");
  });

  test("on a person's own machine nothing is claimed about where installers land", () => {
    const text = installLadder("/Users/x/nouride/.nouride/bin", { host: { ...host, redirected: false, installers: ["`npm i -g`"], python: false } });
    expect(text).not.toContain("already land in");
    expect(text).not.toContain("shared Python env");
  });

  test("approvals are stated as they are: nobody is asked at none", () => {
    const none = installLadder("/srv/nouride/.nouride/bin", { host, approvals: "trusted" });
    expect(none).toContain("nobody is asked at your approval level");
    expect(none).not.toContain("a person approves each one");
    expect(installLadder("/srv/nouride/.nouride/bin", { host, approvals: "careful" })).toContain("a person approves each one");
  });
});

describe("what is already there", () => {
  let root: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.HOME;
    root = mkdtempSync(join(tmpdir(), "nouride-steps-"));
    mkdirSync(join(root, ".nouride", "bin"), { recursive: true });
    mkdirSync(join(root, ".nouride", "home"), { recursive: true });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });

  test("the bin directory by name, and HOME as the place settings live", () => {
    const bin = join(root, ".nouride", "bin");
    writeFileSync(join(bin, "yt-dlp"), "");
    writeFileSync(join(bin, "ffmpeg"), "");
    process.env.HOME = join(root, ".nouride", "home");
    const lines = toolchainLines(bin).join("\n");
    expect(lines).toContain(`What is installed in \`${bin}\` is on PATH for every command, so call it by name, with no \`which\` and no full path. RUNTIME lists what is there now.`);
    expect(lines).toContain(`$HOME is \`${join(root, ".nouride", "home")}\``);
    // The rule, not the listing: what is there is RUNTIME's line, so an install never moves the harness.
    expect(lines).not.toContain("ffmpeg");
    expect(installedLine(bin)).toBe(`Installed in \`${bin}\`, on PATH: ffmpeg, yt-dlp.`);
  });

  test("past forty, the rest is a count and the command that lists it", () => {
    const bin = join(root, ".nouride", "bin");
    for (let n = 0; n < 43; n += 1) writeFileSync(join(bin, `tool-${String(n).padStart(2, "0")}`), "");
    expect(installedLine(bin)).toEndWith("tool-39, and 3 more (`ls $NOURIDE_BIN`).");
  });

  test("its own user: what it installs is its own, the shared directory is to run, and HOME is nobody else's", () => {
    const own = join(root, "workspace", "private", "nouva");
    const mine = join(own, ".local", "bin");
    const shared = join(root, ".nouride", "bin");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "rg"), "");
    writeFileSync(join(shared, "ffmpeg"), "");
    const lines = toolchainLines(mine, { home: own, sharedBin: shared }).join("\n");
    expect(lines).toContain(`What you install lands in \`${mine}\`, first on PATH for your commands`);
    expect(lines).toContain(`What is installed for every agent is in \`${shared}\`, on PATH behind it: yours to run, the operator's to change.`);
    expect(lines).toContain(`$HOME is \`${own}\`, your own folder: it persists across restarts and updates and no other agent reads it.`);
    expect(lines).not.toContain("every agent here shares it");
    expect(installedLine(mine, shared)).toBe(`Installed in \`${mine}\`, on PATH: rg. Installed in \`${shared}\`, on PATH: ffmpeg.`);
    const ladder = installLadder(mine, { ownHome: own, sharedBin: shared, host: { root: false, sudo: false, manager: null, installers: ["`npm i -g`"], python: true } });
    expect(ladder).toContain(`\`npm i -g\` already land in \`${mine}\` (your own, on PATH for your commands`);
    expect(ladder).toContain("`pip install` goes into your own Python env");
    expect(ladder).toContain(`a release of several files goes in \`${join(own, ".local", "opt")}/<name>-<version>/\``);
  });

  // "Ask the orchestrator" with no name sent root work to an agent called Infra Ops: each is told who, by name.
  test("its own user: the orchestrator is told it installs for every agent; any other agent, to ask it by name", () => {
    const own = join(root, "workspace", "private", "nouva");
    const shared = join(root, ".nouride", "bin");
    const host = { root: false, sudo: false, manager: null, installers: ["`npm i -g`"], python: false };
    const mine = join(own, ".local", "bin");
    const ladder = (sharedTools: { name: string; mine: boolean; on: boolean } | null) => installLadder(mine, { ownHome: own, sharedBin: shared, sharedTools, host });
    const orchestrator = ladder({ name: "Nouva", mine: true, on: true });
    expect(orchestrator).toContain("You are the orchestrator: the other agents come to you when they need a program they all run.");
    expect(orchestrator).toContain("`nouride tools run -- <the install command>` through the `nouride` tool");
    expect(orchestrator).toContain(`runs it as the daemon in \`${shared}\``);
    const other = ladder({ name: "Nouva", mine: false, on: true });
    expect(other).toContain("What every agent runs is Nouva's to change, the orchestrator: for something they all need, ask Nouva.");
    expect(other).not.toContain("nouride tools run");
    // Where agents share the daemon's user, none of it is said.
    expect(installLadder(shared, { host })).not.toContain("orchestrator");
  });

  test("the switch off, or no orchestrator: each is told where a person turns it on, to point them there", () => {
    const own = join(root, "workspace", "private", "nix");
    const shared = join(root, ".nouride", "bin");
    const host = { root: false, sudo: false, manager: null, installers: [], python: false };
    const ladder = (sharedTools: { name: string; mine: boolean; on: boolean } | null) => installLadder(join(own, ".local", "bin"), { ownHome: own, sharedBin: shared, sharedTools, host });
    const where = "An admin turns it on in the dashboard: Agents → Nouva → Settings → Programs every agent runs.";
    expect(ladder({ name: "Nouva", mine: true, on: false })).toContain(`You are the orchestrator, but installing programs for every agent is off for you. ${where}`);
    expect(ladder({ name: "Nouva", mine: false, on: false })).toContain(`No agent installs programs for every agent now: the switch is off. ${where} Until then, ask the person who runs Nouride.`);
    expect(ladder({ name: "Nouva", mine: true, on: false })).not.toContain("nouride tools run");
    expect(ladder(null)).toContain("No agent installs programs for every agent: this install has no orchestrator. For something they all need, ask the person who runs Nouride.");
  });

  test("nothing at all when there is no bin directory to describe, or nothing in it", () => {
    expect(toolchainLines(undefined)).toEqual([]);
    expect(installedLine(undefined)).toBeUndefined();
    expect(installedLine(join(root, ".nouride", "bin"))).toBeUndefined();
  });

  /**
   * The harness listed what the bin directory held, so an agent installing something mid-conversation rewrote the
   * harness block and took it out of the cache. The listing is RUNTIME's now — the last block, which no breakpoint is
   * put on — and the harness says what the directory is for, which no install changes.
   */
  test("a program installed mid-conversation changes no cached block, and is listed all the same", () => {
    const bin = join(root, ".nouride", "bin");
    writeFileSync(join(bin, "ffmpeg"), "");
    const prompt = () =>
      buildSystemPrompt({
        agent: fakeAgent(),
        tools: [{ name: "exec", description: "run a command", parameters: { type: "object" } }],
        harness: { approvalRequired: ["exec"], approvalAvailable: true, maxToolIterations: 25, maxTurnDurationMs: 300_000, commands: [], truncates: true, binDir: bin },
        gateway: "telegram",
        chatId: "chat-1",
        chatType: "dm",
        sessionId: "ses_1",
        model: "claude-sonnet-4-20250514",
        now: new Date("2026-10-17T00:00:00Z"),
        timezone: "UTC",
      });
    const before = prompt();
    writeFileSync(join(bin, "yt-dlp"), "");
    // A new entry moves the directory's mtime, which is what the listing is re-read on; set it outright so a coarse
    // clock cannot make the two reads one.
    utimesSync(bin, new Date(), new Date(Date.now() + 5_000));
    const after = prompt();

    expect(after.blocks.filter((block) => block.cache)).toEqual(before.blocks.filter((block) => block.cache));
    expect(after.blocks.find((block) => block.text.includes("<<<NOURIDE:HARNESS>>>"))!.text).toContain(`What is installed in \`${bin}\` is on PATH`);
    expect(before.blocks.at(-1)!.text).toContain(`Installed in \`${bin}\`, on PATH: ffmpeg.`);
    expect(after.blocks.at(-1)!.text).toContain(`Installed in \`${bin}\`, on PATH: ffmpeg, yt-dlp.`);
    expect(after.blocks.at(-1)!.cache).toBeUndefined();
  });
});
