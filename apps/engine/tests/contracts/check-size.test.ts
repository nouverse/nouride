/**
 * The size ratchet turns both ways.
 *
 * It used to report only a budget whose file was gone, though its own comment promised more: `config/schema.ts` sat at
 * 266 lines against a budget of 548 and `reflection/synthesis.ts` at 332 against 544 — both under the cap, both free to
 * grow back to their old size with lint:size green.
 */

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { sizedFiles, sizeFinding } from "../../../../scripts/check-size.ts";

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

  test("the raise it asks for, when a file grows, is one with a reason", () => {
    expect(sizeFinding(549, 400, 548)?.detail).toContain("say in its `why`");
  });
});

describe("which files are sized", () => {
  test("the root scripts with the source — the lints and the release tooling were held to no cap", async () => {
    const root = join(import.meta.dir, "../../../..");
    const files = (await sizedFiles(root)).map((path) => relative(root, path));
    expect(files).toContain("scripts/check-sql.ts");
    expect(files).toContain("scripts/build/core.ts");
    expect(files).toContain("apps/engine/src/index.ts");
    expect(files.some((file) => file.includes("/node_modules/"))).toBe(false);
  });
});
