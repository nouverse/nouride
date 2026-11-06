/**
 * Keeping a profile small and true (`modules/memory/consolidate.ts`): a profile that outgrew what the
 * pass and the prompt show of it is tidied by one model call — merged and pruned, only within the
 * facts that share their readers, never on an answer that would gut it, and every change recorded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import { parseTidy, TIDY_PAST_FACTS } from "@/modules/memory/consolidate.ts";
import { factsOf } from "@/modules/memory/profile.ts";
import { household, scripted, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

const DM = "{gading}";
const GROUP = "{gading, sam, in whatsapp:main:1203@g.us}";

/** A profile past the size, in two groups: most of it said in Gading's DM, the last lines in the family group. */
async function bigProfile(): Promise<string> {
  const filler = Array.from({ length: TIDY_PAST_FACTS }, (_, n) => `- Keeps note number ${n + 1} about the homelab. ([[2026-09-0${(n % 9) + 1}-0900-nouva]]) ${DM}`);
  const text = [
    "---",
    "type: person",
    "name: Gading",
    "---",
    "",
    "A paragraph Gading wrote by hand, which is not a fact.",
    "",
    "## Hardware",
    `- Owns a MacBook Air M1. ([[2026-09-01-0900-nouva]]) ${DM}`,
    `- Owns a MacBook Air M1 laptop at 192.168.0.12. ([[2026-09-05-0900-nouva]]) ${DM}`,
    ...filler,
    "## Family",
    `- Plans a trip to Bali in December. ([[2026-09-02-1300-nouva]]) ${GROUP}`,
    "",
  ].join("\n");
  await writeTextFile(h.vault.person("gading"), text);
  await h.memory.sync();
  return text;
}

const profile = async () => (await readTextFileIfExists(h.vault.person("gading"))) ?? "";

describe("tidying a profile that outgrew what is shown of it", () => {
  test("merges and prunes within a group, keeps prose and everything else, and records what changed", async () => {
    await bigProfile();
    const model = scripted([
      {
        when: "## Group",
        answer: { merge: [{ n: [1, 2], text: "Owns a MacBook Air M1 laptop at 192.168.0.12." }], remove: [3] },
      },
    ]);
    expect(await h.memory.pass(model.ask)).toMatchObject({ tidied: 1 });

    const prompt = model.asked.find((ask) => ask.user.includes("## Group"))!;
    expect(prompt.user).toContain("## Group 1");
    expect(prompt.user).toContain("## Group 2");
    expect(prompt.system).toContain("Only facts in the same group may merge.");

    const after = await profile();
    expect(after).toContain("A paragraph Gading wrote by hand, which is not a fact.");
    // The merge takes the newest part's conversation, and the readers the parts share.
    expect(after).toContain("- Owns a MacBook Air M1 laptop at 192.168.0.12. ([[2026-09-05-0900-nouva]]) {gading}");
    expect(after).not.toContain("- Owns a MacBook Air M1. (");
    expect(after).not.toContain("note number 1 about");
    expect(factsOf(after)).toHaveLength(TIDY_PAST_FACTS + 3 - 2);
    expect(after).toContain("Plans a trip to Bali in December.");

    // One tidy-up, one instant: the two changes are recorded together, in no particular order.
    const changes = h.memory.changes({ subject: "gading", limit: 10 });
    expect(changes.map((change) => [change.change, change.cause, change.text]).sort()).toEqual([
      ["merged", "consolidation", "Owns a MacBook Air M1 laptop at 192.168.0.12."],
      ["removed", "consolidation", "Keeps note number 1 about the homelab."],
    ]);
    expect(changes.find((change) => change.change === "merged")!.previous).toBe("Owns a MacBook Air M1.\nOwns a MacBook Air M1 laptop at 192.168.0.12.");
  });

  test("an answer that merges across readers, or would remove a third of the profile, is not used at all", async () => {
    const before = await bigProfile();
    const bali = TIDY_PAST_FACTS + 3;
    await h.memory.pass(scripted([{ when: "## Group", answer: { merge: [{ n: [1, bali], text: "Owns a laptop and plans Bali." }], remove: [] } }]).ask);
    expect(await profile()).toBe(before);
    const gutted = Array.from({ length: 20 }, (_, n) => n + 3);
    expect(await h.memory.pass(scripted([{ when: "## Group", answer: { merge: [], remove: gutted } }]).ask)).toMatchObject({ tidied: 0 });
    expect(await profile()).toBe(before);
    expect(h.memory.changes({ limit: 10 })).toEqual([]);
  });

  test("not under `ask`, where every change is a person's; never shared knowledge; not a profile that fits", async () => {
    const before = await bigProfile();
    h.config.memory.facts = "ask";
    const model = scripted([{ when: "## Group", answer: { merge: [], remove: [3] } }]);
    await h.memory.pass(model.ask);
    expect(model.asked.some((ask) => ask.user.includes("## Group"))).toBe(false);
    expect(await profile()).toBe(before);

    h.config.memory.facts = "auto";
    const shared = Array.from({ length: TIDY_PAST_FACTS + 5 }, (_, n) => `- House rule ${n + 1}.`).join("\n");
    await writeTextFile(h.vault.shared, `## House\n${shared}\n`);
    await writeTextFile(h.vault.person("gading"), `## Work\n- Uses a MacBook. ${DM}\n`);
    await h.memory.sync();
    const quiet = scripted([]);
    await h.memory.pass(quiet.ask);
    expect(quiet.asked.some((ask) => ask.user.includes("## Group"))).toBe(false);
  });
});

describe("reading the model's answer", () => {
  const facts = factsOf(`## A\n- One. ${DM}\n- Two. ${DM}\n- Three. ${GROUP}\n- Four. ${DM}\n- Five. ${DM}\n- Six. ${DM}\n`);

  test("taken only whole: an unknown number, a fact used twice, a one-fact merge or an empty text drops it", () => {
    expect(parseTidy(JSON.stringify({ merge: [{ n: [1, 2], text: "One and two." }], remove: [4] }), facts)).toEqual({ merges: [{ ns: [1, 2], text: "One and two." }], removes: [4] });
    expect(parseTidy(JSON.stringify({ merge: [], remove: [9] }), facts)).toBeNull();
    expect(parseTidy(JSON.stringify({ merge: [{ n: [1, 2], text: "x" }], remove: [2] }), facts)).toBeNull();
    expect(parseTidy(JSON.stringify({ merge: [{ n: [1], text: "x" }], remove: [] }), facts)).toBeNull();
    expect(parseTidy(JSON.stringify({ merge: [{ n: [1, 2], text: " " }], remove: [] }), facts)).toBeNull();
    expect(parseTidy(JSON.stringify({ merge: [{ n: [1, 3], text: "Across readers." }], remove: [] }), facts)).toBeNull();
    expect(parseTidy("not json", facts)).toBeNull();
  });
});
