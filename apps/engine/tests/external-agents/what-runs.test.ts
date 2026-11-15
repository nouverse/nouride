/**
 * What an agent a coding CLI runs is told of what runs it: the CLI's own version and its connector's, read from the
 * files installed, and how that is updated. Asked "can you update Claude Code here", one read the version of another
 * copy of the CLI on its PATH, named that, and proposed the CLI's own updater, which changes nothing an agent runs on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partsNamed, type CliPart, type CliRow } from "@nouride/acp";
import type { runCommand } from "@nouride/runtime";
import type { CliConnection } from "@/modules/external-agents/connection.ts";
import { whatRuns, writeInstruction } from "@/modules/external-agents/instruction.ts";
import { KeptParts } from "@/modules/external-agents/parts.ts";
import { fakeAgent } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const parts = (own: string, connector: string): CliPart[] => [
  { kind: "cli", name: "Claude Code", package: "@anthropic-ai/claude-agent-sdk", version: own },
  { kind: "connector", name: "@agentclientprotocol/claude-agent-acp", package: "@agentclientprotocol/claude-agent-acp", version: connector },
  { kind: "runtime", name: "Node.js", version: "24.15.0", needs: ">=22", tooOld: false },
];
const connection = (read?: CliPart[]) => ({ row: { id: "claude-code", name: "Claude Code", instructionFile: "CLAUDE.md" }, launch: {}, ...(read ? { parts: Promise.resolve(read) } : { parts: Promise.resolve([]) }) }) as unknown as CliConnection;

async function written(read?: CliPart[]): Promise<{ text: string; fingerprint: string }> {
  const folder = mkdtempSync(join(tmpdir(), "what-runs-"));
  dirs.push(folder);
  const fingerprint = await writeInstruction(fakeAgent(), connection(read), folder);
  return { text: readFileSync(join(folder, "CLAUDE.md"), "utf8"), fingerprint };
}

const LINE =
  "What runs you: Claude Code 2.1.323, in claude-agent-acp 0.107.0, read from the files installed. It is updated for every agent on it at once with `nouride agents update claude-code`, " +
  "which the orchestrator runs on a person's word: ask it with `ask_agent`, or tell the person to. Its own updater, and any other copy of it on your PATH, change nothing that runs you. " +
  "Whether a newer version is out is the orchestrator's `nouride agents scan` to say.";

describe("what an agent is told runs it", () => {
  test("the words: the CLI's own version in its connector, who updates it and with what, and what does not", () => {
    expect(partsNamed(parts("2.1.323", "0.107.0"))).toBe("Claude Code 2.1.323, in claude-agent-acp 0.107.0");
    expect(whatRuns("Claude Code 2.1.323, in claude-agent-acp 0.107.0", "claude-code")).toBe(LINE);
  });

  test("in Nouride's block of the CLI's instruction file, once, before the agent's own files", async () => {
    const { text } = await written(parts("2.1.323", "0.107.0"));
    expect(text.split(LINE)).toHaveLength(2);
    expect(text.indexOf(LINE)).toBeGreaterThan(text.indexOf("<!-- nouride:begin"));
    expect(text.indexOf(LINE)).toBeLessThan(text.indexOf("<!-- nouride:end -->"));
  });

  test("nothing where the files said nothing: no version is made up, and the connector's is never called the CLI's", async () => {
    expect((await written()).text).not.toContain("What runs you");
    expect((await written([{ kind: "connector", name: "x-acp", package: "x-acp", version: "1.2.3" }])).text).toContain("What runs you: x-acp 1.2.3, read from the files installed.");
    // The CLI's own version not read: said as that, with the connector's still its connector's.
    expect((await written([{ kind: "cli", name: "Claude Code" }, { kind: "connector", name: "x-acp", package: "x-acp", version: "1.2.3" }])).text).toContain("What runs you: Claude Code (version not read), in x-acp 1.2.3,");
  });

  test("an update changes the file and not what a session is compared by: no conversation loses its session to it", async () => {
    const before = await written(parts("2.1.316", "0.100.0"));
    const after = await written(parts("2.1.323", "0.107.0"));
    expect(before.text).toContain("Claude Code 2.1.316, in claude-agent-acp 0.100.0");
    expect(after.text).toContain("Claude Code 2.1.323, in claude-agent-acp 0.107.0");
    expect(after.fingerprint).toBe(before.fingerprint);
    expect((await written()).fingerprint).toBe(before.fingerprint);
  });
});

describe("the parts kept as a CLI starts", () => {
  const row = { id: "claude-code", name: "Claude Code", command: "no-such-acp-anywhere", args: [], install: "", package: "@x/acp", versionArgs: ["--version"], instructionFile: "CLAUDE.md" } as CliRow;
  const never = (async () => {
    throw new Error("nothing is run for a command that is not there");
  }) as unknown as typeof runCommand;

  test("read once per CLI: a second agent's start is handed what the first read", async () => {
    const kept = new KeptParts();
    kept.note([{ id: "claude-code", parts: parts("2.1.323", "0.107.0") }]);
    expect(await kept.started(row, {}, never)).toEqual(parts("2.1.323", "0.107.0"));
    expect(kept.ownVersion("claude-code")).toBe("2.1.323");
  });

  test("a CLI whose files are not found has none, and its start goes on", async () => {
    const kept = new KeptParts();
    expect(await kept.started(row, { PATH: "/nonexistent" }, never)).toEqual([]);
    expect(kept.ownVersion("claude-code")).toBeUndefined();
  });

  test("a read that fails is no parts, never a rejection nobody is waiting for", async () => {
    // The start does not wait for it: a rejection here would be the daemon's uncaught one.
    const failing = (async () => {
      throw new Error("the disk went away");
    }) as never;
    expect(await new KeptParts().started(row, {}, never, failing)).toEqual([]);
  });
});
