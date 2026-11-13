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
      "Nothing asks, including the changes above, except a program installed for every agent, a change to an agent's own persona, and a change to who People says a person is.",
    );
  });
});

/**
 * And what the card under it says of the second look, once an automation a person turned on was no longer asked
 * again: where the look is chosen it says that an automation is not checked, and which choice keeps it checked.
 */
describe("the Access tab's second look", () => {
  const look = readFileSync(join(import.meta.dir, "../src/modules/agents/components/SecondLook.tsx"), "utf8");

  test("says an automation you turned on is not checked, and that Always look checks it", () => {
    expect(look).toContain("An automation you turned on is not checked, since turning it on is your yes, unless you choose Always look.");
    expect(look).toContain("and on automations: a send it holds waits for your yes on the automation's page.");
    expect(look).toContain("on a mission at Careful and Balanced, off at Trusted, and off on an automation you turned on");
    // The old words: a run nobody watches was always looked at, whatever the agent's level.
    expect(look).not.toContain("A scheduled or webhook run is never Trusted, so it looks");
  });
});
