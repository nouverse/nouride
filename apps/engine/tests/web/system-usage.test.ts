/**
 * How large the data folder is (`system-usage.ts`): `du`'s lines read, and a measure that is asked for and comes
 * later, kept while it is fresh and never made up.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderSizes, folderSizesOf } from "@/modules/web/control/system-usage.ts";
import { eventually } from "../helpers.ts";

describe("du's lines", () => {
  test("each entry in bytes, largest first, and their sum; a name with a space or a tab's worth of digits is its own", () => {
    expect(folderSizesOf("4\t./config.toml\n2048\t./workspace\n16\t./my notes\n512\t./data\n")).toEqual({
      totalBytes: 2580 * 1024,
      entries: [
        { name: "workspace", bytes: 2048 * 1024 },
        { name: "data", bytes: 512 * 1024 },
        { name: "my notes", bytes: 16 * 1024 },
        { name: "config.toml", bytes: 4 * 1024 },
      ],
    });
  });

  test("lines that are not a count are passed over, and no count at all is null, not a size of zero", () => {
    expect(folderSizesOf("du: ./home/.cache: Permission denied\n8\t./agents\n")).toEqual({ totalBytes: 8192, entries: [{ name: "agents", bytes: 8192 }] });
    expect(folderSizesOf("")).toBeNull();
    expect(folderSizesOf("du: illegal option -- d\nusage: du [-a | -s | -d depth]\n")).toBeNull();
  });
});

describe("a measure of the folder", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nr-usage-"));
    mkdirSync(join(dir, "workspace"));
    writeFileSync(join(dir, "config.toml"), "x");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A `du` that answers when the test lets it, and counts how often it was run and with what. */
  function fakeDu(stdout = "8\t./workspace\n4\t./config.toml\n") {
    const calls: string[][] = [];
    let finish: (value: { stdout: string; timedOut: boolean }) => void = () => {};
    const run = (cmd: string[]) => {
      calls.push(cmd);
      return new Promise<{ stdout: string; timedOut: boolean }>((resolve) => (finish = resolve));
    };
    return { calls, run, answer: (timedOut = false) => finish({ stdout, timedOut }) };
  }

  test("asked for, it is being measured; once counted it is ready, and kept: asking again runs nothing", async () => {
    const du = fakeDu();
    let now = 1_000_000;
    const sizes = new FolderSizes(dir, du.run, () => now);
    expect(sizes.read()).toEqual({ state: "measuring", measuredAt: null, totalBytes: null, entries: [] });
    // Asked again meanwhile: still the one count.
    expect(sizes.read().state).toBe("measuring");
    expect(du.calls).toHaveLength(1);
    // Each entry by its own name, behind `--`, so no name is read as an option.
    expect(du.calls[0]!.slice(0, 3)).toEqual(["du", "-sk", "--"]);
    expect(du.calls[0]!.slice(3).sort()).toEqual(["./config.toml", "./workspace"]);
    du.answer();
    await eventually(() => sizes.read().state === "ready", 2_000, "the count taken");
    expect(sizes.read()).toEqual({ state: "ready", measuredAt: 1_000_000, totalBytes: 12 * 1024, entries: [{ name: "workspace", bytes: 8192 }, { name: "config.toml", bytes: 4096 }] });
    now += 9 * 60_000;
    expect(sizes.read().state).toBe("ready");
    expect(du.calls).toHaveLength(1);
  });

  test("ten minutes on it is counted again, and what was known is still said meanwhile", async () => {
    const du = fakeDu();
    let now = 5_000_000;
    const sizes = new FolderSizes(dir, du.run, () => now);
    sizes.read();
    du.answer();
    await eventually(() => sizes.read().state === "ready", 2_000, "the first count");
    now += 11 * 60_000;
    expect(sizes.read()).toMatchObject({ state: "measuring", measuredAt: 5_000_000, totalBytes: 12 * 1024 });
    expect(du.calls).toHaveLength(2);
  });

  test("a count that ran out of time, or printed nothing, is not available: said so with no figure, and not run again at every look", async () => {
    for (const [du, timedOut] of [[fakeDu(), true], [fakeDu("du: not found\n"), false]] as const) {
      let now = 1_000;
      const sizes = new FolderSizes(dir, du.run, () => now);
      expect(sizes.read().state).toBe("measuring");
      du.answer(timedOut);
      await eventually(() => sizes.read().state === "unavailable", 2_000, "the count given up");
      expect(sizes.read()).toEqual({ state: "unavailable", measuredAt: null, totalBytes: null, entries: [] });
      expect(du.calls).toHaveLength(1);
      // Ten minutes on, it is tried once more.
      now += 11 * 60_000;
      expect(sizes.read().state).toBe("measuring");
      expect(du.calls).toHaveLength(2);
    }
  });

  test("a folder with nothing in it is zero bytes, counted, with no command run", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nr-usage-empty-"));
    try {
      const du = fakeDu();
      const sizes = new FolderSizes(empty, du.run, () => 7);
      sizes.read();
      await eventually(() => sizes.read().state === "ready", 2_000, "the empty folder");
      expect(sizes.read()).toEqual({ state: "ready", measuredAt: 7, totalBytes: 0, entries: [] });
      expect(du.calls).toHaveLength(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
