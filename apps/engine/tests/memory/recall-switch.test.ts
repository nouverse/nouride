/**
 * `[memory] recall`, and a person's own `recall` over it: what is remembered goes into a prompt only where it is on.
 * The pass still learns either way, and the tools still reach all of it.
 */

import { describe, expect, test } from "bun:test";
import type { Person } from "@nouride/shared";
import { renderRecall } from "@/modules/llm/prompt/recall.ts";
import type { MemoryIndexPort } from "@/modules/memory/memory-index.store.ts";
import { recallFor } from "@/modules/memory/recall.ts";
import { GADING_DM, household, scripted, speaker } from "./fixture.ts";

const DM = "telegram:nouva:814";
const GROUP = "telegram:nouva:-100";
const group = { kind: "group" as const, chat: GROUP, present: ["gading", "sam"] };
const dm = (person: string) => ({ kind: "dm" as const, chat: DM, person });

/** A fact each for both people, said in the group, one shared, and one summarized conversation in every chat. */
const index = {
  facts: (subjects: readonly string[]) =>
    [
      { id: "g", subject: "gading", section: "Work", text: "Develops Nouride.", source: "2026-10-21-1400-nouva", readers: { people: ["gading", "sam"], chat: GROUP } },
      { id: "s", subject: "sam", section: "Life", text: "Plays the piano.", source: "2026-10-21-1400-nouva", readers: { people: ["gading", "sam"], chat: GROUP } },
      { id: "w", subject: "shared", section: "Home", text: "The Wi-Fi is NouNet." },
    ].filter((fact) => subjects.includes(fact.subject)),
  episodes: (filter: { statuses: readonly string[] }) =>
    filter.statuses.includes("summarized") ? [{ id: "2026-10-21-1400-nouva", day: "2026-10-21", startedAt: Date.UTC(2026, 9, 21, 7), agents: ["nouva"], summary: "Talked about the piano." }] : [],
} as unknown as MemoryIndexPort;

const people = (gading?: boolean, sam?: boolean): Person[] => [
  { key: "gading", name: "Gading", ...(gading === undefined ? {} : { recall: gading }) },
  { key: "sam", name: "Sam", ...(sam === undefined ? {} : { recall: sam }) },
];
const recall = (audience: Parameters<typeof recallFor>[0]["audience"], options: { recall?: boolean; people?: Person[] } = {}) =>
  recallFor({ index, people: options.people ?? people(), audience, agentId: "nouva", recent: 5, timeZone: "UTC", ...(options.recall === undefined ? {} : { recall: options.recall }) });
const names = (recalled: ReturnType<typeof recall>) => recalled.profiles.map((profile) => profile.name);

describe("[memory] recall", () => {
  test("on, the default: people, shared knowledge and conversations", () => {
    const recalled = recall(group);
    expect(names(recalled)).toEqual(["Gading", "Sam"]);
    expect(recalled.shared).toHaveLength(1);
    expect(recalled.recent).toHaveLength(1);
  });

  test("off: no RECALL at all, in a group or a DM", () => {
    expect(renderRecall({ recall: recall(group, { recall: false }) } as never)).toBeUndefined();
    expect(renderRecall({ recall: recall(dm("gading"), { recall: false }) } as never)).toBeUndefined();
  });
});

describe("a person's own recall, over it", () => {
  test("off for Sam: the group leaves his facts out and keeps the rest", () => {
    const recalled = recall(group, { people: people(undefined, false) });
    expect(names(recalled)).toEqual(["Gading"]);
    expect(recalled.shared).toHaveLength(1);
    expect(recalled.recent).toHaveLength(1);
  });

  test("off for Sam: a DM with him carries nothing", () => {
    expect(renderRecall({ recall: recall(dm("sam"), { people: people(undefined, false) }) } as never)).toBeUndefined();
  });

  test("on for Gading while the setting is off: his DM has his RECALL; a group has his facts and nothing of the chat's", () => {
    const own = recall(dm("gading"), { recall: false, people: people(true) });
    expect(names(own)).toEqual(["Gading"]);
    expect(own.shared).toHaveLength(1);
    expect(own.recent).toHaveLength(1);

    const inGroup = recall(group, { recall: false, people: people(true) });
    expect(names(inGroup)).toEqual(["Gading"]);
    expect(inGroup.shared).toEqual([]);
    expect(inGroup.recent).toEqual([]);
  });
});

describe("through the memory service", () => {
  test("the setting is read live; the pass learned the fact either way, and search still finds it", async () => {
    const h = await household();
    try {
      h.dm(GADING_DM, "nouva", "Aku lagi bikin Nouride", "Keren.", Date.UTC(2026, 8, 25, 2));
      await h.memory.pass(scripted([{ when: "Nouride", answer: { summary: "Gading builds Nouride.", tags: ["nouride"], importance: 3, facts: [{ person: "gading", op: "add", section: "Work", text: "Builds Nouride." }] } }]).ask);
      h.config.memory.recall = false;
      expect(renderRecall({ recall: h.memory.recall(speaker(GADING_DM)) } as never)).toBeUndefined();
      expect((await h.memory.search(speaker(GADING_DM), { query: "Nouride" })).length).toBeGreaterThan(0);

      h.config.people.find((person) => person.key === "gading")!.recall = true;
      expect(h.memory.recall(speaker(GADING_DM)).profiles[0]?.facts.map((fact) => fact.text)).toEqual(["Builds Nouride."]);
    } finally {
      h.close();
    }
  });
});
