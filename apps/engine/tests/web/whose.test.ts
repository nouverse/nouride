/**
 * Who is reading, and what each conversation is (`web/control/whose.ts`): an account is its person, every account of
 * theirs on every app; a conversation's kind decides who reads it; a stream's reader is read again as it runs.
 */

import { describe, expect, test } from "bun:test";
import { eventsFor, kindOf, mayOpen, readerNow, readerOf, sameReader, whoseAsked } from "@/modules/web/control/whose.ts";

const PEOPLE = [{ key: "rina", name: "Rina", ids: ["web:u2", "telegram:nouva:555"] }];
const rina = { kind: "user" as const, role: "operator" as const, user: { id: "u2", username: "rina" } };

describe("the reader", () => {
  test("is their person, every account of theirs in today's spelling; an account no person holds is itself", () => {
    expect(readerOf(rina as never, PEOPLE)).toEqual({ everyone: false, ids: ["web:u2", "telegram:555"], username: "rina", person: "rina" });
    expect(readerOf({ kind: "user", role: "viewer", user: { id: "u3", username: "tamu" } } as never, PEOPLE)).toEqual({ everyone: false, ids: ["web:u3"], username: "tamu" });
  });

  test("reads everyone's as an admin or the command line's token — and only asks for it where it may", () => {
    const admin = readerOf({ kind: "user", role: "admin", user: { id: "u1", username: "gading" } } as never, PEOPLE);
    const token = readerOf({ kind: "token", role: "admin" } as never, PEOPLE);
    expect([admin.everyone, token.everyone]).toEqual([true, true]);
    const rinaReads = readerOf(rina as never, PEOPLE);
    expect(whoseAsked(admin, undefined, PEOPLE)).toEqual({ kind: "mine" });
    expect(whoseAsked(admin, "everyone", PEOPLE)).toEqual({ kind: "everyone" });
    expect(whoseAsked(admin, "person:rina", PEOPLE)).toEqual({ kind: "person", ids: ["web:u2", "telegram:555"] });
    expect(whoseAsked(admin, "person:nobody", PEOPLE)).toEqual({ kind: "person", ids: [] });
    expect(whoseAsked(admin, "unknown", PEOPLE)).toEqual({ kind: "unknown", known: ["web:u2", "telegram:555"] });
    // The token is nobody: its own is everyone's.
    expect(whoseAsked(token, undefined, PEOPLE)).toEqual({ kind: "everyone" });
    for (const asked of ["everyone", "person:rina", "unknown"]) expect(whoseAsked(rinaReads, asked, PEOPLE)).toEqual({ kind: "mine" });
  });

  test("is read again as it is now: demoted, moved to another person, or gone, it is not the reader the stream opened for", () => {
    let account: { id: string; username: string; role: string } | null = { id: "u2", username: "rina", role: "admin" };
    const people = { current: PEOPLE as { key: string; name: string; ids: string[] }[] };
    const deps = { users: { byId: () => account }, ctx: { config: { get people() { return people.current; } } } };
    const opened = readerNow(deps as never, rina as never)!;
    expect(opened.everyone).toBe(true);
    expect(sameReader(opened, readerNow(deps as never, rina as never)!)).toBe(true);
    account = { id: "u2", username: "rina", role: "operator" };
    expect(sameReader(opened, readerNow(deps as never, rina as never)!)).toBe(false);
    account = { id: "u2", username: "rina", role: "admin" };
    people.current = [{ key: "rina", name: "Rina", ids: ["web:u2"] }];
    expect(sameReader(opened, readerNow(deps as never, rina as never)!)).toBe(false);
    account = null;
    expect(readerNow(deps as never, rina as never)).toBeNull();
  });
});

