/**
 * A tool result cleared from the context is moved out, not lost (0.7.25).
 *
 * Live: in one long conversation 107 results were replaced by "read it again", often for the call just made; the
 * agent re-ran commands, and what a command that changed something had printed was gone. Now the whole content is
 * written to the conversation's spill directory first, and the marker says where.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, readTextFileIfExists, removePath } from "@nouride/runtime";
import type { ChatMessage } from "@nouride/shared";
import { isTrimmedToolResult, pruneToolOutputs, trimToolResults, TRIMMED_TOOL_PREFIX } from "@/modules/llm/context.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { renderLimits } from "@/modules/llm/prompt/harness-limits.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";

let dir: string;
let root: string;
let spill: ToolOutputSpill;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-cleared-"));
  root = join(dir, "tool-output");
  spill = new ToolOutputSpill(root);
});

afterEach(() => removePath(dir));

const big = (tag: string) => `${tag}\n${Array.from({ length: 300 }, (_, i) => `${tag} line ${i} ${"x".repeat(30)}`).join("\n")}`;

function exchange(id: string, content: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "exec", arguments: { command: "x" } }] },
    { role: "tool", content, toolCallId: id },
  ];
}

const conversation = (): ChatMessage[] => [{ role: "user", content: "go" }, ...exchange("c1", big("FIRST")), ...exchange("c2", big("SECOND"))];
const scope = { agentId: "nouva", sessionId: "s1" };
const KEPT = /kept at (\S+?); read it with `read` \(offset\/limit\) instead of re-running the command\]$/;

describe("trimming inside a turn", () => {
  test("the cleared result is in a file named by its call id, whole, and the marker says where", async () => {
    const result = trimToolResults(conversation(), { maxTokens: 10, keepRecent: 1, keep: spill.keeperFor(scope) });
    const first = result.messages.find((m) => m.toolCallId === "c1")!;
    const text = String(first.content);

    expect(text).toStartWith("[earlier tool output moved out of context to make room: 301 lines, ~");
    expect(text).not.toContain("re-run a read-only command");
    const path = KEPT.exec(text)?.[1];
    expect(path).toBeDefined();
    expect(path!.startsWith(spill.rootFor(scope) + "/")).toBe(true);
    expect(path!.split("/").at(-1)).toStartWith("cleared-c1-");
    expect(await readTextFileIfExists(path!)).toBe(big("FIRST"));
    // Still recognised as cleared, so nothing clears it twice.
    expect(isTrimmedToolResult(first)).toBe(true);
  });

  test("with no store, the old marker — nothing claims a file that does not exist", () => {
    const result = trimToolResults(conversation(), { maxTokens: 10, keepRecent: 1 });
    expect(String(result.messages.find((m) => m.toolCallId === "c1")!.content)).toStartWith(TRIMMED_TOOL_PREFIX);
  });

  test("the same result cleared twice, in two turns' worth of history, is one file", () => {
    trimToolResults(conversation(), { maxTokens: 10, keepRecent: 1, keep: spill.keeperFor(scope) });
    trimToolResults(conversation(), { maxTokens: 10, keepRecent: 1, keep: spill.keeperFor(scope) });
    expect(listDir(spill.rootFor(scope)).filter((entry) => entry.name.startsWith("cleared-c1-"))).toHaveLength(1);
  });

  test("two turns' `call_0` with different output are two files, never one over the other", () => {
    expect(spill.keepCleared({ ...scope, callId: "call_0" }, big("A"))!.path).not.toBe(spill.keepCleared({ ...scope, callId: "call_0" }, big("B"))!.path);
  });
});

describe("a result that was spilled already", () => {
  test("points at the file it was spilled to, and writes nothing more", async () => {
    const whole = big("HUGE").repeat(20);
    const spilled = await spill.keep({ ...scope, callId: "c9", toolName: "exec", content: whole, maxTokens: 200 });
    expect(spilled.path).not.toBeNull();

    const kept = spill.keepCleared({ ...scope, callId: "c9" }, spilled.content);
    expect(kept?.path).toBe(spilled.path!);
    // The whole output's size, from the excerpt's header — not the excerpt's own.
    expect(kept?.lines).toBe(whole.split("\n").length);
    expect(listDir(spill.rootFor(scope)).map((entry) => entry.name)).toEqual(["c9.txt"]);
  });

  test("an excerpt headed as 0.8.15 and older wrote it, with a dash, still points at its file", async () => {
    // A conversation stored before the upgrade keeps the old header; read wrongly, its excerpt is kept a second time.
    const whole = big("OLDER").repeat(20);
    const spilled = await spill.keep({ ...scope, callId: "c7", toolName: "exec", content: whole, maxTokens: 200 });
    expect(spilled.content).toStartWith("[output too large for the context: ");
    const older = spilled.content.replace("[output too large for the context: ", "[output too large for the context — ");

    const kept = spill.keepCleared({ ...scope, callId: "c7" }, older);
    expect(kept?.path).toBe(spilled.path!);
    expect(kept?.lines).toBe(whole.split("\n").length);
    expect(listDir(spill.rootFor(scope)).map((entry) => entry.name)).toEqual(["c7.txt"]);
  });

  test("an excerpt naming a file outside the store is not trusted — the content is kept as it is", async () => {
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "not ours");
    const forged = `[output too large for the context — 9 lines, ~1KB. The first 1 and last 1 lines are below; 7 in the middle are not.]\nFull output: ${outside}\n`;
    const kept = spill.keepCleared({ ...scope, callId: "c8" }, forged);
    expect(kept?.path).not.toBe(outside);
    expect(await readTextFileIfExists(kept!.path)).toBe(forged);
  });
});

describe("when the file cannot be written", () => {
  test("the old marker is used, and nothing throws", () => {
    // The agent's directory is a file: nothing can be created under it.
    writeFileSync(join(root, "nouva"), "in the way");
    const result = trimToolResults(conversation(), { maxTokens: 10, keepRecent: 1, keep: spill.keeperFor(scope) });
    expect(String(result.messages.find((m) => m.toolCallId === "c1")!.content)).toStartWith(TRIMMED_TOOL_PREFIX);
  });
});

describe("the cheap pass between turns", () => {
  test("keeps what it clears, and writes nothing when the prune does not happen", async () => {
    const messages = conversation();
    const skipped = pruneToolOutputs(messages, { protectTokens: 0, minSavingsTokens: 1_000_000, keep: spill.keeperFor(scope) });
    expect(skipped.pruned).toBe(0);
    expect(listDir(spill.rootFor(scope))).toEqual([]);

    const pruned = pruneToolOutputs(messages, { protectTokens: 0, minSavingsTokens: 1, keep: spill.keeperFor(scope) });
    expect(pruned.pruned).toBe(2);
    const path = KEPT.exec(String(pruned.messages.find((m) => m.toolCallId === "c2")!.content))?.[1];
    expect(await readTextFileIfExists(path!)).toBe(big("SECOND"));
  });
});

describe("the prompt says the same as the marker", () => {
  test("open the named file with `read`; re-run nothing to see output again", () => {
    const view = { ctx: { harness: {} }, toolNames: ["exec", "read"], gated: [], free: ["exec", "read"] } as unknown as HarnessView;
    const out = renderLimits(view).join("\n");
    expect(out).toContain("Older tool results are also moved out of the context when a turn runs long");
    expect(out).toContain("The marker names a file that holds it whole: open that with `read` (offset/limit), and never re-run a command to see its output again.");
    // The old remedy survives only for the marker that names no file.
    expect(out).toContain("A marker that names no file means it could not be kept: re-read the file or re-run a read-only command, never one that changed something.");
  });
});
