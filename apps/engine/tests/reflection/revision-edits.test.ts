/**
 * A revision arrives as edits to the skill, not as the skill written again (`patch.ts`): what is not named stays, the
 * body grows by the edit alone, and an edit that cannot be placed goes back to its writer once with the reason. The
 * weekly review, which exists to shorten the whole, still returns it whole.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeNewSkill } from "@nouride/persona";
import { patched, readEdits } from "@/modules/reflection/patch.ts";
import { REVISE_INSTRUCTION, REWRITE_INSTRUCTION } from "@/modules/reflection/prompts.ts";
import { learning, recovered, removeTempDirs, tempDir, updateAnswer } from "./harness.ts";

afterEach(removeTempDirs);

const BODY = ["## Procedure", "1. Run the build.  ", "2. Push the branch.", "", "## Mistakes to Avoid", "- Pushing before the build ends."].join("\n");

describe("an edit placed in a body", () => {
  test("the text it names is replaced, and nothing else changes", () => {
    const made = patched(BODY, [{ old: "2. Push the branch.", new: "2. Push the branch.\n3. Watch the checks to their end." }]);
    expect(made).toEqual({ body: BODY.replace("2. Push the branch.", "2. Push the branch.\n3. Watch the checks to their end.") });
  });

  test("several are made in order, and an empty `new` takes text out", () => {
    const made = patched(BODY, [
      { old: "1. Run the build.  ", new: "1. Run the build and the lint.  " },
      { old: "- Pushing before the build ends.", new: "" },
    ]);
    expect("body" in made && made.body).toBe(["## Procedure", "1. Run the build and the lint.  ", "2. Push the branch.", "", "## Mistakes to Avoid"].join("\n"));
  });

  // A model copying a line drops the spaces at its end. The body's own two spaces are a markdown line break, and stay.
  test("text copied without the spaces at its lines' ends is still found, and the body's spaces are kept", () => {
    const made = patched(BODY, [{ old: "1. Run the build.\n2. Push the branch.", new: "1. Run the build.\n1b. Run the tests.\n2. Push the branch." }]);
    expect("body" in made && made.body).toContain("1b. Run the tests.");
    const kept = patched(BODY, [{ old: "2. Push the branch.", new: "2. Push." }]);
    expect("body" in kept && kept.body).toContain("1. Run the build.  \n2. Push.");
  });

  test("text that is not in the body is refused by its number, and nothing is changed", () => {
    const made = patched(BODY, [{ old: "2. Push the branch.", new: "2. Push." }, { old: "3. Deploy it.", new: "3. Ship it." }]);
    expect(made).toEqual({ failed: 'edit 2: its `old` text ("3. Deploy it.") is not in the skill. Copy it from the skill as it is written' });
  });

  test("text that is there more than once is refused: which one was meant cannot be known", () => {
    const made = patched(`${BODY}\n- Run the build.`, [{ old: "Run the build.", new: "Run it." }]);
    expect("failed" in made && made.failed).toContain("is in the skill 2 times. Copy more of the text around it");
  });

  test("an answer's edits are read where they are edits, and anything else is left out", () => {
    expect(readEdits([{ old: "a", new: "b" }, { old: "", new: "c" }, { old: "d" }, "text", null, { old: "e", new: "" }])).toEqual([
      { old: "a", new: "b" },
      { old: "e", new: "" },
    ]);
    expect(readEdits("not a list")).toEqual([]);
  });
});

/** A pool with one skill an agent wrote, and a pass that says to improve it. */
async function improving(written: string | string[]) {
  const agentsDir = tempDir();
  await writeNewSkill(agentsDir, { name: "site-contributing", description: "Use when changing the site.", body: BODY, author: "nouva" });
  return learning({ agentsDir, triage: updateAnswer("site-contributing"), written });
}
const edits = (list: { old: string; new: string }[], extra: Record<string, unknown> = {}) => JSON.stringify({ description: "Use when changing the site.", requires: "", edits: list, ...extra });

