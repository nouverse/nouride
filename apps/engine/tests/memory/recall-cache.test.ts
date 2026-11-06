/**
 * M2 — what a group's prompt recalls does not move with who is speaking, and what does move it costs only its own block.
 *
 * Driven the way the daemon drives it: two people speak in the family group, the pass files what each said, and the
 * prompt is built from `memory.recall` for each of them in turn. The profiles used to come out speaker first, so the
 * bytes of the cached prefix changed with every change of speaker and took the harness behind them out of the cache.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BuiltPrompt, HarnessFacts } from "@/modules/llm/prompt/index.ts";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import type { Recall } from "@/modules/memory/index.ts";
import { fakeAgent } from "../helpers.ts";
import { FAMILY, TZ, at, household, scripted, speaker, type Household } from "./fixture.ts";

const GADING_HERE = { ...FAMILY, senderId: "62811" };
const SAM_HERE = { ...FAMILY, senderId: "62877" };

const HARNESS: HarnessFacts = {
  approvalRequired: [],
  approvalAvailable: true,
  maxToolIterations: 25,
  maxTurnDurationMs: 300_000,
  commands: ["/new"],
  truncates: true,
};

let h: Household;

beforeEach(async () => {
  h = await household();
  h.group(GADING_HERE, "Aku beli sepeda baru", at(9), { agentId: "nouva", text: "Mantap." });
  h.group(SAM_HERE, "Aku mulai les piano", at(10), { agentId: "nouva", text: "Seru!" });
  await h.memory.pass(
    scripted([
      {
        when: "sepeda",
        answer: {
          summary: "Gading bought a bicycle; Sam started piano lessons.",
          tags: ["hobby"],
          importance: 3,
          facts: [
            { person: "gading", op: "add", section: "Things", text: "Has a new bicycle." },
            { person: "sam", op: "add", section: "Hobbies", text: "Takes piano lessons." },
          ],
        },
      },
    ]).ask,
  );
});

afterEach(() => h.close());

/** The family group's system prompt, for whoever is speaking. */
function promptFor(recall: Recall, person: string): BuiltPrompt {
  return buildSystemPrompt({
    agent: fakeAgent({ persona: { identity: "# IDENTITY\n- Name: Nouva", memory: "## House\n- Two cats." } }),
    tools: [{ name: "memory_search", description: "search", parameters: { type: "object" } }],
    harness: HARNESS,
    gateway: "whatsapp",
    chatId: FAMILY.chatId,
    chatType: "group",
    sessionId: "ses_nouva:whatsapp:main:1203@g.us",
    model: "claude-sonnet-4-20250514",
    now: new Date(at(12)),
    timezone: TZ,
    recall,
    person: { name: person },
  });
}

const cached = (prompt: BuiltPrompt) => prompt.blocks.filter((block) => block.cache).map((block) => block.text);

describe("a group's recall, as the prompt carries it", () => {
  test("a change of speaker changes no byte of the cached prefix", () => {
    const gading = h.memory.recall(speaker(GADING_HERE));
    const sam = h.memory.recall(speaker(SAM_HERE));

    // In key order — gading before sam — for both of them, rather than each one first in their own turn.
    expect(gading.profiles.map((profile) => profile.name)).toEqual(["Gading", "Kak Sam"]);
    expect(sam).toEqual(gading);

    const asGading = promptFor(gading, "Gading");
    const asSam = promptFor(sam, "Kak Sam");
    expect(cached(asSam)).toEqual(cached(asGading));
    // Not vacuous: what is recalled is in a cached block, both profiles in it.
    const recallBlock = cached(asGading).find((text) => text.includes("<<<NOURIDE:RECALL>>>"));
    expect(recallBlock).toContain("What you know about Gading:\nThings:\n- 2026-09-25 · Has a new bicycle.");
    expect(recallBlock).toContain("What you know about Kak Sam:\nHobbies:\n- 2026-09-25 · Takes piano lessons.");
    // Who is speaking is still said — after the conversation (`situation`), so not one block of the system prompt moves
    // with it. In its last block it moved the prefix every conversation behind it is cached on (2026-10-22).
    expect(asSam.blocks).toEqual(asGading.blocks);
    expect(asSam.situation).toContain("You are talking to Kak Sam.");
    expect(asSam.blocks.some((block) => block.text.includes("You are talking to"))).toBe(false);
  });

  test("a fact written mid-conversation moves the recall's own block, and nothing in front of it", async () => {
    const before = promptFor(h.memory.recall(speaker(GADING_HERE)), "Gading");
    await h.memory.noteAboutSpeaker(speaker(GADING_HERE), { op: "add", section: "Things", text: "Rides it to work on Mondays." });
    const after = promptFor(h.memory.recall(speaker(GADING_HERE)), "Gading");

    // The pack, then the harness, then the recall, then what a request moves — four blocks, three cached.
    expect([...after.text.matchAll(/<<<NOURIDE:([A-Z]+)>>>/g)].map((m) => m[1])).toEqual(["IDENTITY", "MEMORY", "HARNESS", "RECALL", "RUNTIME"]);
    expect(after.situation).toStartWith("<<<NOURIDE:DYNAMIC>>>");
    expect(after.blocks.map((block) => block.cache ?? false)).toEqual([true, true, true, false]);
    expect(after.blocks[0]!.text).toContain("<<<NOURIDE:MEMORY>>>");
    expect(after.blocks[1]!.text).toContain("<<<NOURIDE:HARNESS>>>");
    expect(after.blocks[2]!.text).toStartWith("<<<NOURIDE:RECALL>>>");
    // The pack and the harness are what the cache keeps; only the recall is written again.
    expect(after.blocks.slice(0, 2)).toEqual(before.blocks.slice(0, 2));
    expect(after.blocks[2]!.text).not.toBe(before.blocks[2]!.text);
    expect(after.blocks[2]!.text).toContain("Rides it to work on Mondays.");
  });
});
