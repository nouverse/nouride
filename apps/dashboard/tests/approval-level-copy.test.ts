/**
 * What the Access tab says each approval level asks. 0.8.15 put this machine's system packages back on `balanced`'s
 * list, and its card had claimed its few were all that asked there while the classes `trusted` still asks — a program
 * for every agent, an agent's persona, People — asked at `balanced` too.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/modules/agents/components/ApprovalLevel.tsx"), "utf8");

describe("the Access tab's approval levels", () => {
  test("balanced names system packages, and what trusted still asks as asked there too", () => {
    expect(source).toContain(
      "a credential leaving this machine, and changing its system packages still ask, as does everything Trusted still asks.",
    );
  });

  test("trusted names what it still asks", () => {
    expect(source).toContain(
      "except work nobody watches sending somewhere its job did not name, a program installed for every agent, a change to an agent's own persona, and a change to who People says a person is.",
    );
  });
});
