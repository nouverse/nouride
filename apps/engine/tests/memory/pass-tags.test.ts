/**
 * The nightly pass and the vault's 0.7 shape, end to end on a household: what the model is shown, what
 * its answer is filed as, what it is asked again, what the morning report says — an episode still in
 * 0.6's shape reported rather than read, and the stubs nothing shares removed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureDir, readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import { episodeFiles } from "@/modules/memory/episodes.ts";
import { tagStub } from "@/modules/memory/graph.ts";
import { GADING_DM, at, household, scripted, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

/** Twenty-four filed conversations, a day apart, sharing tags — so the admin's audience is settled (one new tag each). */
async function settle(): Promise<void> {
  for (let day = 1; day <= 24; day += 1) h.dm(GADING_DM, "nouva", `homelab note ${day}`, "Oke.", at(10, 0, day));
  h.clock.now = at(23, 0, 24);
  await h.memory.pass(scripted([{ when: "homelab note", answer: { summary: "A homelab note about the Proxmox server.", tags: ["homelab", "proxmox"] } }]).ask);
}

describe("what the pass shows and files", () => {
  test("the rules and the vocabulary are two cached system blocks, the same for every conversation the audience shares", async () => {
    await settle();
    h.dm(GADING_DM, "nouva", "Backup NAS jalan?", "Jalan.", at(9, 0, 25));
    h.dm(GADING_DM, "nouva", "Restore NAS gimana?", "Begini.", at(9, 0, 26));
    h.clock.now = at(23, 30, 26);
    const model = scripted([]);
    await h.memory.pass(model.ask);
    const backup = model.asked.find((ask) => ask.user.includes("Backup NAS"))!;
    const restore = model.asked.find((ask) => ask.user.includes("Restore NAS"))!;

    // Each block ends in a breakpoint, so the second conversation reads both from the cache.
    expect(backup.blocks).toHaveLength(2);
    expect(backup.blocks[0]!.cache).toBe(true);
    expect(backup.blocks[0]!.text).toStartWith("You file one finished conversation");
    expect(backup.blocks[1]).toEqual({ text: "Known tags, most used first: homelab, proxmox.", cache: true });
    expect(restore.blocks).toEqual(backup.blocks);
    // What differs from one conversation to the next is after them, in the user message.
    expect(backup.user).not.toContain("Known tags");
    expect(backup.user.split("\n")[0]).toBe("This chat's recent tags: homelab, proxmox.");
    expect(backup.user).not.toEqual(restore.user);
  });

  test("a settled audience coins one new tag, whatever the model proposed, and the report names it with its nearest", async () => {
    await settle();
    h.dm(GADING_DM, "nouva", "Pasang CCTV di garasi", "Siap.", at(9));
    h.clock.now = at(23, 30);
    const answer = { summary: "Gading set up a CCTV camera in the garage.", tags: ["homelab", "cctv", "garage", "security-camera"], new_tag: { name: "cctv", closest_known: "homelab" } };
    const report = await h.memory.pass(scripted([{ when: "CCTV", answer }]).ask);
    const episode = h.memory.episodes({}, 50).find((e) => e.summary?.includes("CCTV"));
    expect(episode?.tags.toSorted()).toEqual(["cctv", "homelab"]);
    expect(report.tags).toMatchObject({ created: 1, dropped: 2 });
    expect(report.newTags).toEqual([{ tag: "cctv", episode: episode!.id, closest: "homelab" }]);
  });

  test("an answer not in English is asked for once more, and kept when it comes back English", async () => {
    h.dm(GADING_DM, "nouva", "Aku mau liburan ke Bali", "Oke.", at(9));
    const model = scripted([
      { when: "Not in English", answer: { summary: "Gading wants a holiday in Bali.", tags: ["travel"] } },
      { when: "Bali", answer: { summary: "Gading mau liburan ke Bali dan sudah tanya tiket.", tags: ["travel"] } },
    ]);
    const report = await h.memory.pass(model.ask);
    expect(report).toMatchObject({ filed: 1, failed: [] });
    expect(model.asked).toHaveLength(2);
    expect(h.memory.episodes({}, 10)[0]?.summary).toBe("Gading wants a holiday in Bali.");
  });

  test("an answer still not in English is not filed: the episode stays raw for the next night", async () => {
    h.dm(GADING_DM, "nouva", "Aku mau liburan ke Bali", "Oke.", at(9));
    const report = await h.memory.pass(scripted([{ when: "Bali", answer: { summary: "Gading mau liburan ke Bali dan sudah tanya tiket." } }]).ask);
    expect(report.failed).toEqual([{ episode: "2026-09-25-0900-nouva", reason: "the summary was not in English, asked twice" }]);
    expect(h.memory.episodes({}, 10)[0]?.status).toBe("raw");
  });
});

describe("the vault's shape", () => {
  test("an episode still linking its day flat, as 0.6 did, is reported with the link to write — not filed under that day", async () => {
    h.dm(GADING_DM, "nouva", "Halo", "Hai.", at(9));
    await h.memory.pass(scripted([{ when: "Halo", answer: { summary: "Gading said hello." } }]).ask);
    // A file copied back from a 0.6 vault: its day linked where 0.6 kept the hub.
    const file = episodeFiles(h.vault)[0]!.file;
    const text = (await readTextFileIfExists(file))!;
    await writeTextFile(file, text.replace("[[days/2026/09/2026-09-25]]", "[[days/2026-09-25]]"));

    const report = await h.memory.reindex();
    expect(report.problems.map((found) => found.problem)).toEqual(['day "days/2026-09-25" is not where its hub is: link it as [[days/2026/09/2026-09-25]]']);
    expect(h.memory.episodes({}, 10)).toEqual([]);
  });

  test("a stub nothing shares goes when untouched, and stays when someone wrote in it", async () => {
    ensureDir(h.vault.tagsDir);
    await writeTextFile(h.vault.tag("lonely"), tagStub());
    await writeTextFile(h.vault.tag("edited"), tagStub().replace("type: tag", "type: tag\naliases: [solo]"));
    expect(await h.memory.pruneStubs()).toBe(1);
    expect(await readTextFileIfExists(h.vault.tag("lonely"))).toBeNull();
    expect(await readTextFileIfExists(h.vault.tag("edited"))).toContain("solo");
  });
});
