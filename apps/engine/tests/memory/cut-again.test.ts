/**
 * Cutting twice cuts once. Where a chat was last cut is read from the vault — where its latest episode ended — and
 * nothing else: a cursor in the database once said it a second time, and either could fall behind the other — a
 * crash before the cursor moved, a database restored without the vault, a cursor row lost, `/new` while the nightly
 * pass cut. Each of those filed the same conversation a second time, as `…-2`, at the cost of a model call a copy.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withoutStaleOpening, type Entry } from "@/modules/memory/cut.ts";
import { settledBy } from "@/modules/memory/run.ts";
import { FAMILY, GADING_DM, at, household, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

const ids = () => h.memory.episodes({}, 100).map((episode) => episode.id).sort();
const transcripts = async () => (await Promise.all(ids().map(async (id) => (await h.memory.episode(id))?.episode.transcript ?? ""))).join("\n");
const once = async (line: string) => (await transcripts()).split(line).length - 1;

describe("a mission's conversation", () => {
  test("is never cut: it is a work log, and the mission files what lasts of it once, from its report (0.8.0)", async () => {
    const mission = { gatewayId: "web:mission", chatId: "msn_0123456789abcdef0123", senderId: GADING_DM.senderId, chatType: "dm" as const };
    h.dm(mission, "nouva", "MISSION msn_0123 — turn 1", "Planned.", at(9));
    expect(await h.memory.cut(mission.gatewayId, mission.chatId)).toBe(0);
    expect(ids()).toEqual([]);
  });
});

describe("a cut that runs again", () => {
  test("starts where the chat's latest episode ends, and files nothing twice", async () => {
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    expect(await h.memory.cutAll()).toBe(1);
    expect(await h.memory.cutAll()).toBe(0);

    h.dm(GADING_DM, "nouva", "Kalau RAM 2GB?", "Masih bisa.", at(10));
    expect(await h.memory.cutAll()).toBe(1);
    expect(await h.memory.cut(GADING_DM.gatewayId, GADING_DM.chatId)).toBe(0);
    expect(ids()).toEqual(["2026-09-25-0900-nouva", "2026-09-25-1000-nouva"]);
  });

  test("a clock set back cuts nothing a second time — not until it passes where the chat was cut", async () => {
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    h.dm(GADING_DM, "nouva", "Kalau RAM 2GB?", "Masih bisa.", at(10));
    h.clock.now = at(11);
    expect(await h.memory.cutAll()).toBe(1);
    // A box with no clock of its own, started before it has the time: 09:30, before the episode just cut ends. The
    // vault's end is the only thing that says this chat was cut; taken for a hand edit, the cut started from nothing.
    h.clock.now = at(9, 30);
    expect(await h.memory.cutAll()).toBe(0);
    h.clock.now = at(12);
    h.dm(GADING_DM, "nouva", "Pakai SD card 32GB cukup?", "Cukup.", at(11, 30));
    expect(await h.memory.cutAll()).toBe(1);
    expect(ids()).toEqual(["2026-09-25-0900-nouva", "2026-09-25-1130-nouva"]);
  });

  test("an episode's last line, later in its second than its `ended` says, is not cut again", async () => {
    // `ended` is written to the second: a cut from it alone read a line said 600 ms into that second back out of the room log.
    h.group(FAMILY, "@nouva lampu teras jam berapa?", at(13, 0), { agentId: "nouva", text: "Jam 22:00." });
    h.group(FAMILY, "Makasih ya", at(13, 1) + 600);
    h.clock.now = at(13, 30);
    expect(await h.memory.cutAll()).toBe(1);
    h.group(FAMILY, "@nouva besok hujan?", at(15, 0), { agentId: "nouva", text: "Cerah berawan." });
    h.clock.now = at(15, 30);
    expect(await h.memory.cutAll()).toBe(1);
    expect(await once("Makasih ya")).toBe(1);
  });

  test("an answer that finished after another turn began waits for the next cut, so nothing is skipped", async () => {
    // Two agents in one group: nix's answer comes in after nouva's turn has started, and nouva is still working when
    // the chat is cut. A cut that took nix's answer and stopped before nouva's turn would end its episode past where
    // it stopped — and the next cut, starting from that episode's end, would start past nouva's turn.
    h.group(FAMILY, "Lampu teras jam berapa matinya?", at(13, 0));
    h.exchanges.push({ gatewayId: FAMILY.gatewayId, chatId: FAMILY.chatId, agentId: "nix", senderId: FAMILY.senderId, prompt: "Lampu teras jam berapa matinya?", reply: "Jam 22:00.", startedAt: at(13, 0), endedAt: at(13, 20) });
    h.group({ ...FAMILY, senderId: "62877" }, "@nouva besok hujan?", at(13, 10));
    h.exchanges.push({ gatewayId: FAMILY.gatewayId, chatId: FAMILY.chatId, agentId: "nouva", senderId: "62877", prompt: "@nouva besok hujan?", reply: "", startedAt: at(13, 10), endedAt: at(13, 10), running: true });

    h.clock.now = at(13, 25);
    expect(await h.memory.cutAll()).toBe(0);

    const nouva = h.exchanges.at(-1)!;
    nouva.running = false;
    nouva.reply = "Cerah berawan.";
    nouva.endedAt = at(13, 30);
    h.clock.now = at(14, 0);
    expect(await h.memory.cutAll()).toBe(1);
    expect(await h.memory.cutAll()).toBe(0);

    for (const line of ["Lampu teras jam berapa matinya?", "Jam 22:00.", "@nouva besok hujan?", "Cerah berawan."]) expect(await once(line)).toBe(1);
  });

  test("two cuts at once choose two ids: one waits for the other, so neither file is written over", async () => {
    // A DM and a group with the same agent, starting the same minute: the same first choice of id.
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    h.group(FAMILY, "@nouva lampu teras?", at(9), { agentId: "nouva", text: "Jam 22:00." });
    const cut = await Promise.all([h.memory.cut(GADING_DM.gatewayId, GADING_DM.chatId), h.memory.cut(FAMILY.gatewayId, FAMILY.chatId)]);
    expect(cut).toEqual([1, 1]);
    expect(ids()).toEqual(["2026-09-25-0900-nouva", "2026-09-25-0900-nouva-2"]);
    expect(await transcripts()).toContain("Bisa, pakai Termux.");
    expect(await transcripts()).toContain("Jam 22:00.");
  });
});

describe("a group's talk no agent was part of", () => {
  test("is not read at all while no agent has said anything since the chat's latest episode", async () => {
    let reads = 0;
    h.close();
    h = await household({ source: (logs) => ({ ...logs, roomMessagesBetween: (...args) => (reads++, logs.roomMessagesBetween(...args)) }) });
    h.group(FAMILY, "@nouva lampu teras?", at(9), { agentId: "nouva", text: "Jam 22:00." });
    expect(await h.memory.cutAll()).toBe(1);
    reads = 0;
    h.group(FAMILY, "Nanti malam makan di mana?", at(20));
    h.clock.now = at(23, 0, 26);
    expect(await h.memory.cutAll()).toBe(0);
    expect(reads).toBe(0);
  });

  test("opens the next conversation only from the day before the agent's reply", async () => {
    h.group(FAMILY, "@nouva lampu teras?", at(9), { agentId: "nouva", text: "Jam 22:00." });
    h.clock.now = at(10);
    expect(await h.memory.cutAll()).toBe(1);
    // Two quiet days of the family's own talk, then a question to the agent the evening after.
    h.group(FAMILY, "Arisan minggu depan di rumah Tante", at(12, 0, 26));
    h.group(FAMILY, "Siap, aku bawa kue", at(19, 0, 27));
    h.group(FAMILY, "@nouva besok hujan?", at(18, 0, 28), { agentId: "nouva", text: "Cerah berawan." });
    h.clock.now = at(23, 0, 28);
    expect(await h.memory.cutAll()).toBe(1);
    const said = await transcripts();
    expect(said).toContain("Siap, aku bawa kue");
    expect(said).not.toContain("Arisan minggu depan");
  });
});

describe("where a cut may stop", () => {
  const turn = (startedAt: number, endedAt: number) => ({ startedAt, endedAt });

  test("where it was asked to, when every turn begun by then had finished by then", () => {
    expect(settledBy([turn(10, 20), turn(30, 40)], 50)).toBe(50);
  });

  test("before a turn that began by then and finished after it", () => {
    expect(settledBy([turn(10, 20), turn(30, 60)], 50)).toBe(29);
  });

  test("further back, when stopping before one turn leaves another across the line", () => {
    expect(settledBy([turn(10, 35), turn(30, 60)], 50)).toBe(9);
  });
});

describe("where a conversation opens", () => {
  const said = (at: number, agent = false): Entry => ({ at, who: agent ? "nouva" : "gading", name: agent ? "nouva" : "Gading", agent, text: String(at) });
  const DAY = 86_400_000;

  test("what people said up to a day before the first reply stays, and everything after it", () => {
    const entries = [said(0), said(2 * DAY), said(3 * DAY - 10), said(3 * DAY, true), said(5 * DAY), said(6 * DAY, true)];
    expect(withoutStaleOpening(entries).map((entry) => entry.at)).toEqual([2 * DAY, 3 * DAY - 10, 3 * DAY, 5 * DAY, 6 * DAY]);
  });

  test("with no reply at all, nothing is taken away — it is no episode either way", () => {
    expect(withoutStaleOpening([said(0), said(5 * DAY)])).toHaveLength(2);
  });
});
