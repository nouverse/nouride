/**
 * Facts that know what day it is.
 *
 * A fact that stopped being true is not recalled; a date coming this week is; what someone asked to be
 * reminded of is listed on its own, so the per-person fact cap can never hide a promise. Every one of
 * them still obeys who may read the fact.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderRecall } from "@/modules/llm/prompt/recall.ts";
import { comingOn, isOver } from "@/modules/memory/fact-dates.ts";
import { buildPassPrompt } from "@/modules/memory/pass-prompt.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { FAMILY, GADING_DM, SAM_DM, at, household, scripted, speaker, type Household } from "./fixture.ts";

describe("the dates in a fact's words", () => {
  test("(until …) is over the day after, not on the day", () => {
    expect(isOver("In Bali (until 2026-09-24).", "2026-09-25")).toBe(true);
    expect(isOver("In Bali (until 2026-09-25).", "2026-09-25")).toBe(false);
    expect(isOver("Lives in Bandung.", "2026-09-25")).toBe(false);
  });

  test("(on …) within the week, today included; a yearly date past this year's falls next year", () => {
    expect(comingOn("Dentist (on 2026-09-25).", "2026-09-25", 7)).toBe("2026-09-25");
    expect(comingOn("Dentist (on 2026-10-02).", "2026-09-25", 7)).toBe("2026-10-02");
    expect(comingOn("Dentist (on 2026-10-03).", "2026-09-25", 7)).toBeNull();
    expect(comingOn("Dentist (on 2026-09-24).", "2026-09-25", 7)).toBeNull();
    expect(comingOn("Birthday (on --09-28).", "2026-09-25", 7)).toBe("2026-09-28");
    expect(comingOn("Birthday (on --01-02).", "2026-12-30", 7)).toBe("2027-01-02");
    expect(comingOn("Birthday (on --09-20).", "2026-09-25", 7)).toBeNull();
  });
});

let h: Household;

beforeEach(async () => {
  h = await household();
  h.dm(GADING_DM, "nouva", "Aku di Bali sampai tanggal 24, ulang tahun ibu tanggal 28", "Siap, aku ingetin.", at(9));
  h.dm(SAM_DM, "nix", "Ingetin aku bayar listrik tanggal 30 ya", "Oke.", at(10));
  await h.memory.pass(
    scripted([
      {
        when: "Bali",
        answer: {
          summary: "Gading is in Bali until the 24th; his mother's birthday is on the 28th.",
          importance: 3,
          facts: [
            { person: "gading", op: "add", section: "Plans", text: "In Bali on holiday (until 2026-09-24)." },
            { person: "gading", op: "add", section: "Family", text: "His mother's birthday (on --09-28)." },
            { person: "gading", op: "add", section: "Work", text: "Maintains the family's photo backup server." },
          ],
        },
      },
      { when: "listrik", answer: { summary: "Sam asked to be reminded to pay the electricity bill.", importance: 3, facts: [{ person: "sam", op: "add", section: "Follow-ups", text: "Pay the electricity bill (on 2026-09-30)." }] } },
    ]).ask,
  );
});

afterEach(() => h.close());

describe("recall that knows the day", () => {
  test("a fact that is over is not recalled; one still true is", () => {
    const recall = h.memory.recall(speaker(GADING_DM));
    const texts = recall.profiles.flatMap((profile) => profile.facts.map((fact) => fact.text));
    expect(texts).toContain("Maintains the family's photo backup server.");
    expect(texts).not.toContain("In Bali on holiday (until 2026-09-24).");
  });

  test("a date in the next week is brought up, soonest first, with whose it is", () => {
    const recall = h.memory.recall(speaker(GADING_DM));
    expect(recall.upcoming).toEqual([{ name: "Gading", text: "His mother's birthday (on --09-28).", day: "2026-09-28" }]);
    const text = renderRecall({ recall } as never) ?? "";
    expect(text).toContain("Coming up in the next week");
    expect(text).toContain("- 2026-09-28 · Gading · His mother's birthday (on --09-28).");
  });

  test("a follow-up is listed on its own, not among the facts, and only where its source may be read", () => {
    const recall = h.memory.recall(speaker(SAM_DM, "nix"));
    expect(recall.followUps).toEqual([{ name: "Kak Sam", text: "Pay the electricity bill (on 2026-09-30).", learned: "2026-09-25" }]);
    expect(recall.profiles.flatMap((profile) => profile.facts)).toEqual([]);
    expect(recall.upcoming.map((fact) => fact.day)).toEqual(["2026-09-30"]);
    expect(renderRecall({ recall } as never)).toContain("Open follow-ups");
    // When it was asked for, before whose it is — and the one coming up says it is the day it falls on.
    expect(renderRecall({ recall } as never)).toContain("- 2026-09-25 · Kak Sam · Pay the electricity bill (on 2026-09-30).");
    expect(renderRecall({ recall } as never)).toContain("Coming up in the next week, by the day it falls on");
    // Said in her DM: never in the family group she speaks in.
    const group = h.memory.recall(speaker({ ...FAMILY, senderId: "62877" }));
    expect(group.followUps).toEqual([]);
    expect(group.upcoming).toEqual([]);
  });

  test("a week later the birthday has passed and is not brought up", () => {
    h.clock.now = at(9, 0, 30);
    expect(h.memory.recall(speaker(GADING_DM)).upcoming).toEqual([]);
  });

  test("search does not find a fact that is over", async () => {
    const search = createMemorySearchTool(h.memory);
    const ctx = { agentId: "nouva", agentDir: join(h.dir, "agents", "nouva"), sessionId: "s", signal: new AbortController().signal, ...GADING_DM } as never;
    const result = await search.execute({ query: "holiday" }, ctx);
    expect(result.content).not.toContain("In Bali on holiday");
  });
});

describe("the nightly pass is told", () => {
  test("how to write dates, that a fact past its date is over, and what a follow-up is", () => {
    const system = buildPassPrompt({ agents: ["nouva"], day: "2026-09-25", time: "09:00", kind: "dm", participants: [], transcript: "", people: [], known: [], shared: [], sharedWaiting: [], vocabulary: [], chatTags: [] }).system[0]!.text;
    expect(system).toContain("(until YYYY-MM-DD)");
    expect(system).toContain("(on --MM-DD)");
    expect(system).toContain("before When is over: remove it");
    expect(system).toContain('Section "Follow-ups"');
  });
});
