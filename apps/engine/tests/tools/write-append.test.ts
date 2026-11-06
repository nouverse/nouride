/**
 * `write` with `append: true` — a large file in parts (2026-10-21). A whole document in one call's arguments ran into
 * the reply's output limit and arrived cut, three times; the way round it was a shell heredoc. Appending is the same
 * tool behind the same gate and the same root and path guards, and it replaces nothing, so it needs no read first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { removePath } from "@nouride/runtime";
import { toUserMessage, type ToolContext } from "@nouride/shared";
import { writeTool } from "@/modules/tools/builtins/files.ts";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import { fakeAgent, tempDir } from "../helpers.ts";

let root: string;
let outside: string;

beforeEach(() => {
  root = tempDir("append");
  outside = tempDir("append-outside");
});

afterEach(() => {
  removePath(root);
  removePath(outside);
});

function ctx(): ToolContext {
  return {
    agentId: `append-${Math.random()}`,
    sessionId: "s",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "dev",
    workspaceDir: root,
    agentDir: root,
    workspaceRoots: [root],
    signal: new AbortController().signal,
  } as ToolContext;
}

describe("write with append", () => {
  test("the first part creates the file, each next part goes on the end", async () => {
    const agent = ctx();
    expect((await writeTool.execute({ path: "report.md", content: "# Part one\n" }, agent)).isError).toBe(false);
    const second = await writeTool.execute({ path: "report.md", content: "## Part two\n", append: true }, agent);
    const third = await writeTool.execute({ path: "report.md", content: "## Part three\n", append: true }, agent);
    expect(second).toMatchObject({ isError: false, content: expect.stringContaining("Appended to report.md (+12 chars, 23 in all)") });
    expect(third.isError).toBe(false);
    expect(readFileSync(join(root, "report.md"), "utf8")).toBe("# Part one\n## Part two\n## Part three\n");
  });

  test("a file that is not there yet is created by the append", async () => {
    const result = await writeTool.execute({ path: "notes/new.md", content: "first", append: true }, ctx());
    expect(result).toMatchObject({ isError: false, content: expect.stringContaining("Created new.md") });
    expect(readFileSync(join(root, "notes", "new.md"), "utf8")).toBe("first");
  });

  test("appending to a file nobody read is allowed — it replaces nothing — while overwriting it still is not", async () => {
    writeFileSync(join(root, "log.md"), "kept\n");
    expect((await writeTool.execute({ path: "log.md", content: "added\n", append: true }, ctx())).isError).toBe(false);
    expect(readFileSync(join(root, "log.md"), "utf8")).toBe("kept\nadded\n");
    expect((await writeTool.execute({ path: "log.md", content: "wiped" }, ctx())).isError).toBe(true);
  });

  test("the workspace boundary holds for an append as for a write", async () => {
    const target = join(outside, "planted.md");
    writeFileSync(target, "outside\n");
    const refused = await writeTool.execute({ path: target, content: "nope", append: true }, ctx()).catch((err: unknown) => ({ content: toUserMessage(err), isError: true }));
    expect(refused.isError).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("outside\n");
  });

  test("the tool says to use it for content too large for one call", () => {
    expect(writeTool.definition.description).toContain("For content too large for one call, write the first part, then call again with append: true");
    expect(Object.keys(writeTool.definition.parameters.properties as object)).toContain("append");
  });
});

describe("the prompt says it too", () => {
  const prompt = (tools: string[]) =>
    buildSystemPrompt({
      agent: fakeAgent(),
      tools: tools.map((name) => ({ name, description: name, parameters: {} })),
      harness: { approvalRequired: [], approvalAvailable: true, maxToolIterations: 25, commands: [], truncates: false, workspace: { dir: "/w", roots: ["/w"] } },
      gateway: "telegram",
      chatId: "1",
      chatType: "dm",
      sessionId: "s",
      timezone: "UTC",
      now: new Date("2026-10-21T00:00:00Z"),
    } as never).text;

  test("an agent that can write is told to send long content in parts, never one giant call", () => {
    expect(prompt(["write"])).toContain(
      "- Content longer than a few thousand words goes out in parts: the first `write`, then `write` with `append: true` for each next part. Never one giant call: your reply's output limit would cut it off.",
    );
    expect(prompt(["read"])).not.toContain("append: true");
  });
});
