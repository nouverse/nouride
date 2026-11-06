/**
 * How many facts a prompt carries in a big group: 60 a person, 120 in all, the same share for everyone present
 * whoever is speaking (M2) — so a group of fifteen does not put 900 facts in every turn, and a change of speaker
 * does not rewrite the block.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryIndexPort } from "@/modules/memory/memory-index.store.ts";
import { recallFor } from "@/modules/memory/recall.ts";

const CHAT = "telegram:bot:-100";

/** `sizes[i]` facts for person `p<i>`, all learned in this group. */
function indexOf(sizes: readonly number[]): MemoryIndexPort {
  const facts = sizes.flatMap((size, i) =>
    Array.from({ length: size }, (_, n) => ({ id: `p${i}-${n}`, subject: `p${i}`, section: "Notes", text: `p${i} keeps item${n}`, readers: { people: [`p${i}`], chat: CHAT } })),
  );
  return { facts: (subjects: readonly string[]) => facts.filter((fact) => subjects.includes(fact.subject)), episodes: () => [] } as unknown as MemoryIndexPort;
}

/** The recall for `sizes`, with the people present listed in `order` — the speaker first, as the audience lists them. */
function recallAs(sizes: readonly number[], order: readonly number[] = sizes.map((_, i) => i)) {
  const present = order.map((i) => `p${i}`);
  return recallFor({ index: indexOf(sizes), people: [], audience: { kind: "group", chat: CHAT, present }, agentId: "nouva", recent: 0, timeZone: "UTC" });
}

function shown(sizes: readonly number[]): number[] {
  const recall = recallAs(sizes);
  return sizes.map((_, i) => recall.profiles.find((profile) => profile.name === `p${i}`)?.facts.length ?? 0);
}

describe("facts in a group's prompt", () => {
  test("a small group shows everyone's, up to 60 each", () => {
    expect(shown([10, 70])).toEqual([10, 60]);
  });

  test("fifteen people with 60 each: 8 each, 120 in all — nobody first", () => {
    const counts = shown(Array.from({ length: 15 }, () => 60));
    expect(counts.every((count) => count === 8)).toBe(true);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(120);
  });

  test("a small profile's unused share goes to the others, and what does not divide to the last in key order", () => {
    expect(shown([60, 2, 60, 60])).toEqual([39, 2, 39, 40]);
  });

  test("who is speaking moves neither the order nor a single share", () => {
    const sizes = [60, 2, 45, 60, 30];
    const first = recallAs(sizes, [0, 1, 2, 3, 4]);
    for (const order of [[3, 0, 1, 2, 4], [4, 3, 2, 1, 0], [2, 4, 0, 3, 1]]) expect(recallAs(sizes, order)).toEqual(first);
    // In key order, the profiles and the facts in each.
    expect(first.profiles.map((profile) => profile.name)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    // 2 for p1 leaves 118 for four: 29 and 29 for the next two smallest, 30 and 30 for the two at 60.
    expect(first.profiles.map((profile) => profile.facts.length)).toEqual([30, 2, 29, 30, 29]);
  });
});
