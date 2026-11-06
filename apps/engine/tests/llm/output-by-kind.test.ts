/**
 * A tool result made smaller by what its text is (TOKEN_SAVINGS §3.3, 0.8.17): colour codes out, a redrawn line at its
 * last state, a run of identical lines counted, JSON without its spaces. Diffs, source code and a file read exactly are
 * left as they are, and a result made smaller names the file that keeps its whole text.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFileIfExists, removePath } from "@nouride/runtime";
import { compactByKind, compactResult } from "@/modules/llm/output-by-kind.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { createReadTool, writeTool } from "@/modules/tools/builtins/files.ts";
import { createMemoryReadTool } from "@/modules/tools/builtins/memory.ts";

const ESC = String.fromCharCode(27);

describe("each kind", () => {
  test("colour and cursor codes are taken out, the words kept", () => {
    const coloured = `${ESC}[1;32m✓${ESC}[0m 12 passed ${ESC}[2K${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\ done`;
    expect(compactByKind(coloured)).toEqual({ text: "✓ 12 passed link done", kinds: ["colour codes taken out"] });
  });

  test("a line redrawn with carriage returns keeps its last state; a line ending \\r\\n is a line", () => {
    const bar = "Downloading  10%\rDownloading  55%\rDownloading 100%\nunpacked";
    expect(compactByKind(bar)).toEqual({ text: "Downloading 100%\nunpacked", kinds: ["redrawn lines kept at their last state"] });
    expect(compactByKind("one\r\ntwo\r\n")).toEqual({ text: "one\r\ntwo\r\n", kinds: [] });
  });

  test("three or more identical lines become one, counted; two, and blank lines, stay", () => {
    const log = ["start", "warn: retrying", "warn: retrying", "warn: retrying", "warn: retrying", "end", "a", "a", "", "", "", "z"].join("\n");
    expect(compactByKind(log)).toEqual({
      text: ["start", "warn: retrying [× 4]", "end", "a", "a", "", "", "", "z"].join("\n"),
      kinds: ["repeated lines counted"],
    });
  });

  test("JSON loses the spaces between its tokens, never inside a string, and its numbers are kept as written", () => {
    const pretty = '{\n  "id": 12345678901234567890,\n  "price": 1.50,\n  "name": "two  spaces \\" here",\n  "tags": [\n    "a",\n    "b"\n  ]\n}\n';
    expect(compactByKind(pretty)).toEqual({
      text: '{"id":12345678901234567890,"price":1.50,"name":"two  spaces \\" here","tags":["a","b"]}',
      kinds: ["JSON without its spaces"],
    });
    expect(compactByKind('{"already":"tight"}').kinds).toEqual([]);
    expect(compactByKind("{ not json, just braces }").kinds).toEqual([]);
  });

  test("kinds add up: a coloured progress bar over repeated lines", () => {
    const out = `${ESC}[33m50%${ESC}[0m\r${ESC}[33m100%${ESC}[0m\nok\nok\nok`;
    expect(compactByKind(out)).toEqual({
      text: "100%\nok [× 3]",
      kinds: ["colour codes taken out", "redrawn lines kept at their last state", "repeated lines counted"],
    });
  });
});

describe("what stays as it is", () => {
  test("a diff keeps its repeated lines: they are lines of the file", () => {
    const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,6 @@", "+}", "+}", "+}", " end"].join("\n");
    expect(compactByKind(diff)).toEqual({ text: diff, kinds: [] });
  });

  test("source code, blank lines and closing braces included, is untouched", () => {
    const source = ["export function f() {", "  if (a) {", "    return 1;", "  }", "", "", "  return 2;", "}", ""].join("\n");
    expect(compactByKind(source)).toEqual({ text: source, kinds: [] });
  });
});

test("the tools that hand back a file's lines keep them exactly; one that writes is not among them", () => {
  expect(createReadTool().verbatim).toBe(true);
  expect(createMemoryReadTool().verbatim).toBe(true);
  expect(writeTool.verbatim).toBeUndefined();
});

describe("a tool's result", () => {
  let dir: string;
  let spill: ToolOutputSpill;
  const scope = { agentId: "nouva", sessionId: "s1", callId: "call_7" };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nouride-by-kind-"));
    spill = new ToolOutputSpill(join(dir, "tool-output"));
  });
  afterEach(() => removePath(dir));
  const keep = (content: string) => spill.keepCleared(scope, content);
  const noisy = Array.from({ length: 80 }, () => `${ESC}[2mcompiling module…${ESC}[0m`).join("\n");

  test("made smaller ends with one line naming the file that keeps the whole output, which holds it exactly", async () => {
    const out = compactResult({ content: noisy, isError: false }, {}, keep);
    const lastLine = out.content.split("\n").at(-1)!;
    expect(out.content.startsWith("compiling module… [× 80]\n")).toBe(true);
    expect(lastLine).toMatch(/^\[made smaller for the context \(colour codes taken out; repeated lines counted\): \d+ characters fewer\. The whole output: (.+)\]$/);
    const path = /The whole output: (.+)\]$/.exec(lastLine)![1]!;
    expect(out.metadata?.compactedFrom).toBe(path);
    expect(await readTextFileIfExists(path)).toBe(noisy);
  });

  test("a tool whose output is kept exactly, an output already on disk, or too little saved: as it was", () => {
    const result = { content: noisy, isError: false };
    expect(compactResult(result, { verbatim: true }, keep)).toBe(result);
    const spooled = { content: noisy, isError: false, spooled: { path: "/x", chars: 1, lines: 1 } };
    expect(compactResult(spooled, {}, keep)).toBe(spooled);
    const small = { content: `${ESC}[32mok${ESC}[0m`, isError: false };
    expect(compactResult(small, {}, keep)).toBe(small);
  });

  test("without the whole text on disk, nothing is taken out", () => {
    const result = { content: noisy, isError: true };
    expect(compactResult(result, {}, () => null)).toBe(result);
  });
});
