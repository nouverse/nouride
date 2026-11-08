/**
 * `glob`, `grep`, and the read-before-overwrite guard.
 *
 * The discovery gap was observed, not assumed. Asked to look at what was in its workspace, an agent
 * with `read` and nothing else answered that it had no way to enumerate paths. It was right — `read`
 * needs a path and nothing could produce one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {writeFileSync } from "node:fs";
import { ensureDir, removePath } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { globTool, grepTool } from "@/modules/tools/builtins/search.ts";
import { writeTool, createReadTool } from "@/modules/tools/builtins/files.ts";
import { tempDir } from "../helpers.ts";

const readTool = createReadTool();

let root: string;
let outside: string;

beforeEach(() => {
  root = tempDir("search");
  outside = tempDir("outside");

  ensureDir(join(root, "src", "lib"));
  ensureDir(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "# Project\nTODO: write docs\n");
  writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n// TODO: refactor\n");
  writeFileSync(join(root, "src", "lib", "util.ts"), "export function helper() {}\n");
  writeFileSync(join(root, "docs", "guide.md"), "Read the guide.\nTODO: expand\n");
  writeFileSync(join(outside, "secret.md"), "TODO: this must never be found\n");
});

afterEach(() => {
  removePath(root);
  removePath(outside);
});

function ctx(agentId = "nouva"): ToolContext {
  return {
    agentId,
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

describe("glob", () => {
  test("finds files by extension across subdirectories", async () => {
    const result = await globTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("index.ts");
    expect(result.content).toContain("util.ts");
    expect(result.content).not.toContain("README.md");
  });

  test("returns absolute paths, so read accepts them directly", async () => {
    // The point of the tool: its output has to be usable as `read`'s input without the model
    // reconstructing a path from a relative fragment.
    const result = await globTool.execute({ pattern: "README.md" }, ctx());
    const path = (result.content.split("\n")[1] ?? "").trim();
    expect(path.startsWith(root)).toBe(true);
    expect((await readTool.execute({ path }, ctx())).isError).toBe(false);
  });

  test("a pattern matching nothing says where it looked", async () => {
    // The usual cause is a pattern anchored at the wrong level, and naming the roots turns a dead end
    // into a next step.
    const result = await globTool.execute({ pattern: "**/*.rs" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No files matched");
    expect(result.content).toContain(root);
  });

  test("cannot be aimed outside the workspace", async () => {
    const result = await globTool.execute({ pattern: "*.md", path: outside }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the directories you may use/);
  });

  test("a traversal in path is refused after resolution, not before", async () => {
    // `resolveWithin` resolves first and compares afterwards, so `../` cannot be spelled around.
    const result = await globTool.execute({ pattern: "*", path: join(root, "..", "..") }, ctx());
    expect(result.isError).toBe(true);
  });

  test("an empty pattern is refused", async () => {
    expect((await globTool.execute({ pattern: "  " }, ctx())).isError).toBe(true);
  });
});

describe("grep", () => {
  test("finds a string with file and line number", async () => {
    const result = await grepTool.execute({ pattern: "TODO" }, ctx());
    expect(result.isError).toBe(false);
    // File and line are the useful part — enough to go straight to `read` with an offset.
    expect(result.content).toMatch(/README\.md:2/);
    expect(result.content).toMatch(/index\.ts:2/);
  });

  test("is case-insensitive by default and exact when asked", async () => {
    expect((await grepTool.execute({ pattern: "todo" }, ctx())).content).toMatch(/TODO/);
    const exact = await grepTool.execute({ pattern: "todo", case_sensitive: true }, ctx());
    expect(exact.content).toContain("No matches");
  });

  test("a glob narrows which files are searched", async () => {
    const result = await grepTool.execute({ pattern: "TODO", glob: "**/*.md" }, ctx());
    expect(result.content).toContain("README.md");
    expect(result.content).not.toContain("index.ts");
  });

  test("never reaches outside the workspace", async () => {
    // The file in `outside` contains the same pattern, so a leak here would show up as a match.
    const result = await grepTool.execute({ pattern: "must never be found" }, ctx());
    expect(result.content).toContain("No matches");
  });

  test("an invalid regex is a result, not a throw", async () => {
    // The model wrote the pattern and can fix it; the engine's own message says what is wrong.
    const result = await grepTool.execute({ pattern: "[unclosed" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a valid regular expression/);
  });

  test("skips a file too large to be source", async () => {
    // A match at byte 900,000 of a minified bundle is not what anyone asked for, and reading it costs
    // the whole file.
    writeFileSync(join(root, "bundle.js"), `${"x".repeat(600 * 1024)}\nTODO in a bundle\n`);
    const result = await grepTool.execute({ pattern: "TODO in a bundle" }, ctx());
    expect(result.content).toContain("No matches");
  });

  test("a binary file does not break the search", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 255, 254]));
    const result = await grepTool.execute({ pattern: "TODO" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/README\.md/);
  });

  test("clips a very long matching line instead of dropping it", async () => {
    writeFileSync(join(root, "long.md"), `TODO ${"y".repeat(5000)}\n`);
    const result = await grepTool.execute({ pattern: "TODO", glob: "long.md" }, ctx());
    expect(result.content).toContain("long.md:1");
    expect(result.content.length).toBeLessThan(1000);
  });
});

