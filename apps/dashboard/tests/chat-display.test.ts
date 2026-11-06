/**
 * Which exchange is drawn where.
 *
 * Every case here is a sentence from the bug report. The rule was written twice — "don't draw it live
 * if the history has it" and "don't draw it in the history if it is live" — and a finished turn that
 * was both got drawn by neither. Since that is the state *every* conversation's newest turn is in the
 * moment its transcript loads, the newest exchange vanished from every conversation, and a
 * conversation with only one exchange rendered a blank page.
 */

import { describe, expect, test } from "bun:test";
import { splitForDisplay } from "../src/commons/lib/turn-display.ts";
import type { ChatTurn, LiveTurn } from "../src/commons/lib/api.ts";

const turn = (id: string, status: ChatTurn["status"] = "done"): ChatTurn => ({
  id,
  agentId: "nouva",
  chatId: "web-1",
  status,
  prompt: "q " + id,
  reply: "a " + id,
  toolCalls: 0,
  startedAt: 1_000,
  endedAt: 2_000,
  durationMs: 1_000,
  steps: [],
});

const asLive = (t: ChatTurn): LiveTurn => ({ ...t, cursor: 0 });

describe("a conversation that is not doing anything", () => {
  test("draws every recorded exchange, including the newest one", () => {
    // "gw refresh yang baru ilang, yang lama keload" — this is that sentence.
    const recorded = [turn("t1"), turn("t2"), turn("t3")];
    const { history, live } = splitForDisplay(recorded, asLive(turn("t3")));

    expect(history.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(live).toBeNull();
  });

  test("a conversation with exactly one exchange is not a blank page", () => {
    // "gw masuk history session, tiba2 kosong, padahal harusnya ada."
    const { history, live } = splitForDisplay([turn("only")], asLive(turn("only")));
    expect(history.map((t) => t.id)).toEqual(["only"]);
    expect(live).toBeNull();
  });

  test("and one with nothing recorded and nothing live is genuinely empty", () => {
    expect(splitForDisplay([], null)).toEqual({ history: [], live: null });
  });
});

describe("a conversation that is working", () => {
  test("the running turn is live and is not also in the history", () => {
    const running = asLive(turn("now", "running"));
    const { history, live } = splitForDisplay([turn("t1")], running);

    expect(history.map((t) => t.id)).toEqual(["t1"]);
    expect(live?.id).toBe("now");
  });

  test("a turn the daemon has finished but the transcript has not fetched yet stays live", () => {
    // The few hundred milliseconds between a turn ending and the refetch landing. Without this the
    // answer blinks out of existence and then comes back.
    const { history, live } = splitForDisplay([turn("t1")], asLive(turn("t2")));
    expect(history.map((t) => t.id)).toEqual(["t1"]);
    expect(live?.id).toBe("t2");
  });

  test("nothing is ever drawn twice", () => {
    const recorded = [turn("t1"), turn("t2")];
    const { history, live } = splitForDisplay(recorded, asLive(turn("t2", "running")));
    const ids = [...history.map((t) => t.id), ...(live ? [live.id] : [])];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a running turn that leaked into the transcript is still only drawn live", () => {
    // Belt and braces: the daemon withholds these, and if a future change stops withholding them the
    // frozen `… 0 steps` bubble must not come back.
    const leaked = turn("now", "running");
    const { history, live } = splitForDisplay([turn("t1"), leaked], asLive(leaked));
    expect(history.map((t) => t.id)).toEqual(["t1"]);
    expect(live?.id).toBe("now");
  });
});
