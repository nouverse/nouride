/**
 * The two ideas taken from Basic Memory and QMD.
 *
 * - `memory_read` with `related`: one hop over the edges the index already holds, through the same
 *   audience rule as any episode. No model, no vectors.
 * - Fusion keeps the keyword ranking's first places, so an exact hit is not pushed down by meaning.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fuse } from "@/modules/memory/semantic.ts";
import { createMemoryReadTool } from "@/modules/tools/builtins/memory.ts";
import { GADING_DM, SAM_DM, at, household, scripted, speaker, type Household } from "./fixture.ts";

describe("fusion keeps exact hits on top", () => {
  test("the keyword ranking's first hit stays first though meaning puts it last", () => {
    const words = ["exact", "b", "c"];
    const meaning = ["b", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "exact"];
    const top = (scores: Map<string, number>) => [...scores].sort((a, b) => b[1] - a[1])[0]![0];
    expect(top(fuse([words, meaning]))).toBe("b");
    expect(top(fuse([words, meaning], { exact: words }))).toBe("exact");
  });
});

let h: Household;

beforeEach(async () => {
  h = await household();
  h.dm(GADING_DM, "nouva", "NAS aku penuh", "Hapus snapshot lama.", at(9));
  h.dm(GADING_DM, "nouva", "NAS aku lambat sekarang", "Cek disk health.", at(9, 0, 26));
  h.dm(SAM_DM, "nix", "NAS Gading penuh katanya", "Iya.", at(10, 0, 26));
  h.clock.now = at(23, 0, 26);
  await h.memory.pass(
    scripted([
      { when: "penuh\n", answer: { summary: "Gading's NAS was full.", tags: ["nas"], importance: 3 } },
      { when: "lambat", answer: { summary: "Gading's NAS is slow.", tags: ["nas"], importance: 3 } },
      { when: "katanya", answer: { summary: "Sam mentioned Gading's NAS being full.", tags: ["nas"], importance: 2, mentions: ["gading"] } },
      { when: "NAS aku penuh", answer: { summary: "Gading's NAS was full.", tags: ["nas"], importance: 3 } },
    ]).ask,
  );
});

afterEach(() => h.close());

describe("memory_read with related", () => {
  const ctx = (where: typeof GADING_DM, agentId: string) => ({ agentId, agentDir: join(h.dir, "agents", agentId), sessionId: "s", signal: new AbortController().signal, ...where }) as never;

  test("lists the conversations next to it this chat may see, and never another person's DM", async () => {
    const read = createMemoryReadTool(h.memory);
    const result = await read.execute({ conversation: "2026-09-26-0900-nouva", related: true }, ctx(GADING_DM, "nouva"));
    expect(result.content).toContain("Conversations next to it:");
    expect(result.content).toContain("⟨2026-09-25-0900-nouva⟩");
    expect(result.content).not.toContain("2026-09-26-1000-nix");
  });

  test("without related it reads as before", async () => {
    const read = createMemoryReadTool(h.memory);
    const result = await read.execute({ conversation: "2026-09-26-0900-nouva" }, ctx(GADING_DM, "nouva"));
    expect(result.content).not.toContain("Conversations next to it");
  });
});

describe("related, with semantic search on (docs/SPEC.md §12.2)", () => {
  /** Four newer conversations about the NAS being full, one older about it being slow, then a new one about slowness. */
  async function relatedOfTheSlowOne(embed?: (texts: string[]) => number[][]): Promise<string[]> {
    const s = await household(embed ? { embed } : {});
    try {
      s.dm(GADING_DM, "nouva", "NAS lambat", "Cek disk.", at(9, 0, 20));
      for (const day of [21, 22, 23, 24]) s.dm(GADING_DM, "nouva", `NAS penuh lagi ${day}`, "Hapus snapshot.", at(9, 0, day));
      s.clock.now = at(23, 0, 24);
      await s.memory.pass(scripted([{ when: "lambat", answer: { summary: "The NAS was slow.", tags: ["nas"] } }], { summary: "The NAS was full.", tags: ["nas"], importance: 2 }).ask);
      await s.memory.embedCatchUp();

      s.dm(GADING_DM, "nouva", "NAS lambat lagi", "Cek kabel.", at(9, 0, 25));
      s.clock.now = at(23, 0, 25);
      await s.memory.pass(scripted([{ when: "lambat", answer: { summary: "The NAS was slow again.", tags: ["nas"] } }]).ask);
      const episode = await s.memory.read(speaker(GADING_DM), "2026-09-25-0900-nouva");
      return "refused" in episode ? [] : episode.related;
    } finally {
      s.close();
    }
  }

  test("of candidates sharing as much, the one about the same thing is kept; without semantic, only the newest", async () => {
    const vector = (text: string) => (/slow/i.test(text) ? [1, 0, 0, 0] : [0, 1, 0, 0]);
    expect(await relatedOfTheSlowOne()).not.toContain("2026-09-20-0900-nouva");
    expect(await relatedOfTheSlowOne((texts) => texts.map(vector))).toContain("2026-09-20-0900-nouva");
  });
});
