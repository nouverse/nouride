/**
 * From the turn log to an indexed episode: a DM and a group cut into episodes, written, indexed, and
 * found by who may see them — the SQL scope agreeing with the access rule.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTextFileIfExists, removePath, writeTextFile, type SqliteDb } from "@nouride/runtime";
import type { Person } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { audienceOf, canSeeEpisode, scopeOf } from "@/modules/memory/access.ts";
import { entriesOf, episodesOf, type ChatSource } from "@/modules/memory/cut.ts";
import { readEpisode } from "@/modules/memory/episodes.ts";
import { indexedEpisode, syncIndex } from "@/modules/memory/index-sync.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { vaultAt, type Vault } from "@/modules/memory/vault.ts";
import { tempDir } from "../helpers.ts";
import { plant } from "./fixture.ts";

const TZ = "Asia/Jakarta";
const at = (hh: number, mm: number) => Date.UTC(2026, 8, 25, hh - 7, mm);
const people: Person[] = [
  { key: "gading", ids: ["telegram:814"], name: "Gading" },
  { key: "sam", ids: ["telegram:777"], name: "Kak Sam" },
];

const source: ChatSource = {
  exchangesBetween: (gatewayId, chatId) =>
    chatId === "814"
      ? [
          { agentId: "nouva", senderId: "814", prompt: "Nouride bisa di android lawas?", reply: "Bisa, pakai Termux.", startedAt: at(4, 59), endedAt: at(5, 0) },
          { agentId: "nouva", prompt: "(reminder)", reply: "Jangan lupa minum air.", startedAt: at(6, 0), endedAt: at(6, 0) },
        ]
      : chatId === "-1001" && gatewayId === "telegram:nouva"
        ? [{ agentId: "nix", senderId: "777", prompt: "@nix lampu teras?", reply: "Mati jam 22:00.", startedAt: at(13, 10), endedAt: at(13, 11) }]
        : [],
  roomMessagesBetween: (_gatewayId, chatId) =>
    chatId === "-1001"
      ? [
          { senderId: "814", text: "Lampu teras jam berapa matinya?", at: at(13, 9) },
          { senderId: "777", senderName: "Sam", text: "@nix lampu teras?", at: at(13, 10) },
        ]
      : [],
  isRoom: (_gatewayId, chatId) => chatId === "-1001",
};

let dir: string;
let db: SqliteDb;
let vault: Vault;
let index: MemoryIndexStore;

beforeEach(async () => {
  dir = tempDir("episodes");
  db = await openAndMigrate(join(dir, "test.db"));
  vault = vaultAt(join(dir, "memory"));
  index = new MemoryIndexStore(db);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

function cut(chatId: string, group?: string) {
  const chat = { gatewayId: "telegram:nouva", chatId };
  const { kind, entries } = entriesOf(source, people, chat, 0, at(23, 59));
  return episodesOf({ chat, kind, entries, timeZone: TZ, ...(group ? { group } : {}), taken: () => false });
}

describe("cutting a chat", () => {
  test("a DM: each question and answer, named; a reminder with nobody asking adds only its reply", () => {
    const [episode, ...rest] = cut("814");
    expect(rest).toEqual([]);
    expect(episode).toMatchObject({
      id: "2026-09-25-0459-nouva",
      status: "raw",
      kind: "dm",
      chat: "telegram:nouva:814",
      day: "2026-09-25",
      started: "2026-09-25T04:59:00+07:00",
      agents: ["nouva"],
      people: ["gading"],
    });
    expect(episode!.transcript).toBe(
      "04:59 · Gading\nNouride bisa di android lawas?\n\n05:00 · nouva\nBisa, pakai Termux.\n\n06:00 · nouva\nJangan lupa minum air.\n",
    );
  });

  test("a group: people from the room log, once; agents from their replies", () => {
    const [episode] = cut("-1001", "keluarga");
    expect(episode).toMatchObject({ kind: "group", group: "keluarga", agents: ["nix"], people: ["gading", "sam"] });
    expect(episode!.transcript.match(/@nix lampu teras\?/g)).toHaveLength(1);
  });

  test("a long stretch splits at entry boundaries into linked episodes; a piece with no agent joins its neighbour", () => {
    const chat = { gatewayId: "telegram:nouva", chatId: "814" };
    const long = "x".repeat(60);
    const entries = [
      { at: at(9, 0), who: "gading", name: "Gading", agent: false, text: long },
      { at: at(9, 1), who: "nouva", name: "nouva", agent: true, text: long },
      { at: at(9, 2), who: "gading", name: "Gading", agent: false, text: long },
      { at: at(9, 3), who: "nouva", name: "nouva", agent: true, text: long },
      { at: at(9, 4), who: "gading", name: "Gading", agent: false, text: long },
    ];
    const episodes = episodesOf({ chat, kind: "dm", entries, timeZone: TZ, taken: (id) => id === "2026-09-25-0900-nouva", maxChars: 150 });
    expect(episodes.map((episode) => episode.id)).toEqual(["2026-09-25-0900-nouva-2", "2026-09-25-0902-nouva"]);
    expect(episodes[1]!.transcript.startsWith("09:02 · Gading")).toBe(true);
    expect(episodes[0]!.related).toEqual(["2026-09-25-0902-nouva"]);
    expect(episodes[1]!.related).toEqual(["2026-09-25-0900-nouva-2"]);
    expect(episodes[1]!.transcript).toContain("09:04 · Gading");
  });

  test("nobody but agents and reminders is not an episode", () => {
    const chat = { gatewayId: "telegram:nouva", chatId: "1" };
    expect(episodesOf({ chat, kind: "dm", entries: [{ at: at(8, 0), who: "nouva", name: "nouva", agent: true, text: "ping" }], timeZone: TZ, taken: () => false })).toEqual([]);
  });
});

describe("written, indexed, found", () => {
  test("the file round-trips and the index is rebuilt from it; a hand edit is re-read, a deleted file dropped", async () => {
    const dm = cut("814")[0]!;
    const group = cut("-1001", "keluarga")[0]!;
    plant(vault, dm);
    plant(vault, group);
    expect(await readEpisode(vault, dm.id)).toEqual(dm);

    expect(await syncIndex(vault, index)).toMatchObject({ episodes: 2, dropped: 0, problems: [] });
    expect(await syncIndex(vault, index)).toMatchObject({ episodes: 0 });
    expect(index.episodesById([dm.id])).toEqual([indexedEpisode(dm)]);

    const file = vault.episode(dm.id);
    await writeTextFile(file, ((await readTextFileIfExists(file)) ?? "").replace("status: raw", "status: summarized").replace("kind: dm", 'summary: "Termux di android."\nkind: dm'));
    expect(await syncIndex(vault, index)).toMatchObject({ episodes: 1 });
    expect(index.episodesById([dm.id])[0]).toMatchObject({ status: "summarized", summary: "Termux di android." });

    removePath(file);
    expect(await syncIndex(vault, index)).toMatchObject({ dropped: 1 });
    expect(index.episodesById([dm.id])).toEqual([]);
  });

  test("the SQL scope and the access rule give the same answer, for every audience", async () => {
    const episodes = [cut("814")[0]!, cut("-1001", "keluarga")[0]!];
    for (const episode of episodes) plant(vault, episode);
    await syncIndex(vault, index);
    const audiences = [
      audienceOf({ chat: "telegram:nouva:814", chatType: "dm", person: "gading" }),
      audienceOf({ chat: "telegram:nix:777", chatType: "dm", person: "sam" }),
      audienceOf({ chat: "telegram:nix:999", chatType: "dm", person: "telegram:999" }),
      audienceOf({ chat: "telegram:nouva:-1001", chatType: "group", person: "gading" }),
      audienceOf({ chat: "telegram:nouva:-2002", chatType: "group", person: "gading" }),
    ];
    for (const audience of audiences) {
      const bySql = index.episodes({ scope: scopeOf(audience) }, 100).map((episode) => episode.id).sort();
      const byRule = episodes.filter((episode) => canSeeEpisode(episode, audience)).map((episode) => episode.id).sort();
      expect(bySql).toEqual(byRule);
    }
  });
});
