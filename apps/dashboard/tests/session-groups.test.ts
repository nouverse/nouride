/**
 * Which heading a conversation falls under in an agent's History, and which conversations are its own.
 *
 * The boundaries are calendar ones, not elapsed hours, and that is the whole point: something from
 * 11pm last night is "Yesterday" when you look at 8am, even though it is nine hours old. A list that
 * files it under "Today" because 24 hours have not passed is arguing with the reader about what day
 * it is, and the reader is right.
 *
 * History lists only the agent's own conversations: a room is a row of Chats, a group a row of Groups.
 */

import { describe, expect, test } from "bun:test";
import { groupByDate, ownConversations } from "../src/modules/chat/lib/history.ts";
import type { ChatListPayload, SessionSummary } from "@nouride/wire";

const NOW = new Date("2026-09-06T10:00:00").getTime();

const at = (iso: string): SessionSummary => ({
  id: `s-${iso}`,
  agentId: "nouva",
  chatId: "web-1",
  gatewayId: "web:dashboard",
  updatedAt: new Date(iso).getTime(),
});

const labels = (sessions: SessionSummary[]) => groupByDate(sessions, NOW).map((group) => group.label);

describe("the headings", () => {
  test("today and yesterday are named, not counted", () => {
    expect(labels([at("2026-09-06T09:00:00")])).toEqual(["Today"]);
    expect(labels([at("2026-09-05T23:30:00")])).toEqual(["Yesterday"]);
  });

  test("last night counts as yesterday at breakfast", () => {
    // Nine hours old, and still not today. The case elapsed-hours arithmetic gets wrong.
    expect(labels([at("2026-09-05T23:00:00")])).toEqual(["Yesterday"]);
  });

  test("the week and the month are the next two steps out", () => {
    expect(labels([at("2026-09-02T12:00:00")])).toEqual(["Previous 7 days"]);
    expect(labels([at("2026-08-20T12:00:00")])).toEqual(["Previous 30 days"]);
  });

  test("older than that is the month it happened in", () => {
    expect(labels([at("2026-05-14T12:00:00")])).toEqual(["May"]);
    // The year appears only once it stops being obvious.
    expect(labels([at("2025-05-14T12:00:00")])).toEqual(["May 2025"]);
  });
});

describe("the grouping itself", () => {
  test("keeps the daemon's order and cuts where the heading changes", () => {
    const rows = [at("2026-09-06T09:00:00"), at("2026-09-06T08:00:00"), at("2026-09-05T20:00:00"), at("2026-09-03T20:00:00")];
    const groups = groupByDate(rows, NOW);

    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "Previous 7 days"]);
    expect(groups[0]?.sessions).toHaveLength(2);
    // Newest first, which is the order they arrive in and the order they come out in.
    expect(groups.flatMap((group) => group.sessions.map((session) => session.id))).toEqual(rows.map((s) => s.id));
  });

  test("an empty history is no groups, not one empty group", () => {
    expect(groupByDate([], NOW)).toEqual([]);
  });
});

describe("an agent's own conversations", () => {
  const list: ChatListPayload = {
    agents: [],
    rooms: [{ chatId: "room-1", members: ["nouva", "nix"], at: 1, working: false }],
    groups: [{ platform: "telegram", chatId: "-100", agents: ["nouva"], sessions: [{ agentId: "nouva", sessionId: "s-group", gatewayId: "telegram:nouva" }], at: 1, working: false, people: 2 }],
  };
  const session = (id: string, chatId: string, gatewayId = "web:dashboard"): SessionSummary => ({ id, agentId: "nouva", chatId, gatewayId, updatedAt: 1 });

  test("its dashboard chats and its private chats on chat apps, not a room's nor a group's", () => {
    const all = [session("s-web", "web-1"), session("s-dm", "555", "telegram:nouva"), session("s-room", "room-1"), session("s-group", "-100", "telegram:nouva")];
    expect(ownConversations(all, list).map((one) => one.id)).toEqual(["s-web", "s-dm"]);
  });

  test("before the list has come, nothing is left out", () => {
    expect(ownConversations([session("s-web", "web-1")], undefined).map((one) => one.id)).toEqual(["s-web"]);
  });
});
