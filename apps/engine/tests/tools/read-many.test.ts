/**
 * Reading several files in one call.
 *
 * This parameter exists because of a measurement, not a preference. On a live daemon the median turn
 * asked for **1.00 tool calls per model round trip**, and the one turn that batched five reads into a
 * single message cost 63k input tokens where the same five calls, one at a time, cost 151k and took
 * 2.4x as long. The executor could already run parallel-safe calls together; what it could not do was
 * make the model *ask* that way. An array parameter is a shape a model reaches for.
 *
 * So what is tested here is mostly what happens when a batch goes partly wrong — because a batch that
 * fails as a whole sends the model straight back to calling once per file, which is the behaviour this
 * was built to end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, writeTextFile } from "@nouride/runtime";
import { createReadTool } from "@/modules/tools/builtins/files.ts";
import { tempDir } from "../helpers.ts";
import type { ToolContext } from "@nouride/shared";

const readTool = createReadTool();

let dir: string;
const read = readTool;

const ctx = (): ToolContext =>
  ({
    agentId: "nouva",
    sessionId: "s1",
    chatId: "c1",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u1",
    chatType: "dm",
    workspaceDir: dir,
    agentDir: dir,
    workspaceRoots: [dir],
    signal: new AbortController().signal,
  }) as ToolContext;

beforeEach(async () => {
  dir = tempDir("read-many");
  await writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
  await writeTextFile(join(dir, "b.ts"), "export const b = 2;\n");
  await writeTextFile(join(dir, "c.ts"), "export const c = 3;\n");
});

afterEach(() => removePath(dir));

describe("one call, several files", () => {
  test("returns all of them, each under its own path", async () => {
    const result = await read.execute({ paths: ["a.ts", "b.ts", "c.ts"] }, ctx());

    expect(result.isError).toBe(false);
    // The heading is not decoration: without it the contents run together and the model attributes a
    // line to the wrong file, which is worse than not having read it.
    expect(result.content).toContain("===== a.ts =====");
    expect(result.content).toContain("export const a = 1;");
    expect(result.content).toContain("===== c.ts =====");
    expect(result.content).toContain("export const c = 3;");
    expect(result.metadata).toMatchObject({ files: 3 });
  });

  test("a file that cannot be read does not lose the ones that can", async () => {
    // The important one. A batch that fails as a whole teaches the model to go back to one call per
    // file — the exact habit this parameter exists to break.
    const result = await read.execute({ paths: ["a.ts", "gone.ts", "b.ts"] }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("export const a = 1;");
    expect(result.content).toContain("export const b = 2;");
    // And it says which one did not arrive, by name, so the model does not silently answer from two
    // files believing it read three.
    expect(result.content).toContain("Could not read:");
    expect(result.content).toContain("gone.ts");
    expect(result.metadata).toMatchObject({ files: 2, failed: 1 });
  });

  test("nothing readable at all is an error, not an empty success", async () => {
    const result = await read.execute({ paths: ["gone.ts", "also-gone.ts"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("gone.ts");
  });

  test("the same path twice is read once", async () => {
    const result = await read.execute({ paths: ["a.ts", "a.ts"] }, ctx());
    expect(result.metadata).toMatchObject({ files: 1 });
  });

  test("a path outside the workspace is refused without taking the others down", async () => {
    const result = await read.execute({ paths: ["a.ts", "/etc/passwd"] }, ctx());

    expect(result.content).toContain("export const a = 1;");
    expect(result.content).toContain("Could not read:");
    expect(result.content).not.toContain("root:");
  });
});

describe("what a batch refuses", () => {
  test("more paths than the cap, with what to do instead", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const result = await read.execute({ paths: many }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("the limit is 10");
    // A refusal that names the way forward. `glob` and `grep` are how you narrow before reading.
    expect(result.content).toContain("glob");
  });

  test("a line range, because that describes one file", async () => {
    const result = await read.execute({ paths: ["a.ts", "b.ts"], limit: 5 }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("describe one file");
  });

  test("neither path nor paths", async () => {
    const result = await read.execute({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("`paths` for several");
  });
});

describe("the single-file path still behaves exactly as it did", () => {
  test("one path returns the contents with no heading", async () => {
    const result = await read.execute({ path: "a.ts" }, ctx());
    expect(result.content).toBe("export const a = 1;\n");
    expect(result.content).not.toContain("=====");
  });

  test("offset and limit still slice it", async () => {
    await writeTextFile(join(dir, "long.ts"), ["one", "two", "three", "four"].join("\n"));
    const result = await read.execute({ path: "long.ts", offset: 2, limit: 2 }, ctx());

    expect(result.content).toBe("two\nthree");
    expect(result.metadata).toMatchObject({ lines: 2, totalLines: 4 });
  });

  test("a missing file is still a plain error", async () => {
    const result = await read.execute({ path: "gone.ts" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No such file");
  });
});

describe("what the step log says about a batch", () => {
  test("names the files, not the JSON", async () => {
    // The first live batch logged `read {"paths":["/opt/projects/core/RE…` — the raw fallback, cut
    // mid-path. A parameter that makes turns cheap must not make the step log unreadable.
    const { describeToolCall } = await import("@/commons/activity.ts");

    // `describeToolCall` prefixes the tool name; the part under test is what follows it.
    expect(describeToolCall("read", { paths: ["/a/b/one.ts", "/c/two.ts"] })).toBe("read one.ts, two.ts");
  });

  test("and says how many it is not showing", async () => {
    const { describeToolCall } = await import("@/commons/activity.ts");
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];

    expect(describeToolCall("read", { paths })).toBe("read a.ts, b.ts, c.ts, d.ts +2 more");
  });
});

describe("a batch bigger than what the model will see", () => {
  test("stops at the visible budget and names what it did not read", async () => {
    // Read to the 256KB ceiling, a batch came back through the spill as a head and a tail: the files
    // in the middle were read and paid for, then cut out of the excerpt, while the sections said all
    // of them were there.
    const big = Array.from({ length: 400 }, (_, i) => `row ${i} of a file that is long enough`).join("\n");
    for (const name of ["one", "two", "three", "four"]) await writeTextFile(join(dir, `${name}.txt`), big);

    const result = await read.execute(
      { paths: ["one.txt", "two.txt", "three.txt", "four.txt"] },
      { ...ctx(), resultChars: 20_000 },
    );

    expect(result.content.length).toBeLessThan(20_000 + 1_000);
    expect(result.content).toContain("===== one.txt =====");
    expect(result.content).toMatch(/Not read, since this call reached its \d+KB budget: .*four\.txt/);
    expect(result.content).toContain("read this file on its own, with offset and limit");
  });

  test("without a visible budget, the read ceiling is still the limit", async () => {
    // Outside the executor nothing says how much will be shown, and the old behaviour stands.
    const result = await read.execute({ paths: ["a.ts", "b.ts"] }, ctx());
    expect(result.content).not.toContain("Not read");
  });
});
