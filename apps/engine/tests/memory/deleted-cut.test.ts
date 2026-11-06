/**
 * A conversation deleted on purpose is not filed again by the next cut.
 *
 * Found in 0.7.9's run on the live box: with the chat's cursor wiped, or the database restored to a snapshot from
 * before the cut, the next cut started where the chat's latest episode ends — and an episode the operator had deleted
 * was no longer there to say so. The turn log still held the conversation, so it was cut and filed again. A cut now
 * always starts where the vault says, and a deleted episode leaves where it ended there (`deleted.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recordDeleted, renameDeletedChats } from "@/modules/memory/deleted.ts";
import { GADING_DM, SAM_DM, at, household, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

const ids = () => h.memory.episodes({}, 100).map((episode) => episode.id).sort();
const transcripts = async () => (await Promise.all(ids().map(async (id) => (await h.memory.episode(id))?.episode.transcript ?? ""))).join("\n");

describe("a deleted conversation", () => {
  test("is not filed again by the next cut — and what is said after it still is", async () => {
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    h.dm(GADING_DM, "nouva", "Kalau RAM 2GB?", "Masih bisa.", at(10, 0, 26));
    h.clock.now = at(12, 0, 26);
    expect(await h.memory.cutAll()).toBe(2);
    // The chat's latest conversation, deleted on purpose.
    await h.memory.deleteEpisode("2026-09-26-1000-nouva");

    expect(await h.memory.cutAll()).toBe(0);
    expect(ids()).toEqual(["2026-09-25-0900-nouva"]);

    h.dm(GADING_DM, "nouva", "Pakai SD card 32GB cukup?", "Cukup.", at(13, 0, 26));
    h.clock.now = at(23, 0, 26);
    expect(await h.memory.cutAll()).toBe(1);
    expect(await transcripts()).not.toContain("Kalau RAM 2GB?");
  });

  test("is not filed again when it was the chat's only one — nor by a clock set back before it ended", async () => {
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    h.dm(GADING_DM, "nouva", "Kalau RAM 2GB?", "Masih bisa.", at(10));
    expect(await h.memory.cutAll()).toBe(1);
    await h.memory.deleteEpisode(ids()[0]!);
    expect(await h.memory.cutAll()).toBe(0);
    // Back to 09:30, between the deleted conversation's start and its end.
    h.clock.now = at(9, 30);
    expect(await h.memory.cutAll()).toBe(0);
    expect(ids()).toEqual([]);
  });

  test("leaves where it ended in the vault, by its chat — nothing it said", async () => {
    h.dm(GADING_DM, "nouva", "Kalau RAM 2GB?", "Masih bisa.", at(10));
    await h.memory.cutAll();
    await h.memory.deleteEpisode(ids()[0]!);
    const kept = JSON.parse(readFileSync(h.vault.deleted, "utf8")) as Record<string, string>;
    expect(Object.keys(kept)).toEqual([`${GADING_DM.gatewayId}:${GADING_DM.chatId}`]);
    expect(Date.parse(Object.values(kept)[0]!)).toBeGreaterThanOrEqual(at(10));
    expect(readFileSync(h.vault.deleted, "utf8")).not.toContain("RAM");
  });
});

describe("forgetting someone", () => {
  test("cuts every chat first, and the next cut does not file their conversations back", async () => {
    h.dm(SAM_DM, "nix", "Aku alergi udang.", "Dicatat.", at(9));
    h.clock.now = at(10);
    await h.memory.cutAll();
    // Said since the last cut: the forget cuts it first, so it is deleted with the rest.
    h.dm(SAM_DM, "nix", "Besok aku ke Bandung.", "Hati-hati.", at(15));
    h.clock.now = at(16);

    const report = await h.memory.forget("sam", "forget");
    expect(report).toMatchObject({ episodesDeleted: 2 });
    expect(ids()).toEqual([]);

    h.clock.now = at(23);
    expect(await h.memory.cutAll()).toBe(0);
    expect(ids()).toEqual([]);
  });
});

describe("where a chat's deleted conversations ended", () => {
  test("never moves back", async () => {
    const vault = h.vault;
    await recordDeleted(vault, [{ chat: "telegram:nouva:814", endedAt: at(12) }]);
    await recordDeleted(vault, [{ chat: "telegram:nouva:814", endedAt: at(9) }]);
    const kept = JSON.parse(readFileSync(vault.deleted, "utf8")) as Record<string, string>;
    expect(Date.parse(kept["telegram:nouva:814"]!)).toBeGreaterThanOrEqual(at(12));
  });

  test("moves with a renamed gateway, and leaves every other chat as it was", () => {
    const text = `${JSON.stringify({ "telegram:bot:814": "2026-09-25T03:00:00.999Z", "discord:main:9": "2026-09-25T04:00:00.999Z" })}\n`;
    const moved = JSON.parse(renameDeletedChats(text, "telegram:bot", "telegram:nouva")) as Record<string, string>;
    expect(moved).toEqual({ "discord:main:9": "2026-09-25T04:00:00.999Z", "telegram:nouva:814": "2026-09-25T03:00:00.999Z" });
    expect(renameDeletedChats(text, "whatsapp:x", "whatsapp:y")).toBe(text);
  });
});
