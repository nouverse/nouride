/**
 * Which heading a conversation falls under.
 *
 * The boundaries are calendar ones, not elapsed hours, and that is the whole point: something from
 * 11pm last night is "Yesterday" when you look at 8am, even though it is nine hours old. A list that
 * files it under "Today" because 24 hours have not passed is arguing with the reader about what day
 * it is, and the reader is right.
 */

import { describe, expect, test } from "bun:test";
import { groupByDate } from "../src/modules/chat/components/SessionDrawer.tsx";
import type { Room, SessionSummary } from "@nouride/wire";

const NOW = new Date("2026-09-06T10:00:00").getTime();

const at = (iso: string): SessionSummary => ({
  id: `s-${iso}`,
  agentId: "nouva",
  chatId: "web-1",
  gatewayId: "web:dashboard",
  updatedAt: new Date(iso).getTime(),
});

const labels = (sessions: SessionSummary[]) =>
  groupByDate(sessions, [], NOW).map((group) => group.label);

/** Every row's id, whichever kind of conversation it is. */
const ids = (groups: ReturnType<typeof groupByDate>) =>
  groups.flatMap((group) =>
    group.entries.map((entry) => (entry.kind === "room" ? entry.room.chatId : entry.session.id)),
  );

const room = (chatId: string, iso: string): Room =>
  ({
    chatId,
    gatewayId: "web:dashboard",
    createdAt: new Date(iso).getTime() - 3_600_000,
    updatedAt: new Date(iso).getTime(),
    members: [],
  }) as unknown as Room;

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
    const rows = [
      at("2026-09-06T09:00:00"),
      at("2026-09-06T08:00:00"),
      at("2026-09-05T20:00:00"),
      at("2026-09-03T20:00:00"),
    ];
    const groups = groupByDate(rows, [], NOW);

    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "Previous 7 days"]);
    expect(groups[0]?.entries).toHaveLength(2);
    // Newest first, which is the order they arrive in and the order they come out in.
    expect(ids(groups)).toEqual(rows.map((s) => s.id));
  });

  test("an empty history is no groups, not one empty group", () => {
    expect(groupByDate([], [], NOW)).toEqual([]);
  });
});

describe("rooms in the same list", () => {
  /**
   * Rooms began in their own pinned section, which put a room used a week ago above a chat from a
   * minute ago — two orderings pretending to be one. This panel answers "what was I doing recently",
   * and that question does not care which kind of conversation the answer is, so the kind moved onto
   * the row and the ordering became one.
   */
  test("a room sorts among the conversations by when it was last used", () => {
    const groups = groupByDate(
      [at("2026-09-06T09:00:00"), at("2026-09-04T09:00:00")],
      [room("room-1", "2026-09-06T09:30:00")],
      NOW,
    );

    expect(ids(groups)).toEqual(["room-1", "s-2026-09-06T09:00:00", "s-2026-09-04T09:00:00"]);
  });

  test("not by when it was created", () => {
    // Ordered by creation a room would sink down the list while it was the one being used.
    const groups = groupByDate(
      [at("2026-09-06T09:00:00")],
      [
        {
          chatId: "old-room",
          gatewayId: "web:dashboard",
          createdAt: new Date("2026-08-20T09:00:00").getTime(),
          updatedAt: new Date("2026-09-06T09:59:00").getTime(),
          members: [],
        } as unknown as Room,
      ],
      NOW,
    );

    expect(ids(groups)).toEqual(["old-room", "s-2026-09-06T09:00:00"]);
  });

  test("a room nobody has spoken in falls back to its creation", () => {
    // The only thing that has happened to it.
    const groups = groupByDate(
      [],
      [
        {
          chatId: "fresh",
          gatewayId: "web:dashboard",
          createdAt: new Date("2026-09-06T08:00:00").getTime(),
          members: [],
        } as unknown as Room,
      ],
      NOW,
    );

    expect(groups.map((group) => group.label)).toEqual(["Today"]);
    expect(ids(groups)).toEqual(["fresh"]);
  });
});
