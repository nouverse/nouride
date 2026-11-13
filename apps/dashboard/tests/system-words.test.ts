/**
 * What System's page says beside each bar (`modules/system/lib/words.ts`), and where a file's path leads
 * (`lib/paths.ts`): the sentences a person reads, held word for word, and what is said when a figure is missing.
 */

import { describe, expect, test } from "bun:test";
import { ceilingWords, commandsWords, fullnessOf, inUseWords, shareOf, upFor } from "@/modules/system/lib/words";
import { crumbsOf, isMarkdown, languageOf, parentOf } from "@/modules/system/lib/paths";
import { formatBytes } from "@/commons/lib/format";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const memory = (over: Record<string, unknown> = {}) => ({ daemonBytes: 400 * MiB, commands: null, usedBytes: 2 * GiB, totalBytes: 8 * GiB, limited: false, machineBytes: 8 * GiB, ...over }) as Parameters<typeof ceilingWords>[0];

describe("how full", () => {
  test("the part in use, held between none and all; no figure where either number is missing", () => {
    expect(shareOf(2 * GiB, 8 * GiB)).toBe(0.25);
    expect(shareOf(9 * GiB, 8 * GiB)).toBe(1);
    expect(shareOf(null, 8 * GiB)).toBeNull();
    expect(shareOf(2 * GiB, null)).toBeNull();
    expect(shareOf(2 * GiB, 0)).toBeNull();
  });

  test("worth a look from three quarters, nearly full from nine tenths", () => {
    expect([0, 0.5, 0.749].map(fullnessOf)).toEqual(["fine", "fine", "fine"]);
    expect([0.75, 0.899].map(fullnessOf)).toEqual(["high", "high"]);
    expect([0.9, 1].map(fullnessOf)).toEqual(["full", "full"]);
  });
});

describe("the words beside the RAM bar", () => {
  test("what is in use of what there is, or what is known when part of it is not", () => {
    expect(inUseWords(2.1 * GiB, 6 * GiB)).toBe("2.1 GB of 6.0 GB in use");
    expect(inUseWords(null, 6 * GiB)).toBe("6.0 GB in all. How much of it is in use is not something Nouride can tell here.");
    expect(inUseWords(null, null)).toBe("Nouride cannot tell how much RAM there is here.");
  });

  test("where the ceiling comes from: the machine, or a limit set for Nouride below it", () => {
    expect(ceilingWords(memory())).toBe("That is this machine's own RAM.");
    expect(ceilingWords(memory({ limited: true, totalBytes: 6 * GiB }))).toBe("The ceiling is a limit set for Nouride here. The machine it runs on has 8.0 GB.");
    // A limit with no machine figure beside it: said without one, never with a made-up one.
    expect(ceilingWords(memory({ limited: true, totalBytes: 6 * GiB, machineBytes: null }))).toBe("The ceiling is a limit set for Nouride here.");
    // A machine figure no larger than the limit says nothing a person needs: the limit alone is said.
    expect(ceilingWords(memory({ limited: true, totalBytes: 8 * GiB, machineBytes: 8 * GiB }))).toBe("The ceiling is a limit set for Nouride here.");
    expect(ceilingWords(memory({ totalBytes: null }))).toBeNull();
  });

  test("the agents' commands: their own figure and ceiling, or that they are counted with Nouride", () => {
    expect(commandsWords({ usedBytes: 1228 * MiB, maxBytes: 4608 * MiB })).toBe("1.2 GB, and may hold up to 4.5 GB");
    expect(commandsWords({ usedBytes: 300 * MiB, maxBytes: null })).toBe("300.0 MB");
    expect(commandsWords(null)).toBe("Counted together with Nouride here.");
  });
});

test("how long it has been up, to the unit that matters", () => {
  expect([20, 59 * 60, 3 * 3600 + 120, 86_400, 3 * 86_400].map(upFor)).toEqual(["1 min", "59 min", "3 h", "1 day", "3 days"]);
});

test("a size past a gigabyte is said in gigabytes", () => {
  expect(formatBytes(1024 ** 3 - 1)).toBe("1024.0 MB");
  expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  expect(formatBytes(32.4 * GiB)).toBe("32.4 GB");
});

describe("a path under the data folder", () => {
  test("each folder on the way, with the path that opens it, and the folder a path is in", () => {
    expect(crumbsOf("")).toEqual([]);
    expect(crumbsOf("workspace/shared/notes.md")).toEqual([
      { name: "workspace", path: "workspace" },
      { name: "shared", path: "workspace/shared" },
      { name: "notes.md", path: "workspace/shared/notes.md" },
    ]);
    expect(parentOf("workspace/shared/notes.md")).toBe("workspace/shared");
    expect(parentOf("config.toml")).toBe("");
    expect(parentOf("")).toBe("");
  });

  test("a file's words are coloured by its name's ending, and a page of markdown is told from them", () => {
    expect(["index.ts", "run.SH", "config.toml", "data.jsonl", "Dockerfile", "notes.txt", "README"].map(languageOf)).toEqual(["typescript", "bash", "ini", "json", "dockerfile", undefined, undefined]);
    expect(["notes.md", "README.MARKDOWN", "md", "notes.md.bak"].map(isMarkdown)).toEqual([true, true, false, false]);
  });
});
