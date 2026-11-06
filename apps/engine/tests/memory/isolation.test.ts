/**
 * One bad item is passed over, and the rest is done. A pack directory named `nouva.v2`, a date fixed by
 * hand in Obsidian, a turn log that cannot be read for one chat, a conversation the pass throws on:
 * each of these used to stop the whole nightly pass — every agent's filing, compaction and day hubs —
 * every night, until someone found which file or chat it was.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { listDir, readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import { refreshDays } from "@/modules/memory/maintain.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { sleep } from "../helpers.ts";
import { GADING_DM, SAM_DM, at, household, scripted, type Household } from "./fixture.ts";

let h: Household;

afterEach(() => h.close());

const ids = () => h.memory.episodes({}, 100).map((episode) => episode.id).sort();

describe("passed over, and the rest done", () => {
  test("a pack named nouva.v2: its conversation is cut and filed without a stub, and the chats after it are cut", async () => {
    h = await household();
    h.dm(GADING_DM, "nouva.v2", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    h.dm(SAM_DM, "nix", "Resep rendang dong", "Ini resepnya.", at(10));
    const report = await h.memory.pass(scripted([]).ask);
    expect(report).toMatchObject({ cut: 2, filed: 2, failed: [], problems: [] });
    expect(ids()).toEqual(["2026-09-25-0900-nouva-v2", "2026-09-25-1000-nix"]);
    // No file can be named `nouva.v2.md` safely, and one named by its slug would be linked by nothing.
    expect(listDir(h.vault.agentsDir).map((entry) => entry.name)).toEqual(["nix.md"]);
  });

  test("a chat that cannot be cut is named in the report and left for the next cut; the chats after it are cut", async () => {
    let broken = true;
    h = await household({
      source: (logs) => ({
        ...logs,
        exchangesBetween: (gatewayId, chatId, after, until) => {
          if (broken && chatId === GADING_DM.chatId) throw new Error("the turn log could not be read");
          return logs.exchangesBetween(gatewayId, chatId, after, until);
        },
      }),
    });
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    h.dm(SAM_DM, "nix", "Resep rendang dong", "Ini resepnya.", at(10));
    const first = await h.memory.pass(scripted([]).ask);
    expect(first).toMatchObject({ cut: 1, filed: 1, problems: [{ what: "chat telegram:nouva:814", problem: "the turn log could not be read" }] });

    broken = false;
    expect(await h.memory.pass(scripted([]).ask)).toMatchObject({ cut: 1, filed: 1, problems: [] });
    expect(ids()).toEqual(["2026-09-25-0900-nouva", "2026-09-25-1000-nix"]);
  });

  test("a conversation the pass throws on is a failed attempt, counted, and the next one is filed", async () => {
    h = await household();
    h.dm(GADING_DM, "nouva", "boom", "Hm?", at(9));
    h.dm(SAM_DM, "nix", "Resep rendang dong", "Ini resepnya.", at(10));
    const model = scripted([]);
    const ask: typeof model.ask = async (agentId, prompt) => {
      if (prompt.user.includes("boom")) throw new Error("the provider's client fell over");
      return await model.ask(agentId, prompt);
    };
    const report = await h.memory.pass(ask);
    expect(report).toMatchObject({ filed: 1, failed: [{ episode: "2026-09-25-0900-nouva", reason: "the provider's client fell over" }] });
    expect(h.db.prepare<{ attempts: number }>("SELECT attempts FROM memory_attempts WHERE episode_id = ?").get("2026-09-25-0900-nouva")?.attempts).toBe(1);
  });

  test("a day fixed by hand as 25-09-2026 is a problem the sync names; a reindex, the pass and a delete beside it go on", async () => {
    h = await household();
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9, 0, 25));
    h.dm(GADING_DM, "nouva", "Kalau RAM 2GB?", "Masih bisa.", at(9, 0, 26));
    h.clock.now = at(23, 0, 26);
    await h.memory.pass(scripted([]).ask);

    const file = h.vault.episode("2026-09-25-0900-nouva");
    const text = (await readTextFileIfExists(file)) ?? "";
    expect(text).toContain("[[days/2026/09/2026-09-25]]");
    await sleep(20);
    await writeTextFile(file, text.replace("[[days/2026/09/2026-09-25]]", "[[days/2026/09/25-09-2026]]"));

    const problem = { file: "episodes/2026/09/2026-09-25-0900-nouva.md", problem: 'day "25-09-2026" is not YYYY-MM-DD' };
    expect((await h.memory.sync()).problems).toEqual([problem]);
    expect(ids()).toEqual(["2026-09-26-0900-nouva"]);
    expect((await h.memory.reindex()).problems).toEqual([problem]);

    h.dm(GADING_DM, "nouva", "Pakai Termux versi berapa?", "Yang terbaru.", at(10, 0, 26));
    expect((await h.memory.pass(scripted([]).ask)).problems).toEqual([{ what: problem.file, problem: problem.problem }]);
    expect(await h.memory.deleteEpisode("2026-09-26-0900-nouva")).toMatchObject({ episodes: 1 });
  });

  test("a day hub that cannot be written is passed over, and the days beside it are drawn", async () => {
    h = await household();
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    await h.memory.cutAll();
    const unwritten = await refreshDays(h.vault, new MemoryIndexStore(h.db), ["25-09-2026", "2026-09-25"]);
    expect(unwritten).toEqual([{ day: "25-09-2026", problem: '"25-09-2026" is not a day (YYYY-MM-DD)' }]);
    expect(await readTextFileIfExists(h.vault.day("2026-09-25"))).toContain("[[2026-09-25-0900-nouva]]");
  });
});
