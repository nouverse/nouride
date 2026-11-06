/**
 * The same fact learned in several chats is a line for each — readable where each was said — and RECALL shows it once
 * where a chat may read several (`same-fact.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { MemoryIndexPort } from "@/modules/memory/memory-index.store.ts";
import { recallFor, type Recall } from "@/modules/memory/recall.ts";
import { oncePerMeaning } from "@/modules/memory/same-fact.ts";
import { FAMILY, GADING_DM, at, household, scripted, speaker } from "./fixture.ts";

// Two of the five copies on the x64 box's profile, in their own words: lexically apart (overlap 0.4), close by meaning.
const DM_SAYS = "Develops Nouride, an AI assistant and daemon platform under Nouverse.";
const GROUP_SAYS = "Develops the Nouride multi-agent platform for Nouverse.";

const fact = (id: string, text: string, day?: string, section = "Work") => ({ id, section, text, ...(day ? { source: `${day}-0900-nouva` } : {}) });
const ids = (...args: Parameters<typeof oncePerMeaning>) => oncePerMeaning(...args).map((kept) => kept.id);
const known = (recall: Recall) => recall.profiles[0]!.facts.map((kept) => kept.text);

/** A vector whose cosine with `toward(1)` is `cosine`, as the store keeps one: int8, scaled to 127. */
function toward(cosine: number): Int8Array {
  const vector = new Int8Array(8);
  vector[0] = Math.round(cosine * 127);
  vector[1] = Math.round(Math.sin(Math.acos(cosine)) * 127);
  return vector;
}

describe("by words, with no vectors", () => {
  test("a restatement is shown once — the one that says everything the other does, though older", () => {
    expect(ids([fact("a", "Uses an Apple MacBook Air M1 laptop.", "2026-09-01"), fact("b", "Uses a MacBook Air M1 laptop.", "2026-10-01")])).toEqual(["a"]);
  });

  test("different facts about one thing are each shown", () => {
    expect(ids([fact("a", "Develops Nouride, a multi-agent platform."), fact("b", "Writes articles about Nouride on his blog.")])).toEqual(["a", "b"]);
  });

  test("the same words under another heading are another fact", () => {
    expect(ids([fact("a", "Uses a MacBook Air M1 laptop.", undefined, "Work"), fact("b", "Uses a MacBook Air M1 laptop.", undefined, "Devices")])).toEqual(["a", "b"]);
  });
});

describe("by meaning, with vectors", () => {
  const facts = [fact("dm", DM_SAYS, "2026-09-10"), fact("other", "Maintains the gading.dev website codebase and blog repository.", "2026-09-16"), fact("group", GROUP_SAYS, "2026-10-21")];
  /** `dm` at the origin; `other` and `group` at these cosines from it. */
  const vectors = (other: number, group: number) => new Map([["dm", toward(1)], ["other", toward(other)], ["group", toward(group)]]);

  test("close vectors and shared words: one line, the newest, in its place", () => {
    expect(ids(facts, vectors(0.5, 0.88))).toEqual(["other", "group"]);
  });

  test("not close enough: both", () => {
    expect(ids(facts, vectors(0.5, 0.8))).toEqual(["dm", "other", "group"]);
  });

  test("close vectors but few words in common: both — a model that scores everything high joins nothing", () => {
    expect(ids(facts, vectors(0.95, 0.5))).toEqual(["dm", "other", "group"]);
  });

  test("a fact with no vector yet is compared by its words", () => {
    expect(ids(facts, new Map([["dm", toward(1)]]))).toEqual(["dm", "other", "group"]);
  });
});

describe("in RECALL", () => {
  const DM = "telegram:nouva:5550001111";
  const GROUP = "telegram:nouva:-100";
  // One fact learned in his DM, its near-copy in a group: a line each, each readable where it was said.
  const index = {
    facts: () => [
      { ...fact("dm", DM_SAYS, "2026-09-10"), subject: "gading", readers: { people: ["gading"] } },
      { ...fact("group", GROUP_SAYS, "2026-10-21"), subject: "gading", readers: { people: ["gading", "sam"], chat: GROUP } },
    ],
    episodes: () => [],
  } as unknown as MemoryIndexPort;
  const vectors = new Map([["dm", toward(1)], ["group", toward(0.88)]]);
  const recall = (audience: Parameters<typeof recallFor>[0]["audience"]) => recallFor({ index, people: [], audience, agentId: "nouva", recent: 0, timeZone: "UTC", vectors });

  test("his DM may read both, and is shown the newest once", () => {
    expect(recall({ kind: "dm", chat: DM, person: "gading" }).profiles[0]!.facts).toEqual([{ section: "Work", text: GROUP_SAYS, learned: "2026-10-21" }]);
  });

  test("the group reads only its own — the DM's wording never reaches it", () => {
    expect(known(recall({ kind: "group", chat: GROUP, present: ["gading"] }))).toEqual([GROUP_SAYS]);
  });

  test("shared knowledge is not collapsed: each line of it was approved by a person", () => {
    const shared = { facts: () => [fact("a", "Wi-Fi is NouNet."), fact("b", "The Wi-Fi is NouNet.")].map((line) => ({ ...line, subject: "shared" })), episodes: () => [] } as unknown as MemoryIndexPort;
    const recalled = recallFor({ index: shared, people: [], audience: { kind: "dm", chat: DM, person: "gading" }, agentId: "nouva", recent: 0, timeZone: "UTC" });
    expect(recalled.shared.map((line) => line.text)).toEqual(["Wi-Fi is NouNet.", "The Wi-Fi is NouNet."]);
  });
});

describe("through the memory service, as a pass files it", () => {
  /** The two Nouride lines close by meaning (cosine 0.9), anything else far from both. */
  const embed = (texts: string[]) => texts.map((text) => (text.includes("multi-agent") ? [0.9, 0.436, 0, 0] : text.includes("Nouride") ? [1, 0, 0, 0] : [0, 0, 1, 0]));

  async function taughtTwice(options: { embed?: typeof embed }) {
    const h = await household(options);
    h.dm(GADING_DM, "nouva", "Aku lagi bikin Nouride, asisten AI", "Keren.", at(9));
    h.group({ ...FAMILY, senderId: "62811" }, "Nouride itu platform multi-agent buat Nouverse", at(13), { agentId: "nouva", text: "Mantap." });
    await h.memory.pass(
      scripted([
        { when: "asisten AI", answer: { summary: "Gading builds Nouride.", tags: ["nouride"], importance: 3, facts: [{ person: "gading", op: "add", section: "Work", text: DM_SAYS }] } },
        { when: "multi-agent", answer: { summary: "Gading described Nouride.", tags: ["nouride"], importance: 3, facts: [{ person: "gading", op: "add", section: "Work", text: GROUP_SAYS }] } },
      ]).ask,
    );
    if (options.embed) await h.memory.embedCatchUp();
    return h;
  }

  test("the group could not read the DM's line, so it kept its own; his DM is shown the newest once", async () => {
    const h = await taughtTwice({ embed });
    try {
      expect(known(h.memory.recall(speaker(GADING_DM)))).toEqual([GROUP_SAYS]);
      expect(known(h.memory.recall(speaker({ ...FAMILY, senderId: "62811" })))).toEqual([GROUP_SAYS]);
    } finally {
      h.close();
    }
  });

  test("with search by meaning off, the two are told apart by their words alone, and both are shown", async () => {
    const h = await taughtTwice({});
    try {
      expect(known(h.memory.recall(speaker(GADING_DM)))).toEqual([DM_SAYS, GROUP_SAYS]);
    } finally {
      h.close();
    }
  });
});