describe("a revision is the skill with its edits made", () => {
  test("the draft is the body as it was, changed where the edit said", async () => {
    const h = await improving(edits([{ old: "2. Push the branch.", new: "2. Push the branch.\n3. Watch the checks to their end." }]));
    await h.engine.observe(recovered("ses_1"));
    const [draft] = h.drafts.pending();
    expect(draft?.target).toBe("site-contributing");
    expect(draft?.body).toBe(BODY.replace("2. Push the branch.", "2. Push the branch.\n3. Watch the checks to their end."));
    expect(h.calls().written).toBe(1);
  });

  test("the writer is asked for edits in those words, and the weekly review for the whole", async () => {
    const h = await improving(edits([{ old: "2. Push the branch.", new: "2. Push." }]));
    await h.engine.observe(recovered("ses_1"));
    expect(h.asked.at(-1)?.prompt).toContain("**Change it with edits. Do not write the skill again.**");
    expect(REVISE_INSTRUCTION).toContain('"edits": [{"old": "text copied from the body", "new": "what replaces it"}]');
    expect(REVISE_INSTRUCTION).not.toContain("the whole improved markdown body");
    expect(REWRITE_INSTRUCTION).toContain('"body": "the whole improved markdown body, in English"');
    expect(REWRITE_INSTRUCTION).not.toContain('"edits"');
  });

  test("an edit that cannot be placed goes back once with the reason, and the second answer is kept", async () => {
    const h = await improving([edits([{ old: "3. Deploy it.", new: "3. Ship it." }]), edits([{ old: "2. Push the branch.", new: "2. Push the branch.\n3. Ship it." }])]);
    await h.engine.observe(recovered("ses_1"));
    expect(h.calls().written).toBe(2);
    expect(h.asked.at(-1)?.prompt).toContain('The daemon refused the draft you wrote for this: edit 1: its `old` text ("3. Deploy it.") is not in the skill');
    expect(h.asked.at(-1)?.prompt).toContain("An\nedit whose `old` was not found is copied again from the skill, exactly as it is written there.");
    expect(h.drafts.pending()[0]?.body).toContain("3. Ship it.");
  });

  test("placed nowhere twice: no draft, no third call, and why is kept for a person to read", async () => {
    const h = await improving(edits([{ old: "3. Deploy it.", new: "3. Ship it." }]));
    await h.engine.observe(recovered("ses_1"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.calls().written).toBe(2);
    expect(h.audited.find((row) => row.action === "skill_pass_nothing")?.details).toMatchObject({ why: expect.stringContaining("its change could not be placed in the skill") });
  });

  test("a revision that only adds a file beside the skill keeps the body as it stands", async () => {
    const h = await improving(JSON.stringify({ description: "Use when changing the site.", requires: "", files: [{ path: "references/checks.md", content: "The checks, one a line." }] }));
    await h.engine.observe(recovered("ses_1"));
    const [draft] = h.drafts.pending();
    expect(draft?.body).toBe(BODY);
    expect(draft?.files.map((file) => file.path)).toEqual(["references/checks.md"]);
  });

  // The body is still read where a model writes the skill again whatever it was asked: nothing is lost by the change.
  test("a whole body where edits were asked for is taken as the body", async () => {
    const h = await improving(JSON.stringify({ description: "Use when changing the site.", requires: "", body: `${BODY}\n- Forgetting the lint.` }));
    await h.engine.observe(recovered("ses_1"));
    expect(h.drafts.pending()[0]?.body).toBe(`${BODY}\n- Forgetting the lint.`);
  });

  test("approved, the changed skill's reads are counted from there", async () => {
    const h = await improving(edits([{ old: "2. Push the branch.", new: "2. Push." }]));
    await h.engine.observe(recovered("ses_1"));
    const outcome = await h.engine.approve(h.drafts.pending()[0]!.id, "gading");
    expect(outcome.ok).toBe(true);
    expect(h.changed).toEqual([outcome.ok ? outcome.path : ""]);
  });
});
