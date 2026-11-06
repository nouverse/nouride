/**
 * Several replacements in one file, all or nothing.
 *
 * The properties that a sequence of `edit` calls cannot have: one approval instead of six, a failure
 * that leaves the file untouched instead of half-changed, and one lock instead of six with gaps
 * between them. The tests are mostly about the middle one, because a half-applied refactor is a saved
 * file that no longer parses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTextFile, writeTextFileAtomic } from "@nouride/runtime";
import { toUserMessage, type ToolContext } from "@nouride/shared";
import { multiEditTool } from "@/modules/tools/builtins/files.ts";

let dir: string;
let file: string;

const ORIGINAL = ["const a = 1;", "const b = 2;", "const c = 3;", "// a marker", ""].join("\n");

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-multiedit-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  file = join(dir, "code.ts");
  await writeTextFileAtomic(file, ORIGINAL);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    agentId: "nouva",
    sessionId: "s",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u",
    workspaceDir: dir,
    agentDir: dir,
    workspaceRoots: [dir],
    signal: new AbortController().signal,
  } as ToolContext;
}

const run = (args: Record<string, unknown>) =>
  multiEditTool
    .execute(args, ctx())
    .catch((err: unknown) => ({ content: toUserMessage(err), isError: true, metadata: undefined }));

describe("multi_edit", () => {
  test("applies every edit in one write", async () => {
    const result = await run({
      path: file,
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "const c = 3;", new_string: "const c = 30;" },
      ],
    });

    expect(result.isError).toBe(false);
    const text = await readTextFile(file);
    expect(text).toContain("const a = 10;");
    expect(text).toContain("const c = 30;");
    expect(text).toContain("const b = 2;");
  });

  test("edits see the result of the ones before them", async () => {
    // What makes this more than a loop: a later edit can depend on an earlier one having happened.
    const result = await run({
      path: file,
      edits: [
        { old_string: "const a = 1;", new_string: "const alpha = 1;" },
        { old_string: "const alpha = 1;", new_string: "const alpha = 99;" },
      ],
    });

    expect(result.isError).toBe(false);
    expect(await readTextFile(file)).toContain("const alpha = 99;");
  });

  test("a failure halfway through writes nothing at all", async () => {
    // The property that matters most. Six `edit` calls that fail on the fourth leave a saved file that
    // may no longer parse; here the file is exactly as it was.
    const result = await run({
      path: file,
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "not in the file", new_string: "x" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Nothing was written");
    expect(await readTextFile(file)).toBe(ORIGINAL);
  });

  test("says which edit failed, and of how many", async () => {
    // "old_string was not found" is unhelpful when six were sent.
    const result = await run({
      path: file,
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "const b = 2;", new_string: "const b = 20;" },
        { old_string: "missing", new_string: "x" },
      ],
    });
    expect(result.content).toContain("Edit 3 of 3");
  });

  test("an ambiguous edit is refused rather than guessed", async () => {
    await writeTextFileAtomic(file, "x\nx\n");
    const result = await run({ path: file, edits: [{ old_string: "x", new_string: "y" }] });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("appears 2 times");
    expect(await readTextFile(file)).toBe("x\nx\n");
  });

  test("replace_all is per edit", async () => {
    await writeTextFileAtomic(file, "x\nx\nkeep\n");
    const result = await run({
      path: file,
      edits: [{ old_string: "x", new_string: "y", replace_all: true }],
    });

    expect(result.isError).toBe(false);
    expect(await readTextFile(file)).toBe("y\ny\nkeep\n");
  });

  test("occurrences are counted against the text as edited so far", async () => {
    // The count an earlier edit leaves behind is the one the next edit has to reason about — not the
    // count in the original file.
    await writeTextFileAtomic(file, "a\nb\n");
    const result = await run({
      path: file,
      edits: [
        { old_string: "b", new_string: "a" },
        // There are now two `a`s, so this must be refused rather than silently hitting the first.
        { old_string: "a", new_string: "c" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Edit 2 of 2");
    expect(await readTextFile(file)).toBe("a\nb\n");
  });

  test("edits that change nothing are refused", async () => {
    expect(await run({ path: file, edits: [] })).toMatchObject({ isError: true });
    expect(
      await run({ path: file, edits: [{ old_string: "same", new_string: "same" }] }),
    ).toMatchObject({ isError: true });
  });

  test("a missing file is reported, not created", async () => {
    const result = await run({
      path: join(dir, "absent.ts"),
      edits: [{ old_string: "a", new_string: "b" }],
    });
    expect(result.isError).toBe(true);
  });

  test("the workspace boundary still applies", async () => {
    const result = await run({
      path: "/etc/hosts",
      edits: [{ old_string: "localhost", new_string: "nope" }],
    });
    expect(result.isError).toBe(true);
  });

  test("a malformed edit list is refused by position", async () => {
    expect(await run({ path: file, edits: "nope" })).toMatchObject({ isError: true });
    expect(await run({ path: file, edits: [{ old_string: 1, new_string: "x" }] })).toMatchObject({
      isError: true,
    });
    expect(
      await run({ path: file, edits: Array.from({ length: 51 }, () => ({ old_string: "a", new_string: "b" })) }),
    ).toMatchObject({ isError: true });
  });
});
