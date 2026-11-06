/**
 * The scheduled night makes room for the machine — `boot/memory-pass.ts` (0.8.0). While the box is busy its start skips
 * the minute, each conversation and each batch of the embedding waits, and past two hours of waiting it goes on. A pass
 * asked for by hand is a person's, and never asks.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { startMemoryPass, type MemoryPassDeps } from "@/boot/memory-pass.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { GADING_DM, at, household, scripted, type Household } from "./fixture.ts";
import { eventually } from "../wait.ts";

const HOUR = 3_600_000;

const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "box-load" && entry.level !== "debug" && lines.push(entry)));

let h: Household;
beforeEach(async () => {
  lines.length = 0;
  h = await household({ embed: (texts) => texts.map(() => [1, 0, 0, 0]) });
});
afterEach(() => {
  jest.useRealTimers();
  h.close();
});

/** A conversation in each of `n` chats yesterday, for tonight's pass to file. */
function yesterday(n: number): void {
  for (let i = 0; i < n; i += 1) h.dm({ ...GADING_DM, chatId: `c${i}` }, "nouva", `pesan ${i}`, "ok", at(9, i, 24));
}

/** The pass as boot starts it, on the household's clock, with a load the test sets and a model that counts its calls. */
function nightly(extra: Partial<MemoryPassDeps> = {}) {
  const state = { busy: null as string | null, looks: 0, calls: 0, onCall: () => {} };
  const config = { ...structuredClone(DEFAULT_CONFIG), memory: h.config.memory, daemon: h.config.daemon };
  const memoryPass = startMemoryPass({
    config,
    registry: { enabled: () => [{ config: { id: "nouva", llm: { provider: "openai", model: "gpt-small" } } }] as never },
    providers: {
      get: () =>
        ({
          chat: async ({ model }: { model: string }) => {
            state.calls += 1;
            state.onCall();
            return { text: JSON.stringify({ summary: "Filed." }), model, usage: { inputTokens: 10, outputTokens: 10 } };
          },
        }) as never,
    },
    memory: h.memory,
    load: { busy: () => ((state.looks += 1), state.busy) },
    roomCheckMs: 5,
    now: () => h.clock.now,
    ...extra,
  });
  return { memoryPass, state };
}

/** One minute of the pass's clock: the household's, and the timer's. */
function minute(at: number): void {
  h.clock.now = at;
  jest.advanceTimersByTime(60_000);
}

describe("the night's start", () => {
  test("a busy box skips the minute, said once; the first minute with room starts the night", async () => {
    yesterday(1);
    h.clock.now = at(0, 30);
    jest.useFakeTimers();
    const { memoryPass, state } = nightly();
    try {
      state.busy = "the CPU was 91% busy over the last minute";
      minute(at(1, 0));
      minute(at(1, 1));
      expect(memoryPass.status()).toMatchObject({ running: false, lastRun: null, next: { due: true } });
      expect(state.calls).toBe(0);
      expect(lines.map((line) => line.message)).toEqual(["the nightly memory pass waits while the box is busy: the CPU was 91% busy over the last minute"]);

      state.busy = null;
      minute(at(1, 2));
      jest.useRealTimers();
      await eventually(() => memoryPass.status().lastRun !== null, 4_000, "the night's pass");
      expect(memoryPass.status()).toMatchObject({ lastDay: "2026-09-25", lastRun: { scheduled: true, filed: 1 } });
      expect(lines.map((line) => line.message)).toEqual([
        "the nightly memory pass waits while the box is busy: the CPU was 91% busy over the last minute",
        "the nightly memory pass goes on: the box has room again",
      ]);
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("busy all night, it goes on after two hours of waiting — a day not filed is worse than a slower night", async () => {
    yesterday(1);
    h.clock.now = at(0, 30);
    jest.useFakeTimers();
    const { memoryPass, state } = nightly();
    try {
      state.busy = "thermal_zone0 is at 86 °C, at or past its passive trip point of 85 °C";
      minute(at(1, 0));
      minute(at(2, 59));
      expect(memoryPass.status().lastRun).toBeNull();
      minute(at(3, 0));
      jest.useRealTimers();
      await eventually(() => memoryPass.status().lastRun !== null, 4_000, "the night's pass, busy or not");
      expect(lines.at(-1)).toMatchObject({ level: "warn", message: expect.stringContaining("the nightly memory pass goes on with the box still busy"), data: { waited_ms: 2 * HOUR } });
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("a pass asked for by hand never asks whether the box is busy", async () => {
    yesterday(2);
    const { memoryPass, state } = nightly();
    try {
      state.busy = "the CPU was 99% busy over the last minute";
      expect(await memoryPass.run()).toMatchObject({ report: { filed: 2 } });
      expect(state.looks).toBe(0);
    } finally {
      clearInterval(memoryPass.timer);
    }
  });
});

describe("in the middle of the night", () => {
  test("the box gets busy: the next conversation waits for room, and is filed once there is room", async () => {
    yesterday(2);
    h.clock.now = at(0, 30);
    jest.useFakeTimers();
    const { memoryPass, state } = nightly();
    try {
      // Busy from the first conversation's model call on.
      state.onCall = () => void (state.busy = "the daemon's cgroup waited for memory 25% of the last minute");
      minute(at(1, 0));
      jest.useRealTimers();
      await eventually(() => lines.some((line) => line.message.startsWith("the nightly memory pass waits")), 4_000, "the wait before the second conversation");
      expect(state.calls).toBe(1);
      expect(memoryPass.status().running).toBe(true);

      state.onCall = () => {};
      state.busy = null;
      await eventually(() => memoryPass.status().lastRun !== null, 4_000, "the night's pass");
      expect(memoryPass.status().lastRun).toMatchObject({ filed: 2 });
      expect(state.calls).toBe(2);
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("the embedding after it is given the night's wait; after a pass by hand, none", async () => {
    yesterday(1);
    const given: unknown[] = [];
    h.clock.now = at(0, 30);
    jest.useFakeTimers();
    const { memoryPass } = nightly({ memory: { ...h.memory, embedCatchUp: async (room?: () => Promise<unknown>) => (given.push(room), null) } });
    try {
      minute(at(1, 0));
      jest.useRealTimers();
      await eventually(() => given.length === 1, 4_000, "the night's embedding");
      expect(given[0]).toBeFunction();
      await memoryPass.run();
      await eventually(() => given.length === 2, 4_000, "the embedding after a pass by hand");
      expect(given[1]).toBeUndefined();
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("the embedding waits for room before each batch it sends", async () => {
    yesterday(10);
    await h.memory.pass(scripted([]).ask);
    const order: string[] = [];
    const embedded = await h.memory.embedCatchUp(async () => void order.push("room"));
    expect(embedded).toMatchObject({ embedded: 10, failed: false });
    // Ten summaries, eight a batch.
    expect(order).toEqual(["room", "room"]);
  });
});
