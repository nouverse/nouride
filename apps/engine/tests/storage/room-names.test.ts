/**
 * A room's name (0.7.24): the store, and `roomName` — the one place
 * a room's name is read: a dashboard room's own title, else the operator's rename, else the platform's, else nothing.
 * And when the platform is asked: when there is no name yet or it is a day old, never per message.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { RoomNameStore, roomName } from "@/modules/rooms/room-names.store.ts";
import { tempDir } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function database(): Promise<SqliteDb> {
  const dir = tempDir("room-names");
  const db = await openAndMigrate(join(dir, "data", "nouride.db"));
  cleanup.push(() => {
    db.close();
    removePath(dir);
  });
  return db;
}

describe("the name of a room", () => {
  test("the operator's rename, over the platform's; cleared, the platform's again; neither, nothing", async () => {
    const db = await database();
    const names = new RoomNameStore(db);
    const room = { gatewayId: "discord:main", platform: "discord", chatId: "300" };

    expect(roomName({ roomNames: names }, room)).toBeUndefined();
    names.setPlatformTitle("discord", "300", "#general");
    expect(roomName({ roomNames: names }, room)).toBe("#general");
    names.choose("discord", "300", "Ruang Keluarga");
    expect(roomName({ roomNames: names }, room)).toBe("Ruang Keluarga");
    // The platform renaming the channel does not undo the operator's name.
    names.setPlatformTitle("discord", "300", "#umum");
    expect(roomName({ roomNames: names }, room)).toBe("Ruang Keluarga");
    names.choose("discord", "300", "  ");
    expect(roomName({ roomNames: names }, room)).toBe("#umum");
  });

  test("keyed by the room as the platform sees it: every bot of ours in it reads one name", async () => {
    const db = await database();
    const names = new RoomNameStore(db);
    names.setPlatformTitle("telegram", "-100", "Keluarga");
    expect(roomName({ roomNames: names }, { gatewayId: "telegram:nouva", platform: "telegram", chatId: "-100" })).toBe("Keluarga");
    expect(roomName({ roomNames: names }, { gatewayId: "telegram:nox", platform: "telegram", chatId: "-100" })).toBe("Keluarga");
    expect(roomName({ roomNames: names }, { gatewayId: "discord:main", platform: "discord", chatId: "-100" })).toBeUndefined();
  });

  test("a dashboard room is named by its own title, never by this table", async () => {
    const db = await database();
    const rooms = new RoomStore(db);
    const names = new RoomNameStore(db);
    rooms.create({ gatewayId: "local:dev", chatId: "web-1", agentIds: ["nouva"], title: "Planning" });
    names.choose("web", "web-1", "Not this");
    expect(roomName({ rooms, roomNames: names }, { gatewayId: "local:dev", platform: "web", chatId: "web-1" })).toBe("Planning");
  });
});

describe("asking the platform", () => {
  async function setUp() {
    const db = await database();
    let now = 1_000_000;
    const names = new RoomNameStore(db, () => now);
    const asked: string[] = [];
    let answer: string | undefined = "#general";
    const gateway = {
      platform: "discord" as const,
      roomTitle: async (chatId: string) => {
        asked.push(chatId);
        return answer;
      },
    };
    return { names, asked, gateway, later: (ms: number) => (now += ms), answers: (title: string | undefined) => (answer = title) };
  }

  test("once while it has a name, and again a day later", async () => {
    const { names, asked, gateway, later, answers } = await setUp();
    await names.refresh(gateway, "300");
    await names.refresh(gateway, "300");
    later(60 * 60_000);
    await names.refresh(gateway, "300");
    expect(asked).toEqual(["300"]);
    expect(names.get("discord", "300")?.platformTitle).toBe("#general");

    answers("#umum");
    later(24 * 60 * 60_000);
    await names.refresh(gateway, "300");
    expect(asked).toEqual(["300", "300"]);
    expect(names.get("discord", "300")?.platformTitle).toBe("#umum");
  });

  test("a platform that has nothing to say is not asked per message, and is asked again later", async () => {
    const { names, asked, gateway, later, answers } = await setUp();
    answers(undefined);
    await names.refresh(gateway, "300");
    await names.refresh(gateway, "300");
    expect(asked).toEqual(["300"]);
    expect(names.get("discord", "300")).toBeUndefined();
    answers("#general");
    later(2 * 60_000);
    await names.refresh(gateway, "300");
    expect(names.get("discord", "300")?.platformTitle).toBe("#general");
  });

  test("an adapter without the capability is never asked, and one that throws fails nothing", async () => {
    const { names } = await setUp();
    await names.refresh({ platform: "web" }, "x");
    await names.refresh({ platform: "discord", roomTitle: async () => { throw new Error("missing access"); } }, "300");
    expect(names.get("discord", "300")).toBeUndefined();
  });
});