describe("what a conversation is", () => {
  const deps = {
    rooms: { get: (_: string, chatId: string) => (chatId === "room-1" ? { createdBy: "rina" } : null) },
    roomMessages: { isRoom: (_: string, chatId: string) => chatId === "-100", spokeIn: () => new Set<string>() },
    pipeline: { chatTypeOf: (_: string, chatId: string) => (chatId === "-200" ? "group" : chatId === "814" ? "dm" : undefined) },
    // The automations and the missions, as far as whose they are goes. Rina is `web:u2` and `telegram:555`.
    cron: {
      store: {
        get: (id: string) =>
          ({
            cron_hers: { owner: "web:u2", target: { gatewayId: "telegram:nouva", chatId: "814" }, delivery: { mode: "announce" } },
            cron_his: { owner: "web:u1", target: { gatewayId: "telegram:nouva", chatId: "814" }, delivery: { mode: "announce" } },
            cron_to_her: { owner: "web:u1", target: { gatewayId: "telegram:nix", chatId: "555" }, delivery: { mode: "announce" } },
            cron_nobodys: { target: { gatewayId: "telegram:nouva", chatId: "814" }, delivery: { mode: "announce" } },
          })[id] ?? null,
      },
    },
    missions: {
      get: (id: string) => ({ msn_hers: { owner: "telegram:555", gatewayId: "telegram:nix", chatId: "555" }, msn_his: { owner: "web:u1", gatewayId: "web:dashboard", chatId: "missions" } })[id] ?? null,
    },
    sessions: { openerOfChat: (_: string, chatId: string) => (chatId === "555" ? "telegram:555" : chatId === "814" ? "telegram:814" : undefined) },
  };

  test("a mission's, a scheduled job's, a room made here, a group with a log or one its messages called one, or private", () => {
    expect(kindOf(deps as never, "web:mission", "msn_1")).toBe("mission");
    expect(kindOf(deps as never, "telegram:nouva", "cron:cron_1")).toBe("job");
    expect(kindOf(deps as never, "web:dashboard", "room-1")).toBe("room");
    expect(kindOf(deps as never, "telegram:nouva", "-100")).toBe("group");
    expect(kindOf(deps as never, "telegram:nouva", "-200")).toBe("group");
    expect(kindOf(deps as never, "telegram:nouva", "814")).toBe("private");
    expect(kindOf({ ...deps, pipeline: undefined } as never, "web:dashboard", "web-1")).toBe("private");
  });

  test("opens, for someone not an admin: theirs and the rooms they made; never a chat nobody opened", () => {
    const reader = readerOf(rina as never, PEOPLE);
    const open = (gatewayId: string, chatId: string, openedBy?: string) => mayOpen(deps as never, reader, { gatewayId, chatId, openedBy });
    expect(open("telegram:nix", "555", "telegram:555")).toBe(true);
    expect(open("web:dashboard", "web-1", "web:u1")).toBe(false);
    expect(open("web:dashboard", "web-1")).toBe(false);
    expect(open("web:dashboard", "room-1")).toBe(true);
    expect(open("telegram:nouva", "-100", "telegram:555")).toBe(false);
  });

  test("an automation's own conversation and a mission's open for whoever sees the automation or the mission", () => {
    // Every account read these. Now: her own, and one that reports to her chat; not another person's, not one
    // nobody owns that reports elsewhere, and not one whose automation or mission is gone.
    const reader = readerOf(rina as never, PEOPLE);
    const open = (gatewayId: string, chatId: string) => mayOpen(deps as never, reader, { gatewayId, chatId });
    expect(open("telegram:nouva", "cron:cron_hers")).toBe(true);
    expect(open("telegram:nouva", "cron:cron_to_her")).toBe(true);
    expect(open("telegram:nouva", "cron:cron_his")).toBe(false);
    expect(open("telegram:nouva", "cron:cron_nobodys")).toBe(false);
    expect(open("telegram:nouva", "cron:cron_gone")).toBe(false);
    expect(open("web:mission", "msn_hers")).toBe(true);
    expect(open("web:mission", "msn_his")).toBe(false);
    expect(open("web:mission", "msn_gone")).toBe(false);
    // An admin opens every one, also what is left of one that is gone.
    const admin = readerOf({ kind: "user", role: "admin", user: { id: "u1", username: "gading", role: "admin" } } as never, PEOPLE);
    expect(mayOpen(deps as never, admin, { gatewayId: "telegram:nouva", chatId: "cron:cron_gone" })).toBe(true);
    expect(mayOpen(deps as never, admin, { gatewayId: "web:mission", chatId: "msn_his" })).toBe(true);
  });
});

describe("a stream's rows", () => {
  test("a chat is decided once, and again a little later: a group spoken in from now on is theirs from then", () => {
    let spoke = new Set<string>();
    let asked = 0;
    let now = 0;
    const deps = {
      rooms: { get: () => null },
      roomMessages: { isRoom: () => true, spokeIn: () => (asked++, spoke) },
      sessions: { openerOfChat: () => undefined },
    };
    const visible = eventsFor(deps as never, readerOf(rina as never, PEOPLE), () => now);
    const row = { gatewayId: "telegram:nouva", chatId: "-100" };
    expect(visible(row)).toBe(false);
    spoke = new Set(["telegram\u0000-100"]);
    expect(visible(row)).toBe(false);
    now += 10_000;
    expect(visible(row)).toBe(true);
    expect(visible({ gatewayId: null, chatId: null })).toBe(true);
    expect(visible({ gatewayId: null, chatId: "-100" })).toBe(false);
    expect(asked).toBe(2);
  });

  test("are every row for an admin", () => {
    const visible = eventsFor({} as never, readerOf({ kind: "token", role: "admin" } as never, PEOPLE));
    expect(visible({ gatewayId: "telegram:nouva", chatId: "anything" })).toBe(true);
  });
});
