/**
 * Another chat's talk before it is cut into memory (`live.ts`): seen from a person's direct chat where they took part,
 * found by a search, opened by its id, and nowhere it would not be once cut.
 *
 * Asked in a direct chat what was decided in a group an hour before, an agent said it could not see the group and had
 * to be asked there: the group's talk waited for the nightly pass to become memory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recordDeleted } from "@/modules/memory/deleted.ts";
import { FAMILY, GADING_DM, SAM_DM, at, household, speaker, type Household } from "./fixture.ts";

let h: Household;
beforeEach(async () => {
  h = await household();
  h.clock.now = at(20, 0);
  // A person in the family group with an agent this afternoon, not cut: no /new, no nightly pass yet.
  h.group(FAMILY, "nouva, which provider for the client pods? dalang or sumopod?", at(17, 20), { agentId: "nouva", text: "Dalang: it has a CLI and prepaid credit, Sumopod has no API." });
  h.group(FAMILY, "ok mark the pod products out of stock then", at(17, 40), { agentId: "nouva", text: "Done, every pod product is out of stock." });
});
afterEach(() => h.close());

describe("from the direct chat of someone who took part", () => {
  test("the prompt names it among the conversations not summarized yet, by an id that opens it", async () => {
    // The direct chat's own talk is its history already, and is not named again.
    h.dm(GADING_DM, "nouva", "what did we decide in the group?", "Let me look.", at(19, 0));
    const waiting = h.memory.recall(speaker(GADING_DM)).waiting;
    expect(waiting.length).toBe(1);
    expect(waiting[0]).toMatchObject({ preview: "nouva, which provider for the client pods? dalang or sumopod?" });
    const opened = await h.memory.read(speaker(GADING_DM), waiting[0]!.id);
    expect("refused" in opened).toBe(false);
    const transcript = (opened as { transcript: string }).transcript;
    expect(transcript).toContain("Dalang: it has a CLI and prepaid credit");
    expect(transcript).toContain("every pod product is out of stock");
  });

  test("a search finds it by a word said there, in the language it was said", async () => {
    const found = await h.memory.search(speaker(GADING_DM), { query: "sumopod" });
    expect(found.map((hit) => (hit.kind === "episode" ? hit.episode.chat : hit.kind))).toEqual(["whatsapp:main:1203@g.us"]);
    expect(await h.memory.search(speaker(GADING_DM), { query: "durian" })).toEqual([]);
  });

  test("named the same while it grows: the prompt's cached memory block is not changed by each message there", async () => {
    const before = h.memory.recall(speaker(GADING_DM)).waiting;
    h.group(FAMILY, "and the backend stays on the homelab?", at(18, 10), { agentId: "nouva", text: "Yes, it stays there." });
    expect(h.memory.recall(speaker(GADING_DM)).waiting).toEqual(before);
    // What was said since is in it when it is opened.
    expect(((await h.memory.read(speaker(GADING_DM), before[0]!.id)) as { transcript: string }).transcript).toContain("the backend stays on the homelab");
  });

  test("once it is cut, it is memory's own: named once, under the same id", async () => {
    const before = h.memory.recall(speaker(GADING_DM)).waiting.map((one) => one.id);
    await h.memory.cut(FAMILY.gatewayId, FAMILY.chatId);
    const after = h.memory.recall(speaker(GADING_DM)).waiting.map((one) => one.id);
    expect(after).toEqual(before);
  });
});

describe("where it would not be seen once cut", () => {
  test("not from the direct chat of someone who was not there", async () => {
    expect(h.memory.recall(speaker(SAM_DM, "nix")).waiting).toEqual([]);
    expect(await h.memory.search(speaker(SAM_DM, "nix"), { query: "sumopod" })).toEqual([]);
    const id = h.memory.recall(speaker(GADING_DM)).waiting[0]!.id;
    expect(await h.memory.read(speaker(SAM_DM, "nix"), id)).toMatchObject({ refused: expect.stringContaining("that this chat may see") });
  });

  test("not in another group, nor as the group's own: its own talk is its conversation's history already", async () => {
    expect(h.memory.recall(speaker(FAMILY)).waiting).toEqual([]);
    expect(await h.memory.search(speaker(FAMILY), { query: "sumopod" })).toEqual([]);
  });

  test("not what was deleted from it: a deleted conversation stays deleted until it is cut", async () => {
    await recordDeleted(h.vault, [{ chat: "whatsapp:main:1203@g.us", endedAt: at(17, 50) }]);
    expect(h.memory.recall(speaker(GADING_DM)).waiting).toEqual([]);
    expect(await h.memory.search(speaker(GADING_DM), { query: "sumopod" })).toEqual([]);
  });

  test("not past a day: what is older waits for the pass, as before", async () => {
    h.clock.now = at(23, 0, 27);
    expect(h.memory.recall(speaker(GADING_DM)).waiting).toEqual([]);
  });
});
