/**
 * The size ratchet turns both ways.
 *
 * It used to report only a budget whose file was gone, though its own comment promised more: `config/schema.ts` sat at
 * 266 lines against a budget of 548 and `reflection/synthesis.ts` at 332 against 544 — both under the cap, both free to
 * grow back to their old size with lint:size green.
 *
 * And a budget's own entry is held: its reason is today's, short enough to read, and the files split on their seams
 * get no budget to grow back into. The reasons had become a changelog, a clause per raise, and nobody read them.
 */

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { checkSize, sizedFiles, sizeFinding } from "../../../../scripts/check-size.ts";
import { ANY_BUDGET, BUDGET, TEST_BUDGET, type Budget } from "../../../../scripts/size-budgets.ts";

const ROOT = join(import.meta.dir, "../../../..");

const rule = (code: number, budget?: number) => sizeFinding(code, 400, budget)?.rule ?? null;

describe("a file's size against its cap and its budget", () => {
  test("unlisted, it may reach the cap and no further", () => {
    expect(rule(400)).toBeNull();
    expect(rule(401)).toBe("file-too-large");
  });

  test("listed, it may not grow past its budget", () => {
    expect(rule(548, 548)).toBeNull();
    expect(rule(549, 548)).toBe("file-grew");
  });

  test("a budget far above its file is slack to be lowered — a few lines of headroom are not", () => {
    expect(rule(540, 548)).toBeNull();
    expect(rule(537, 548)).toBe("budget-slack");
    expect(sizeFinding(537, 400, 548)?.detail).toContain("lower it to 537");
  });

  test("a listed file back under the cap loses its entry, whatever its budget", () => {
    expect(rule(266, 548)).toBe("budget-under-cap");
    expect(rule(399, 406)).toBe("budget-under-cap");
  });

  test("the raise it asks for, when a file grows, is one with a short reason", () => {
    expect(sizeFinding(549, 400, 548)?.detail).toContain("say in its `why`");
    expect(sizeFinding(549, 400, 548)?.detail).toContain("in at most 200 characters");
  });
});

describe("a budget's own entry, through the whole check", () => {
  /** What the check says of `file` with `entry` planted in `BUDGET`, the tree and the other tables as they are. */
  async function planted(file: string, entry: Budget): Promise<{ rule: string; detail: string }[]> {
    const findings = await checkSize(ROOT, { BUDGET: { ...BUDGET, [file]: entry }, TEST_BUDGET, ANY_BUDGET });
    return findings.filter((finding) => finding.file === file).map(({ rule, detail }) => ({ rule, detail }));
  }
  /** A file over the cap today, so a planted entry fits its size and only the entry's own rules speak. */
  const LISTED = "packages/policy/src/hardline.ts";

  test("this tree's tables hold", async () => {
    expect(await checkSize(ROOT)).toEqual([]);
  });

  test("a reason is one, today's: 200 characters pass, 201 are refused, and none is refused", async () => {
    const { lines } = BUDGET[LISTED]!;
    expect(await planted(LISTED, { lines, why: "x".repeat(200) })).toEqual([]);
    const [long] = await planted(LISTED, { lines, why: "x".repeat(201) });
    expect(long).toEqual({ rule: "budget-why", detail: expect.stringContaining("is 201 characters") });
    expect(long!.detail).toContain("the one reason the file is over the cap today");
    expect((await planted(LISTED, { lines, why: " " })).map((finding) => finding.rule)).toEqual(["budget-why"]);
  });

  test("the three files split on their seams may not be budgeted again, whatever the entry says", async () => {
    for (const file of ["apps/engine/src/index.ts", "apps/engine/src/modules/pipeline/index.ts", "apps/engine/src/modules/pipeline/turn.ts"]) {
      const rules = await planted(file, { lines: 400, why: "short" });
      // `budget-under-cap` too: each is under the cap today. Refused by name all the same, at any size.
      expect({ file, refused: rules.find((finding) => finding.rule === "budget-refused")?.detail }).toEqual({
        file,
        refused: expect.stringContaining("may not be budgeted again"),
      });
    }
  });
});

describe("which files are sized", () => {
  test("the root scripts with the source — the lints and the release tooling were held to no cap", async () => {
    const files = (await sizedFiles(ROOT)).map((path) => relative(ROOT, path));
    expect(files).toContain("scripts/check-sql.ts");
    expect(files).toContain("scripts/build/core.ts");
    expect(files).toContain("apps/engine/src/index.ts");
    expect(files.some((file) => file.includes("/node_modules/"))).toBe(false);
  });
});
