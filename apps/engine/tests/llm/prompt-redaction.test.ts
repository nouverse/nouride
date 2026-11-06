/**
 * `/prompt` shows the operator their own material and not the product's.
 *
 * Nouride is shipped software. The harness block — the tools briefing, the exec posture, the
 * operating rules — is written in this repo and compiled into the binary, and an install being able
 * to print it verbatim on request makes it public. The operator's SOUL, memory, skills and the
 * facts about their own install are theirs and stay visible: that is what the diagnostic is for.
 *
 * The mechanism is `Section.origin`, declared per section where the section is built, rather than a
 * list of names checked in the dump. A blocklist keyed on names silently leaks the next section
 * somebody adds; a required field makes them answer the question.
 */

import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import { DELIMITER_START } from "@/modules/llm/prompt/types.ts";
import { fakeAgent } from "../helpers.ts";

function built(extra: Record<string, unknown> = {}) {
  return buildSystemPrompt({
    agent: fakeAgent(),
    tools: [],
    harness: {
      approvalRequired: [],
      approvalAvailable: true,
      maxToolIterations: 25,
      commands: [],
      truncates: false,
      workspace: { dir: "/w", roots: ["/w"] },
    },
    gateway: "telegram",
    chatId: "1",
    chatType: "dm",
    sessionId: "s",
    model: "m",
    timezone: "UTC",
    now: new Date("2026-08-19T00:00:00Z"),
    ...extra,
  } as never);
}

describe("what /prompt may print", () => {
  test("the harness block is in the real prompt and not in the dump", () => {
    const p = built();
    const harness = p.sections.find((s) => s.name === "harness");
    expect(harness?.origin).toBe("shipped");

    // The model still gets it — this is a display decision, not a behaviour change.
    expect(p.text.length).toBeGreaterThan(p.operatorText.length);
    expect(p.operatorText).toContain("written by Nouride, not shown");
  });

  test("the operator's own material is verbatim", () => {
    // The point of the diagnostic. Redacting their SOUL would leave a tool that answers nothing.
    const p = built();
    for (const section of p.sections.filter((s) => s.origin === "operator")) {
      const marker = `<<<NOURIDE:${section.name.toUpperCase()}>>>`;
      expect(p.operatorText).toContain(marker);
      expect(marker.startsWith(DELIMITER_START)).toBe(true);
    }
    // `runtime` is our framing of facts that `nouride status` already reports, so it is not here.
    expect(p.operatorText).not.toContain("Today:");
  });

  test("the section boundaries survive, so it still shows where the harness sits", () => {
    /**
     * A swap rather than a deletion. The operator usually opens this to check whether something
     * reached the prompt at all, and an elision that removed the delimiters would answer a
     * different question — "is the harness missing" instead of "what is around it".
     */
    const p = built();
    const order = (text: string) =>
      text
        .split("\n")
        .filter((l) => /^<<<NOURIDE:\/?[A-Z]+>>>$/.test(l))
        .join(",");
    expect(order(p.operatorText)).toBe(order(p.text));
  });

  test("a section must declare who wrote it", () => {
    // The guard against the next one leaking. Every section carries an origin, so adding one
    // without thinking about this is a type error rather than a disclosure.
    for (const section of built().sections) {
      expect(["operator", "shipped"]).toContain(section.origin);
    }
  });

  test("the skills section is the operator's list and not our instructions about it", () => {
    /**
     * Found by running `/prompt` against a live install, which is the only reason this test
     * exists. SKILLS is the operator's — names, descriptions, paths, and an UNAVAILABLE marker
     * that is a fact about their machine — but it was also carrying two lines of our prose: the
     * "read the file with the `read` tool" lead-in, and the paragraph on what to do about a
     * missing dependency. Both shipped in the binary, both printed verbatim on request.
     *
     * A section's origin is one flag for the whole block, so prose that has to be redacted cannot
     * live in a block that must not be. The wording moved to the harness instead.
     */
    const p = built({
      // With `exec`, which is what the install ladder is offered to.
      tools: [{ name: "exec", description: "run", parameters: {} }],
      agent: {
        ...fakeAgent(),
        skills: [
          {
            name: "draw-diagram",
            description: "Render a diagram.",
            path: "/pool/draw-diagram/SKILL.md",
            scope: "shared",
            requires: ["definitely-not-a-real-binary-xyz"],
          },
        ],
      },
    });
    // Theirs, and still shown: the diagnostic exists to answer "did my skill reach the prompt".
    expect(p.operatorText).toContain("draw-diagram");
    expect(p.operatorText).toContain("Render a diagram.");
    expect(p.operatorText).toContain("UNAVAILABLE here: no definitely-not-a-real-binary-xyz");
    // Ours, and gone from the dump while still reaching the model.
    for (const ours of ["Read that file with", "still the right approach", "Install it, in this order"]) {
      expect(p.text).toContain(ours);
      expect(p.operatorText).not.toContain(ours);
    }
  });

  test("the size is reported, so the elision is not mistaken for an empty block", () => {
    const p = built();
    const harness = p.sections.find((s) => s.name === "harness")!;
    expect(p.operatorText).toContain(`${harness.chars} characters`);
  });
});
