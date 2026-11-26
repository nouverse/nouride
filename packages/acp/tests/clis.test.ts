/**
 * The built-in coding CLIs, held to one pattern: each one file of `src/clis/` named by its id and exporting its row,
 * every file listed, and every row of the shape a CLI needs to be started, signed in on a box with no browser, and
 * either tried (a package and the versions it ran) or said to be experimental. A new CLI that skips a step fails here,
 * not on a person's box.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { BUILT_IN_CLIS, cliStanding } from "../src/index.ts";

const FOLDER = new URL("../src/clis/", import.meta.url).pathname;
/** The shape, the list, and what the rows' parses share: every other file is one CLI's. */
const SHAPE_FILES = new Set(["row.ts", "index.ts", "read.ts"]);

describe("the built-in coding CLIs", () => {
  test("are one file each, named by the row's id, and every file of the folder is listed", async () => {
    const files = readdirSync(FOLDER).filter((name) => name.endsWith(".ts") && !SHAPE_FILES.has(name));
    expect(files.map((name) => name.slice(0, -3)).sort()).toEqual(BUILT_IN_CLIS.map((row) => row.id).sort());
    for (const file of files) {
      // One row each, beside the parses of its answers.
      const rows = Object.values((await import(`${FOLDER}${file}`)) as Record<string, unknown>).filter((value) => typeof value === "object" && value !== null && "command" in value);
      expect(rows).toHaveLength(1);
      expect(BUILT_IN_CLIS).toContain(rows[0] as (typeof BUILT_IN_CLIS)[number]);
    }
  });

  test("each says how it is started, installed, versioned, instructed and signed in on a box with no browser", () => {
    expect(new Set(BUILT_IN_CLIS.map((row) => row.id)).size).toBe(BUILT_IN_CLIS.length);
    for (const row of BUILT_IN_CLIS) {
      expect(row.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect([row.id, row.name.length > 0, (row.maker ?? "").length > 0]).toEqual([row.id, true, true]);
      expect(row.command.length).toBeGreaterThan(0);
      expect(Array.isArray(row.args)).toBe(true);
      expect(row.install.length).toBeGreaterThan(0);
      expect(row.versionArgs.length).toBeGreaterThan(0);
      expect(row.instructionFile.length).toBeGreaterThan(0);
      expect({ id: row.id, signsIn: Boolean(row.sharedLogin ?? row.login?.length) }).toEqual({ id: row.id, signsIn: true });
      for (const mode of Object.values(row.modes ?? {})) expect(mode.length).toBeGreaterThan(0);
    }
  });

  test("a tried one names its package and the versions it ran; an experimental one names none", () => {
    for (const row of BUILT_IN_CLIS) {
      if (row.experimental) {
        expect({ id: row.id, tested: row.tested }).toEqual({ id: row.id, tested: undefined });
        continue;
      }
      expect(row.package).toBeDefined();
      expect(row.install).toContain(row.package!);
      expect(["update", "current"]).toContain(cliStanding(row.tested!.lowest, row.tested!)!.standing);
    }
  });

  test("a use reader asks over HTTPS, or by a method of the CLI's own, and parses what it is answered", () => {
    for (const row of BUILT_IN_CLIS) {
      const reader = row.readUse;
      if (!reader) continue;
      expect(typeof reader.parse).toBe("function");
      if (reader.kind === "http") {
        expect(reader.url).toStartWith("https://");
        expect(reader.token.length).toBeGreaterThan(0);
      } else expect(reader.method.length).toBeGreaterThan(0);
      // Nothing it understands is no use, not a failure.
      expect(reader.parse({}, 0)).toBeNull();
    }
  });
});
