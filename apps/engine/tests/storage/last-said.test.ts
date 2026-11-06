/**
 * What a person last wrote in a chat (`TurnStore.lastSaid`, 0.8.8) — what a mission's page quotes so its report reaches
 * them in their language. Each row here is one it must pass over: a command, a wake-up, another agent asked on their
 * behalf, another person, another chat.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let turns: EventedTurnStore;
beforeEach(async () => {
  dir = tempDir("last-said");
  db = await openAndMigrate(join(dir, "test.db"));
  turns = new EventedTurnStore(db, new EventStore(db, Date.now, { strict: true }));
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const chat = { agentId: "nix", gatewayId: "telegram:nix", chatId: "8142", sessionId: "nix:telegram:nix:8142" };

function said(prompt: string, extra: { senderId?: string; chatId?: string; cause?: never; model?: string | null } = {}) {
  const id = turns.begin({ ...chat, senderId: "8142", ...extra, prompt });
  turns.finish(id, { status: "done", reply: "…", ...(extra.model === null ? {} : { model: extra.model ?? "Claude Code · Opus 5.5" }) });
}

describe("what a person last wrote in a chat", () => {
  test("their newest message a model answered — not a command, a wake-up, an ask on their behalf, nor anyone else's", () => {
    expect(turns.lastSaid("telegram:nix", "8142", "8142")).toBeNull();
    said("ya gas mulai masukin queue");
    said("/status", { model: null });
    said("/mission show msn_3d28e0");
    said("[System event — not a message from a person.]", { cause: { via: "job completion", job: "job_1" } as never });
    said("Continuation of job_0dd1: clean up the runner", { cause: { via: "ask_agent", job: "job_2", parent: "turn_1" } as never });
    said("ok", { senderId: "9999" });
    said("di chat lain", { chatId: "777" });
    expect(turns.lastSaid("telegram:nix", "8142", "8142")).toBe("ya gas mulai masukin queue");
    said("udah dipush?");
    expect(turns.lastSaid("telegram:nix", "8142", "8142")).toBe("udah dipush?");
    // The turn still running counts: the one that starts a mission is running when its page is first read — live, the
    // page quoted the message before it.
    turns.begin({ ...chat, senderId: "8142", prompt: "tes mission kedua: mulai mission" });
    expect(turns.lastSaid("telegram:nix", "8142", "8142")).toBe("tes mission kedua: mulai mission");
    expect(turns.lastSaid("telegram:nix", "777", "8142")).toBe("di chat lain");
  });
});
