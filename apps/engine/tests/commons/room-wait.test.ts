/**
 * Background work's wait for room on the box — `commons/room-wait.ts` (0.8.0): it goes when the box has room, waits
 * while it is busy and says so once each way, goes on anyway past its ceiling counted across every stretch of waiting,
 * and a stop ends a wait at once.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { RoomWait } from "@/commons/room-wait.ts";
import { eventually } from "../wait.ts";

const MIN = 60_000;

const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "box-load" && entry.level !== "debug" && lines.push(entry)));
beforeEach(() => void (lines.length = 0));

/** A wait on a load and a clock the test sets, with what it told its work's own log. */
function waiting(ceilingMs = 10 * MIN) {
  const state: { busy: string | null; now: number; looks: number } = { busy: null, now: 0, looks: 0 };
  const told: string[] = [];
  const room = new RoomWait(
    { busy: () => ((state.looks += 1), state.busy) },
    { what: "the test's work", ceilingMs, everyMs: 5, now: () => state.now, tell: (line) => told.push(line) },
  );
  return { room, state, told };
}

describe("one look at a time — work on a clock of its own", () => {
  test("a box with room: it goes at once, and nothing is said", () => {
    const w = waiting();
    expect(w.room.ready()).toBe(true);
    expect(lines).toEqual([]);
    expect(w.told).toEqual([]);
  });

  test("a busy box: it waits, saying so once with why; once there is room it goes, saying so once", () => {
    const w = waiting();
    w.state.busy = "the CPU was 90% busy over the last minute";
    expect([w.room.ready(), w.room.ready(), w.room.ready()]).toEqual([false, false, false]);
    w.state.now = 4 * MIN;
    w.state.busy = null;
    expect(w.room.ready()).toBe(true);
    expect(w.room.ready()).toBe(true);
    expect(lines.map((line) => [line.level, line.message, line.data?.waited_ms ?? line.data?.at_most_ms])).toEqual([
      ["info", "the test's work waits while the box is busy: the CPU was 90% busy over the last minute", 10 * MIN],
      ["info", "the test's work goes on: the box has room again", 4 * MIN],
    ]);
    expect(w.told).toEqual(["the test's work waits while the box is busy: the CPU was 90% busy over the last minute", "the test's work goes on: the box has room again"]);
  });

  test("past its ceiling it goes on busy — the ceiling counts every stretch of waiting together — and asks no more", () => {
    const w = waiting(10 * MIN);
    w.state.busy = "thermal_zone0 is hot";
    expect(w.room.ready()).toBe(false);
    w.state.now = 6 * MIN;
    w.state.busy = null;
    expect(w.room.ready()).toBe(true);

    w.state.busy = "thermal_zone0 is hot";
    w.state.now = 7 * MIN;
    expect(w.room.ready()).toBe(false);
    w.state.now = 10 * MIN;
    expect(w.room.ready()).toBe(false);
    // Six minutes, then four: the ten it may wait.
    w.state.now = 11 * MIN;
    expect(w.room.ready()).toBe(true);
    expect(lines.at(-1)).toMatchObject({ level: "warn", message: "the test's work goes on with the box still busy (thermal_zone0 is hot): it has waited the most it waits", data: { waited_ms: 10 * MIN } });

    const looks = w.state.looks;
    expect(w.room.ready()).toBe(true);
    expect(w.state.looks).toBe(looks);
  });

  test("a load that throws when asked is room — a wait that cannot tell does not hold the work", () => {
    const room = new RoomWait(
      {
        busy: () => {
          throw new Error("EIO");
        },
      },
      { what: "the test's work", ceilingMs: MIN },
    );
    expect(room.ready()).toBe(true);
  });
});

describe("a wait — work that stops until there is room", () => {
  test("it looks again on its interval, and goes on once the box has room", async () => {
    const w = waiting();
    w.state.busy = "the CPU was 95% busy over the last minute";
    const went: { go?: boolean } = {};
    void w.room.wait().then((go) => (went.go = go));
    await eventually(() => w.state.looks >= 3, 2_000, "a few looks");
    expect(went.go).toBeUndefined();
    w.state.busy = null;
    await eventually(() => went.go !== undefined, 2_000, "the wait ending");
    expect(went.go).toBe(true);
  });

  test("stopped while it waits, it ends at once and says not to go on", async () => {
    const room = new RoomWait({ busy: () => "busy" }, { what: "the test's work", ceilingMs: 60 * MIN, everyMs: 60 * MIN });
    const controller = new AbortController();
    const waited = room.wait(controller.signal);
    controller.abort("stopped");
    const startedAt = Date.now();
    expect(await waited).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
