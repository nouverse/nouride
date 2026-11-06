/**
 * The nightly pass's clock and purse (`boot/memory-pass.ts`): when it starts, which model files an
 * episode, and why it refuses — each a way the pass could run wrong or not at all without saying so.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { addLogSink, LLMError, type LogEntry } from "@nouride/shared";
import { isDue, nextRun, startMemoryPass, type MemoryPassDeps } from "@/boot/memory-pass.ts";
import { LogStore } from "@/commons/logs.store.ts";
import { helperTrouble } from "@/modules/llm/helper-trouble.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { GADING_DM, SAM_DM, TZ, at, household, type Household } from "./fixture.ts";
import { eventually } from "../helpers.ts";
import { sleep } from "../wait.ts";

describe("when the pass starts", () => {
  const due = (hh: number, mm: number, lastDay: string | null = null, running = 0) => isDue({ now: at(hh, mm), timeZone: TZ, at: "01:00", lastDay, running });

  test("at or past the hour, once a day, and only while no turn runs", () => {
    expect(due(0, 59)).toBeNull();
    expect(due(1, 0)).toBe("2026-09-25");
    expect(due(9, 0)).toBe("2026-09-25");
    expect(due(9, 0, "2026-09-25")).toBeNull();
    expect(due(1, 0, null, 1)).toBeNull();
  });

  test("the next run: today at the hour until today has had it — due once the hour has passed — then tomorrow", () => {
    const next = (hh: number, mm: number, lastDay: string | null = null) => nextRun({ now: at(hh, mm), timeZone: TZ, at: "01:00", lastDay });
    expect(next(0, 30)).toEqual({ at: at(1, 0), due: false });
    expect(next(9, 0)).toEqual({ at: at(1, 0), due: true });
    expect(next(9, 0, "2026-09-25")).toEqual({ at: at(1, 0, 26), due: false });
    expect(next(0, 30, "2026-09-24")).toEqual({ at: at(1, 0), due: false });
  });
});

describe("the pass on its clock", () => {
  let h: Household;
  const used: { agentId: string; model: string; provider: string }[] = [];
  const calls: { model: string; system?: unknown }[] = [];
  let spent = 0;

  beforeEach(async () => {
    h = await household();
    used.length = 0;
    calls.length = 0;
    spent = 0;
  });

  afterEach(() => h.close());

  function pass(extra: Partial<MemoryPassDeps> = {}) {
    const agents = [
      { config: { id: "nouva", llm: { provider: "openai", model: "gpt-small" } } },
      { config: { id: "nix", llm: { provider: "openai", model: "gpt-nix" } } },
    ];
    const config = { ...structuredClone(DEFAULT_CONFIG), memory: h.config.memory, daemon: h.config.daemon };
    config.llm.limits.maxDailyTokens = 1_000;
    return startMemoryPass({
      config,
      registry: { enabled: () => agents as never },
      providers: {
        get: () =>
          ({
            chat: async ({ model, system }: { model: string; system?: unknown }) => {
              calls.push({ model, system });
              return { text: JSON.stringify({ summary: "Filed." }), model, usage: { inputTokens: 100, outputTokens: 10 } };
            },
          }) as never,
      },
      usage: {
        record: (row: { agentId: string; model: string; provider: string }) => {
          used.push(row);
          spent += 110;
        },
        since: () => ({ usd: 0, unpricedRequests: 0, inputTokens: spent, outputTokens: 0, requests: used.length }) as never,
      },
      memory: h.memory,
      now: () => h.clock.now,
      ...extra,
    });
  }

  /**
   * The log emptied after a pass (E4, 2026-10-15). Autocheckpoint bounds it while the day runs; the pass
   * is the one reliably idle moment to give its disk back — and only while no turn is running, because a
   * `TRUNCATE` waits for readers and this daemon's reads are on its own event loop.
   */
  test("the write-ahead log is emptied after the pass and its embedding, and not while a turn runs", async () => {
    h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
    const modes: string[] = [];
    const db = { checkpoint: (mode: "PASSIVE" | "TRUNCATE") => (modes.push(mode), { busy: false, log: 3, checkpointed: 3 }) };
    const settled = async () => {
      for (let i = 0; i < 50 && modes.length === 0; i += 1) await sleep(10);
    };

    const idle = pass({ db });
    try {
      await idle.run();
      await settled();
      expect(modes).toEqual(["TRUNCATE"]);
    } finally {
      clearInterval(idle.timer);
    }

    modes.length = 0;
    const busy = pass({ db, turns: { runningSessions: () => new Set(["a turn"]) } as never });
    try {
      await busy.run();
      await settled();
      expect(modes).toEqual([]);
    } finally {
      clearInterval(busy.timer);
    }
  });

  test("the status says a run is going on and since when, then when it ran, what it did and when the next one is", async () => {
    h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const chat = async ({ model }: { model: string }) => {
      await held;
      return { text: JSON.stringify({ summary: "Filed." }), model, usage: { inputTokens: 100, outputTokens: 10 } };
    };
    const memoryPass = pass({ providers: { get: () => ({ chat }) as never } as never });
    try {
      const running = memoryPass.run();
      await eventually(() => memoryPass.status().running, 2_000, "the run");
      expect(memoryPass.status()).toMatchObject({ running: true, runningSince: at(23, 0) });
      release();
      await running;
      const status = memoryPass.status();
      expect(status.running).toBe(false);
      expect(status).not.toHaveProperty("runningSince");
      expect(status.lastRun).toMatchObject({ startedAt: at(23, 0), finishedAt: at(23, 0), scheduled: false, filed: 1 });
      // Started past the hour with no night on record: tonight counts as had, so the next is tomorrow's.
      expect(status.next).toEqual({ at: at(1, 0, 26), due: false });
      h.config.memory.pass = false;
      expect(memoryPass.status().next).toBeNull();
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("each episode with its own agent's model, every call recorded as spend", async () => {
    h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
    h.dm(SAM_DM, "nix", "hai", "hai", at(10));
    const memoryPass = pass();
    try {
      const result = await memoryPass.run();
      expect(result).toMatchObject({ report: { filed: 2 } });
      expect(calls.map((call) => call.model)).toEqual(["gpt-small", "gpt-nix"]);
      expect(used.map((row) => row.agentId)).toEqual(["nouva", "nix"]);
      expect(memoryPass.status()).toMatchObject({ enabled: true, at: "01:00", running: false, lastRun: { filed: 2, failed: 0 } });
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("a question asked of the pass's model past today's cap is not asked — a forget, a tag suggestion", async () => {
    const memoryPass = pass();
    try {
      spent = 5_000;
      expect(await memoryPass.ask({ system: "s", user: "which tags?" })).toBeNull();
      expect(calls).toEqual([]);
      spent = 0;
      expect(await memoryPass.ask({ system: "s", user: "which tags?" })).not.toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("the provider is handed the two cached blocks as they are, not one string", async () => {
    h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
    const memoryPass = pass();
    try {
      await memoryPass.run();
      expect(calls[0]!.system).toEqual([
        { text: expect.stringContaining("You file one finished conversation"), cache: true },
        { text: "Known tags, most used first: (none yet).", cache: true },
      ]);
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("[memory] pass_provider and pass_model override every agent's", async () => {
    h.config.memory.passProvider = "openai";
    h.config.memory.passModel = "tiny";
    h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
    const memoryPass = pass();
    try {
      await memoryPass.run();
      expect(calls.map((call) => call.model)).toEqual(["tiny"]);
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  /**
   * The pass's model gone (2026-10-21): nougate answered `404 No account has access`, and every conversation the pass
   * tried to file failed — ten waiting, and the night after would fail the same way. A pass model that cannot answer is
   * asked of the episode's agent's own; one that is only failing for now is not, and its failure is what `/health` and
   * doctor read back (`llm/helper-trouble.ts`).
   */
  describe("a pass model that cannot answer", () => {
    function failing(status: number, message: string) {
      return {
        get: (name: string) =>
          name === "nougate"
            ? ({
                chat: async ({ model }: { model: string }) => {
                  calls.push({ model });
                  throw new LLMError(`${status} ${message}`, status);
                },
              } as never)
            : ({
                chat: async ({ model }: { model: string }) => {
                  calls.push({ model });
                  return { text: JSON.stringify({ summary: "Filed." }), model, usage: { inputTokens: 100, outputTokens: 10 } };
                },
              } as never),
      };
    }

    beforeEach(() => {
      h.config.memory.passProvider = "nougate";
      h.config.memory.passModel = "gone-pass-model";
      h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
    });

    test("is asked of the agent's own model instead, and charged to the agent's profile", async () => {
      const memoryPass = pass({ providers: failing(404, 'No account has access to "gone-pass-model"') });
      try {
        const result = await memoryPass.run();
        expect(result).toMatchObject({ report: { filed: 1, failed: [] } });
        expect(calls.map((call) => call.model)).toEqual(["gone-pass-model", "gpt-small"]);
        expect(used.map((row) => row.provider)).toEqual(["openai"]);
      } finally {
        clearInterval(memoryPass.timer);
      }
    });

    test("one only failing for now is not — and its failure is said where an operator looks", async () => {
      const logs = new LogStore(h.db);
      let open = true;
      addLogSink((entry) => void (open && logs.sink(entry)));
      const memoryPass = pass({ providers: failing(500, "Internal Server Error") });
      try {
        const result = await memoryPass.run();
        expect(result).toMatchObject({ report: { filed: 0 } });
        expect(calls.map((call) => call.model)).toEqual(["gone-pass-model"]);
        logs.flush();
        expect(helperTrouble(logs, { memory: h.config.memory, llm: { context: {} } }, Date.now())).toEqual([
          expect.objectContaining({ job: "memory pass", count: 1, model: "nougate/gone-pass-model", last: expect.stringContaining("500 Internal Server Error") }),
        ]);
      } finally {
        open = false;
        logs.stop();
        clearInterval(memoryPass.timer);
      }
    });
  });

  test("with no record of any night, a start after the pass time counts from the next night", () => {
    h.clock.now = at(19, 0);
    const late = pass();
    clearInterval(late.timer);
    expect(late.status()).toMatchObject({ lastDay: "2026-09-25", lastRun: null });
  });

  test("a minute whose look throws is logged, and the next minute's still starts the night's pass", async () => {
    // The look reads the pass's record and the turn table from a timer. A throw out of it was an uncaught exception,
    // which the daemon shuts down on — bun fails this test on one.
    const errors: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "memory.pass" && entry.level === "error" && errors.push(entry)));
    h.dm(GADING_DM, "nouva", "halo", "halo", at(9, 0, 24));
    h.clock.now = at(0, 30);
    let looks = 0;
    const turns = {
      runningSessions: () => {
        looks += 1;
        if (looks === 1) throw new Error("database is locked");
        return new Set<string>();
      },
    };
    jest.useFakeTimers();
    const nightly = pass({ turns: turns as never });
    try {
      h.clock.now = at(1, 0);
      jest.advanceTimersByTime(60_000);
      expect(errors.map((line) => [line.message, line.data?.error])).toEqual([["could not look at whether the nightly pass is due", "Error: database is locked"]]);
      jest.advanceTimersByTime(60_000);
      jest.useRealTimers();
      await eventually(() => nightly.status().lastRun !== null, 4_000, "the night's pass, a minute late");
      expect(nightly.status()).toMatchObject({ lastDay: "2026-09-25", lastRun: { filed: 1 } });
    } finally {
      jest.useRealTimers();
      clearInterval(nightly.timer);
    }
  });

  test("each minute's look lets go of the vectors no search has read for a while — with the pass off too", () => {
    h.config.memory.pass = false;
    h.vectors.put([{ item: "e1", vector: Int8Array.from([1, 2]), hash: "h" }], "m", 1);
    const read = h.vectors.of("m");
    jest.useFakeTimers();
    const off = pass();
    try {
      jest.advanceTimersByTime(60_000);
      expect(h.vectors.of("m")).toBe(read);
      h.clock.now += 16 * 60_000;
      jest.advanceTimersByTime(60_000);
      // Let go, and read afresh: another map, the same vectors.
      expect(h.vectors.of("m")).not.toBe(read);
      expect([...h.vectors.of("m").get("e1")!]).toEqual([1, 2]);
    } finally {
      jest.useRealTimers();
      clearInterval(off.timer);
    }
  });

  test("before the pass time, the first night is tonight", () => {
    h.clock.now = at(0, 30);
    const early = pass();
    clearInterval(early.timer);
    expect(early.status().lastDay).toBeNull();
  });

  test("its record outlives a restart: the night's pass is not run again, and the last run is still shown", async () => {
    h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
    const first = pass();
    try {
      // The nightly pass records its day as it starts; a run asked for by hand is not the night's.
      const night = h.memory.passRuns.started({ startedAt: at(1, 0), day: "2026-09-25", scheduled: true });
      const result = await first.run();
      if (!("report" in result)) throw new Error("the pass was refused");
      h.memory.passRuns.finished(night, { ...result.report, failed: 0 });
    } finally {
      clearInterval(first.timer);
    }

    const restarted = pass();
    try {
      const status = restarted.status();
      expect(status.lastDay).toBe("2026-09-25");
      expect(status.lastRun).toMatchObject({ filed: 1, failed: 0 });
      // What the clock asks on every tick after the restart: not due, the night is done.
      expect(isDue({ now: at(9, 30), timeZone: TZ, at: "01:00", lastDay: status.lastDay, running: 0 })).toBeNull();
    } finally {
      clearInterval(restarted.timer);
    }
  });

  test("a night cut short by a restart is resumed once, and given up after a second start that never finishes", () => {
    // Live: the pass began at 01:00:09, a deploy restarted the daemon fifty seconds later, and the
    // night counted as run with nothing filed.
    h.memory.passRuns.skipped({ at: at(0, 0) - 86_400_000, day: "2026-09-24" });
    h.memory.passRuns.started({ startedAt: at(1, 0), day: "2026-09-25", scheduled: true });
    expect(h.memory.passRuns.lastScheduledDay()).toBe("2026-09-24");
    expect(isDue({ now: at(1, 2), timeZone: TZ, at: "01:00", lastDay: h.memory.passRuns.lastScheduledDay(), running: 0 })).toBe("2026-09-25");

    h.memory.passRuns.started({ startedAt: at(1, 3), day: "2026-09-25", scheduled: true });
    expect(h.memory.passRuns.lastScheduledDay()).toBe("2026-09-25");
  });

  test("a night's own budget: stopped — not failed — before the next conversation once its calls used pass_max_tokens", async () => {
    for (let n = 0; n < 6; n += 1) h.dm({ ...GADING_DM, chatId: `c${n}`, senderId: "814" }, "nouva", `pesan ${n}`, "ok", at(9, n));
    h.config.memory.passMaxTokens = 250;
    const memoryPass = pass();
    try {
      // 110 tokens a call, read before each conversation: 0, 110 and 220 are under 250, 330 is not — three filed, and the
      // count (20) and the day's 1,000 never came into it.
      const result = await memoryPass.run();
      expect(result).toMatchObject({ report: { filed: 3, failed: [], waiting: 3, spent: { tokens: 330, estimated: false }, stopped: expect.stringContaining("tonight's 250 tokens for the pass are used (330)") } });
      expect(h.memory.failed()).toEqual([]);
      expect(memoryPass.status().lastRun).toMatchObject({ filed: 3, spent: { tokens: 330, estimated: false } });
      // A night's, not the day's: the next run has its own 250, and files the other three.
      expect(await memoryPass.run()).toMatchObject({ report: { filed: 3, waiting: 0 } });
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("a night that leaves more waiting than a week of nights files says so in the journal, with the count that would", async () => {
    const warned: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "memory.pass" && entry.level === "warn" && warned.push(entry)));
    for (let n = 0; n < 6; n += 1) h.dm({ ...GADING_DM, chatId: `c${n}`, senderId: "814" }, "nouva", `pesan ${n}`, "ok", at(9, n));
    h.config.memory.passPerNight = 2;
    const memoryPass = pass();
    try {
      await memoryPass.run();
      // Six begun today — a day old, so six a day — two filed a night, four waiting: ceil(6 + 4 / 7).
      expect(warned.map((entry) => [entry.message, entry.data])).toEqual([
        ["the nightly pass is not keeping up", { waiting: 4, oldest: "2026-09-25", pass_per_night: 2, per_day: { nouva: 6 }, days: 1, enough: 7 }],
      ]);
      h.config.memory.passPerNight = 20;
      warned.length = 0;
      await memoryPass.run();
      expect(warned).toEqual([]);
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("tokens a provider did not report are counted as estimated, and the night's report says so", async () => {
    for (let n = 0; n < 3; n += 1) h.dm({ ...GADING_DM, chatId: `c${n}`, senderId: "814" }, "nouva", `pesan ${n}`, "ok", at(9, n));
    h.config.memory.passMaxTokens = 150;
    const silent = { get: () => ({ chat: async ({ model }: { model: string }) => ({ text: JSON.stringify({ summary: "Filed." }), model, usage: { inputTokens: 100, outputTokens: 10, estimated: true } }) }) as never };
    const memoryPass = pass({ providers: silent });
    try {
      expect(await memoryPass.run()).toMatchObject({ report: { filed: 2, waiting: 1, spent: { tokens: 220, estimated: true }, stopped: expect.stringContaining("estimated where a provider reported none") } });
    } finally {
      clearInterval(memoryPass.timer);
    }
  });

  test("refused when off or without an owner, and stopped — not failed — when today's budget is spent", async () => {
    for (let n = 0; n < 12; n += 1) h.dm({ ...GADING_DM, chatId: `c${n}`, senderId: "814" }, "nouva", `pesan ${n}`, "ok", at(9, n));
    const memoryPass = pass();
    try {
      // 110 tokens a call against a 1,000-token day, checked before each call: after nine it is 990,
      // so a tenth runs, and the day is spent with two episodes left for tomorrow.
      const result = await memoryPass.run();
      expect(result).toMatchObject({ report: { filed: 10, failed: [], waiting: 2, stopped: expect.stringContaining("token cap") } });
      expect(h.memory.failed()).toEqual([]);
      expect(await memoryPass.run()).toMatchObject({ refused: expect.stringContaining("token cap"), why: "spend" });

      h.config.memory.pass = false;
      expect(await memoryPass.run()).toEqual({ refused: "the nightly pass is off ([memory] pass is false)", why: "off" });
    } finally {
      clearInterval(memoryPass.timer);
    }
  });
});