describe("write refuses to overwrite a file nobody read", () => {
  /**
   * `edit` needs no equivalent guard: a wrong `old_string` simply does not match and nothing happens.
   * `write` replaces the whole file, so an agent working from a half-remembered version can obliterate
   * one in a single call, and the only record is the audit log. Claude Code enforces the same rule.
   */
  test("creating a new file is allowed", async () => {
    const result = await writeTool.execute({ path: "new.md", content: "hello" }, ctx());
    expect(result.isError).toBe(false);
  });

  test("overwriting an unread file is refused, and says what to do", async () => {
    const result = await writeTool.execute({ path: "README.md", content: "wiped" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/have not read it/);
    expect(result.content).toMatch(/[Uu]se edit/);
    // And the file is untouched.
    expect((await readTool.execute({ path: "README.md" }, ctx())).content).toContain("# Project");
  });

  test("overwriting is allowed once it has been read", async () => {
    const agent = ctx();
    await readTool.execute({ path: "README.md" }, agent);
    expect((await writeTool.execute({ path: "README.md", content: "replaced" }, agent)).isError).toBe(
      false,
    );
  });

  test("a partial read counts", async () => {
    // An agent that has seen part of a file knows it is replacing something, which is the judgement
    // this guard protects.
    const agent = ctx();
    await readTool.execute({ path: "README.md", offset: 1, limit: 1 }, agent);
    expect((await writeTool.execute({ path: "README.md", content: "x" }, agent)).isError).toBe(false);
  });

  test("one agent reading does not entitle another to overwrite", async () => {
    // Two agents can share a workspace root, and what one agent has seen says nothing about the
    // other's context.
    await readTool.execute({ path: "README.md" }, ctx("nouva"));
    const result = await writeTool.execute({ path: "README.md", content: "x" }, ctx("nox"));
    expect(result.isError).toBe(true);
  });

  test("a file this agent just wrote can be written again", async () => {
    const agent = ctx();
    await writeTool.execute({ path: "fresh.md", content: "one" }, agent);
    expect((await writeTool.execute({ path: "fresh.md", content: "two" }, agent)).isError).toBe(false);
  });
});

describe("a workspace root that does not exist", () => {
  /**
   * Found live, and it took both search tools down at once: the per-conversation attachment root is a
   * workspace root from the first turn, but nothing creates the directory until a file is actually
   * stored. `Bun.Glob.scan` threw ENOENT on it and the agent told the user to run `grep` themselves.
   *
   * A directory that is not there has no matches. That is the answer, not a failure — and it also
   * covers a root deleted while a turn is running.
   */
  function ctxWithGhostRoot(): ToolContext {
    return { ...ctx(), workspaceRoots: [root, join(root, "never-created")] } as ToolContext;
  }

  test("glob still returns matches from the roots that do exist", async () => {
    const result = await globTool.execute({ pattern: "**/*.ts" }, ctxWithGhostRoot());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("index.ts");
  });

  test("grep still searches the roots that do exist", async () => {
    const result = await grepTool.execute({ pattern: "TODO" }, ctxWithGhostRoot());
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/README\.md/);
  });

  test("a missing root alone yields no matches rather than an error", async () => {
    const only = { ...ctx(), workspaceRoots: [join(root, "never-created")] } as ToolContext;
    const result = await globTool.execute({ pattern: "**/*" }, only);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No files matched");
  });
});

/**
 * Several patterns in one call.
 *
 * The reason is the measured one — a median of 1.00 tool calls per model round trip, and every round
 * trip re-sends the whole conversation — plus something `read`'s `paths` does not buy: the files are
 * read **once** for every pattern. Three symbols across a tree used to be three full passes.
 */
describe("grep with several patterns", () => {
  test("finds all of them in one pass, labelled by which matched", async () => {
    writeFileSync(join(root, "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
    writeFileSync(join(root, "b.ts"), "const gamma = 3;\n");

    const result = await grepTool.execute({ patterns: ["alpha", "gamma"] }, ctx());

    expect(result.isError).toBe(false);
    // The label is what makes a combined result readable: without it the model cannot tell which of
    // its questions a line answers.
    expect(result.content).toContain("[alpha] a.ts:1");
    expect(result.content).toContain("[gamma] b.ts:1");
    expect(result.metadata).toMatchObject({ matches: 2 });
  });

  test("says which patterns found nothing", async () => {
    // The information a model would otherwise spend a round trip discovering. With one list of
    // matches, "my pattern is wrong" and "my pattern has no matches" look identical.
    writeFileSync(join(root, "a.ts"), "const alpha = 1;\n");

    const result = await grepTool.execute({ patterns: ["alpha", "nowhere", "absent"] }, ctx());

    expect(result.content).toContain("no matches at all for");
    expect(result.content).toContain("`nowhere`");
    expect(result.content).toContain("`absent`");
    expect(result.metadata).toMatchObject({ withoutMatches: ["nowhere", "absent"] });
  });

  test("a line matching two patterns is reported once", async () => {
    // The match budget is shared, and a duplicate spends it on nothing.
    writeFileSync(join(root, "a.ts"), "const alphabet = 1;\n");

    const result = await grepTool.execute({ patterns: ["alpha", "bet"] }, ctx());
    expect(result.metadata).toMatchObject({ matches: 1 });
  });

  test("one invalid pattern is named, not blamed on the batch", async () => {
    const result = await grepTool.execute({ patterns: ["fine", "([unclosed"] }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("([unclosed");
  });

  test("more patterns than the cap is refused with the number", async () => {
    const result = await grepTool.execute({ patterns: ["a", "b", "c", "d", "e", "f"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("the limit is 5");
  });

  test("neither pattern nor patterns", async () => {
    const result = await grepTool.execute({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("`patterns` for several");
  });

  test("a single pattern still reads exactly as it did, with no label", async () => {
    writeFileSync(join(root, "a.ts"), "const alpha = 1;\n");

    const result = await grepTool.execute({ pattern: "alpha" }, ctx());
    expect(result.content).toContain("a.ts:1");
    expect(result.content).not.toContain("[alpha]");
  });
});
