/**
 * Which of the three levels applies, and who decided it.
 *
 * The rules are short and the consequences are not, so each one is pinned here rather than left to be
 * reconstructed from the executor. In particular: `trusted` ignores the fixed list, which is the
 * whole reason it is kept off every unauthenticated surface.
 */

import { describe, expect, test } from "bun:test";
import { isAgentApprovalLevel } from "@nouride/shared";
import type { HardlineClass } from "@nouride/shared";
import { describeApprovalLevel, resolveApprovalLevel, skipsApproval } from "../src/approvals.ts";
import { BALANCED_ASKS, HARDLINE_SUMMARY } from "../src/hardline.ts";

/** Every entry of the fixed list, from the summary a person reads — so a class added there is one this table covers. */
const EVERY: HardlineClass[] = HARDLINE_SUMMARY.map((row) => row.class);

describe("who decides", () => {
  test("an agent that states a level wins, for everyone", () => {
    // An agent is a shared surface: several people talk to the same one, and a posture that changed
    // with the speaker is a posture nobody can reason about.
    expect(resolveApprovalLevel({ agent: "careful", person: "trusted", daemon: "balanced" })).toEqual({
      level: "careful",
      source: "agent",
    });
  });

  test("`per-person` is how an agent declines to decide", () => {
    expect(resolveApprovalLevel({ agent: "per-person", person: "trusted", daemon: "careful" })).toEqual({
      level: "trusted",
      source: "person",
    });
  });

  test("an absent agent level behaves the same as per-person", () => {
    // The default. Which keeps exactly the behaviour that existed before this: a person's own "stop
    // asking me" following them around.
    expect(resolveApprovalLevel({ person: "balanced", daemon: "careful" })).toEqual({
      level: "balanced",
      source: "person",
    });
  });

  test("the daemon default is the last word, and says so", () => {
    expect(resolveApprovalLevel({ daemon: "balanced" })).toEqual({ level: "balanced", source: "daemon" });
  });

  test("a person cannot loosen an agent that has decided", () => {
    expect(resolveApprovalLevel({ agent: "careful", person: "trusted", daemon: "trusted" }).level).toBe("careful");
  });

  test("and in this version cannot tighten one either", () => {
    // Safe, considered, and deliberately left out: one more rule to hold in your head for a case
    // nobody has hit. If it ever ships, this test is the one that changes.
    expect(resolveApprovalLevel({ agent: "trusted", person: "careful", daemon: "careful" }).level).toBe("trusted");
  });
});

describe("what each level lets through", () => {
  test("`careful` asks about everything the gate wanted to ask about", () => {
    expect(skipsApproval("careful", undefined)).toBe(false);
    for (const cls of EVERY) expect({ cls, skipped: skipsApproval("careful", cls) }).toEqual({ cls, skipped: false });
  });

  test("`balanced` asks only the four the RFC names, a credential leaving, the daemon's own state and unwatched work", () => {
    // The four: changing a config.toml, giving someone access, stopping the daemon, a stored secret replaced
    // or deleted. And the secret guard, "off only under trusted"; and the daemon's state where nothing else guards it.
    // And work nobody watches sending where its job did not name, or what the second look held (0.8.0).
    expect([...BALANCED_ASKS].sort()).toEqual(["access", "config", "credential-out", "own-state", "people", "persona", "secret", "shared-tools", "stop", "system-packages", "unwatched"]);
    expect(skipsApproval("balanced", undefined)).toBe(true);
    for (const cls of EVERY) {
      expect({ cls, skipped: skipsApproval("balanced", cls) }).toEqual({ cls, skipped: !BALANCED_ASKS.has(cls) });
    }
  });

  test("the summary a person reads names every entry once", () => {
    expect(new Set(EVERY).size).toBe(EVERY.length);
    expect(EVERY.length).toBe(18);
  });

  test("a level that is none of the three lands on the strict side, not the loose one", () => {
    /**
     * The type says this cannot happen and the type is wrong: the level arrives from a TOML file.
     *
     * `[security] approvals` was the one key in its block with no enum, in `CONFIG_ENUMS` or at
     * boot, so `approvals = "riksy"` passed `config check` with "this configuration would start"
     * and reached here. The two exact comparisons were `trusted` and `careful`, with `balanced` as the
     * fall-through — so a typo made while *tightening* to `careful` silently loosened the install
     * instead, and nothing said so.
     *
     * The value is refused at boot now. This is the other half: the unreachable case lands on the
     * side where somebody gets asked.
     */
    expect(skipsApproval("riksy" as never, undefined)).toBe(false);
    expect(skipsApproval("" as never, "delete")).toBe(false);
  });

  test("`trusted` ignores the fixed list — which is why it is dashboard-only", () => {
    for (const cls of [undefined, ...EVERY.filter((one) => !["unwatched", "shared-tools", "persona", "people"].includes(one))]) expect(skipsApproval("trusted", cls)).toBe(true);
  });

  test("…all but work nobody watches: a person who chose not to be asked is not there to see it happen (0.8.0)", () => {
    expect(skipsApproval("trusted", "unwatched")).toBe(false);
  });

  test("…and a program installed for every agent, as the daemon's user — the trusted orchestrator read another's pack so (0.8.1)", () => {
    expect(skipsApproval("trusted", "shared-tools")).toBe(false);
    expect(skipsApproval("balanced", "shared-tools")).toBe(false);
  });

  test("this machine's packages changed as root ask at `careful` and `balanced`, and `trusted` does not (0.8.15)", () => {
    expect(skipsApproval("careful", "system-packages")).toBe(false);
    expect(skipsApproval("balanced", "system-packages")).toBe(false);
    // The agent says what it installs instead — the system packages page, and its own prompt (`harness-skills.ts`).
    expect(skipsApproval("trusted", "system-packages")).toBe(true);
  });

  test("…and an agent's change to its own persona: the rules that ask are in it, and a level is not the owner reading it (0.8.8)", () => {
    expect(skipsApproval("trusted", "persona")).toBe(false);
    expect(skipsApproval("balanced", "persona")).toBe(false);
  });

  test("…and a change to who People says a person is: an admin is one, and a chat linked to them answers as one (0.8.9, N5)", () => {
    expect(skipsApproval("trusted", "people")).toBe(false);
    expect(skipsApproval("balanced", "people")).toBe(false);
  });
});

describe("validation", () => {
  test("an agent may also say per-person", () => {
    expect(isAgentApprovalLevel("per-person")).toBe(true);
    expect(isAgentApprovalLevel("trusted")).toBe(true);
    expect(isAgentApprovalLevel("off")).toBe(false);
  });
});

describe("what a person is told", () => {
  test("the line says what is set and who set it", () => {
    // "Why am I being asked" and "why am I not" are the same question, and the answer is the source.
    const agentSet = describeApprovalLevel({ level: "trusted", source: "agent" });
    expect(agentSet).toContain("nothing asks");
    expect(agentSet).toContain("everyone talking to it");

    expect(describeApprovalLevel({ level: "balanced", source: "person" })).toContain("follows you");
    expect(describeApprovalLevel({ level: "careful", source: "daemon" })).toContain("daemon default");
  });

  test("balanced names this machine's packages, and never claims its list is all that asks", () => {
    // 0.8.15 put `system-packages` back on `balanced`'s list; the classes every level asks ask here too.
    const balanced = describeApprovalLevel({ level: "balanced", source: "daemon" });
    expect(balanced).toContain("a credential leaving and this machine's packages changed ask, besides the few every level asks");
  });
});
