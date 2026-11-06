/**
 * One tool call, one row — and whether the row is red.
 *
 * Both properties come from the same screen. An operator watching a turn asked what was breaking:
 *
 *     💻 exec which chromium chromium-browser google-chrome     7.2s
 *     💻 exec failed · 3ms                                       4ms
 *     🔧 memory_recent {"days":2}                                1ms
 *     🔧 memory_recent ok · 11ms                                11ms
 *
 * Nothing was breaking. `which` exits 1 when it finds nothing, so the pair is the agent asking whether
 * a browser is installed and being told no; three of the four red rows on that screen were `which`
 * probes and the fourth was an `import playwright` check. The turn went on to succeed by another
 * route.
 *
 * Two separate faults made it unreadable. Every call took two rows and the second repeated its own
 * duration — once in the daemon's text, once in the column. And the number on the *call* row is not
 * the call's: `ms` is the gap since the previous step, so there it measures the model deciding.
 */

import { describe, expect, test } from "bun:test";
import { stepIcon, stepRows } from "../src/commons/lib/steps.ts";
import type { TurnStep } from "../src/commons/lib/api.ts";

let seq = 0;
const step = (kind: TurnStep["kind"], text: string, ms = 5): TurnStep => ({
  seq: (seq += 1),
  at: 1_700_000_000_000 + seq * 10,
  kind,
  text,
  ms,
});

describe("a finished call", () => {
  test("is one row, with the daemon's own result on it", () => {
    const rows = stepRows([
      step("tool", "exec which chromium chromium-browser google-chrome", 7200),
      step("tool_done", "exec exit 1 · 3ms", 4),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("exec which chromium chromium-browser google-chrome");
    // The tool name is not repeated: it is already the first word of the row it sits on.
    expect(rows[0]!.outcome).toBe("exit 1 · 3ms");
  });

  test("a non-zero exit is not drawn as a fault", () => {
    // The whole point. `which` answering "no" is not an error, and three rows of red on a working
    // turn is what sent somebody looking for a bug that was not there.
    const rows = stepRows([
      step("tool", "exec which pdftoppm"),
      step("tool_done", "exec exit 1 · 3ms"),
    ]);

    expect(rows[0]!.failed).toBe(false);
  });

  test("a refusal, a timeout and a kill are", () => {
    for (const [result, label] of [
      ["exec failed · 2ms", "refused"],
      ["exec timed out · 30001ms", "timeout"],
      ["exec killed · 900ms", "killed"],
    ]) {
      const rows = stepRows([
        step("tool", `exec something ${label}`),
        step("tool_done", result!),
      ]);
      expect(rows[0]!.failed).toBe(true);
    }
  });

  test("a count still reads as a count", () => {
    const rows = stepRows([
      step("tool", "grep timeout"),
      step("tool_done", "grep 12 found · 45ms"),
    ]);

    expect(rows[0]!.outcome).toBe("12 found · 45ms");
    expect(rows[0]!.failed).toBe(false);
  });
});

describe("the thinking gap", () => {
  test("is kept, and labelled as the wait rather than the call", () => {
    // On a slow turn this is the interesting number; it was previously shown in the duration column
    // as though the call itself had taken that long.
    const rows = stepRows([
      step("tool", "exec bun test", 7200),
      step("tool_done", "exec ok · 438ms", 440),
    ]);

    expect(rows[0]!.waitedMs).toBe(7200);
  });

  test("a short gap is not shown at all", () => {
    // Most gaps are milliseconds and a number for each is the noise this change exists to remove.
    const rows = stepRows([step("tool", "read notes.md", 40), step("tool_done", "read ok · 1ms")]);

    expect(rows[0]!.waitedMs).toBeUndefined();
  });
});

describe("a call still running", () => {
  test("carries its own spinner rather than depending on being last", () => {
    /**
     * The old rule was "the last row, if it is a `tool`". That is wrong the moment two calls run in
     * one round trip: one closes, the other does not, and the spinner sat on whichever was last.
     *
     * Which one closes is settled by the daemon, not guessed here: a parallel group announces its
     * calls in the order the model asked for them and reports their outcomes in that same order,
     * whatever order they finished in. So the first result belongs to the first call, and the second
     * call is the one still waiting.
     */
    const rows = stepRows([
      step("tool", "read notes.md"),
      step("tool", "read journal.md"),
      step("tool_done", "read ok · 1ms"),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("ok · 1ms");
    expect(rows[0]!.running).toBeUndefined();
    expect(rows[1]!.running).toBe(true);
  });

  test("both close, in call order, when both results arrive", () => {
    const rows = stepRows([
      step("tool", "read notes.md"),
      step("tool", "read journal.md"),
      step("tool_done", "read 4 lines · 1ms"),
      step("tool_done", "read 91 lines · 3ms"),
    ]);

    expect(rows.map((row) => row.outcome)).toEqual(["4 lines · 1ms", "91 lines · 3ms"]);
    expect(rows.some((row) => row.running)).toBe(false);
  });
});

describe("a step between a call and its result", () => {
  /**
   * The bug this file was reopened for. A screenshot of a working turn showed a spinner that never
   * stopped, with the same command completed on the row below it, and the reader's question was the
   * obvious one: why is it still loading?
   *
   * It was not. Adjacency was the pairing rule, and two things routinely break adjacency.
   */
  test("an approval pause no longer strands the call it paused", () => {
    const rows = stepRows([
      step("tool", "exec rm -rf /tmp/build"),
      step("waiting", "waiting for approval: exec", 45_000),
      step("tool_done", "exec ok · 12ms"),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("ok · 12ms");
    expect(rows[0]!.running).toBeUndefined();
    // The pause is still its own row: it is something that happened to the turn.
    expect(rows[1]!.kind).toBe("waiting");
    expect(rows[1]!.waitedMs).toBe(45_000);
  });

  test("an auto-approved call is one row, marked on its result", () => {
    /**
     * The daemon used to announce the same call twice — once plainly, once with `(auto)` — and the
     * second announcement was what broke adjacency. Eleven successful writes in one live turn left
     * eleven spinners. The marker is on the result line now, so this is the whole stream.
     */
    const rows = stepRows([
      step("tool", "write /opt/projects/api/go.mod"),
      step("tool_done", "write ok · 0ms (auto)"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("ok · 0ms (auto)");
    expect(rows[0]!.running).toBeUndefined();
    expect(rows[0]!.failed).toBe(false);
  });

  test("a retry or a compaction between the two is a row of its own, and closes nothing", () => {
    const rows = stepRows([
      step("tool", "exec bun test"),
      // Long gaps, which a call's row would show as a wait: on a remark they are the call's, not its own.
      step("retry", "the provider is rate-limiting — asking again in 2s (attempt 2 of 6)", 9_000),
      step("compact", "context full — cleared 3 earlier tool result(s) to make room", 9_000),
      step("tool_done", "exec ok · 4310ms"),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool", "retry", "compact"]);
    expect(rows.slice(1).map((row) => row.waitedMs)).toEqual([undefined, undefined]);
    expect(rows[0]!.outcome).toBe("ok · 4310ms");
    expect(rows[0]!.running).toBeUndefined();
    expect(stepIcon(rows[1]!)).toBe("🔁");
    expect(stepIcon(rows[2]!)).toBe("🗜️");
  });

  test("reasoning between the two does not strand it either", () => {
    const rows = stepRows([
      step("tool", "exec bun test"),
      step("reasoning", "while that runs, I should check the lockfile"),
      step("tool_done", "exec ok · 4310ms"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("ok · 4310ms");
  });
});

describe("what is not a call", () => {
  test("reasoning is left out, as before", () => {
    const rows = stepRows([
      step("reasoning", "I should check whether chromium is here"),
      step("tool", "exec which chromium"),
      step("tool_done", "exec exit 1 · 3ms"),
    ]);

    expect(rows).toHaveLength(1);
  });

  test("a spilled-output note is a row of its own and closes nothing", () => {
    /**
     * The third thing that lands between a call and its result, and the last of the three to be
     * fixed. It was a `tool_done`, so it closed the call it was about — taking the outcome slot with
     * "output was 812KB" and leaving `exec ok · 41ms` as an orphan row underneath. It arrives before
     * the result, so no pairing rule could have got this right; it needed a kind.
     */
    const rows = stepRows([
      step("tool", "exec bun test --coverage"),
      // A big gap deliberately: the note lands when the call finishes, so its `ms` is the call's
      // runtime. Shown, it would read as time the reader waited for the note.
      step("note", "exec output was 812KB — kept an excerpt, wrote the rest to a file", 41_000),
      step("tool_done", "exec ok · 41ms"),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("ok · 41ms");
    expect(rows[0]!.running).toBeUndefined();
    expect(rows[1]!.kind).toBe("note");
    expect(rows[1]!.text).toContain("812KB");
    expect(rows[1]!.outcome).toBeUndefined();
    // The gap on a note is the call's runtime, not the reader's business — see the bare row.
    expect(rows[1]!.waitedMs).toBeUndefined();
  });

  test("a result with no call left open still keeps its own row", () => {
    // An old record, from before the spill warning had its own kind, or a window that starts
    // mid-call. Either way it reads better as a row than as nothing.
    const rows = stepRows([step("tool_done", "exec ok · 41ms")]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBeUndefined();
  });

  test("a waiting step is a row of its own", () => {
    // An approval pause is something that happened to the turn, not a call with a result.
    const rows = stepRows([step("waiting", "waiting for you to approve `rm -rf /tmp/x`", 45_000)]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.waitedMs).toBe(45_000);
  });

  test("a message sent while it worked is no row, and the call after it keeps the whole wait", () => {
    // Sent while the model was deciding: `ms` is measured from the step before, so the message and the "Got it"
    // under it cut the 3.1s the model spent into three gaps, none of them worth a number on its own.
    const rows = stepRows([
      step("tool", "web_search deepseek flash v4"),
      step("tool_done", "web_search 36 found · 1195ms"),
      step("steer", "cari juga haiku 5.5 deh", 1500),
      step("steer_reply", "↪ Got it, I'll read that before my next step.", 100),
      step("tool", "web_search haiku 5.5", 1500),
    ]);

    expect(rows.map((row) => row.text)).toEqual(["web_search deepseek flash v4", "web_search haiku 5.5"]);
    expect(rows[1]!.waitedMs).toBe(3100);
  });
});

/**
 * A kind newer than this page — the stream may add one within its major version (`docs/EVENTS.md`). It is drawn
 * plainly, as a row of its own, not dropped and not dressed as a tool call the agent ran.
 */
describe("a kind this page has never heard of", () => {
  test("is a row of its own, marked plainly", () => {
    const newer = step("signal" as TurnStep["kind"], "a new kind of row");
    expect(stepIcon(newer)).toBe("•");
    const rows = stepRows([step("tool", "exec ls"), step("tool_done", "exec ok · 1ms"), newer]);
    expect(rows.some((row) => row.text === "a new kind of row")).toBe(true);
  });
});

/**
 * What the daemon says rather than what its line's words suggest (`callId`, `name`, `outcome`, 0.7.6 and 1.1). The
 * page paired a result with the oldest open call and read red off the words "failed", "timed out", "killed": parallel
 * calls finish in any order, and a reworded line would turn a red row green.
 */
describe("a call, as the stream describes it", () => {
  const call = (text: string, callId: string, name: string): TurnStep => ({ ...step("tool", text), callId, name });
  const done = (text: string, callId: string, outcome: TurnStep["outcome"]): TurnStep => ({ ...step("tool_done", text), callId, name: "exec", error: outcome !== "ok", outcome });

  test("parallel calls pair with their own results, whatever order they finish in", () => {
    const rows = stepRows([call("exec sleep 5", "a", "exec"), call("read notes.md", "b", "read"), done("read ok · 2ms", "b", "ok"), done("exec ok · 5s", "a", "ok")]);
    expect(rows.map((row) => [row.text, row.outcome])).toEqual([
      ["exec sleep 5", "ok · 5s"],
      ["read notes.md", "ok · 2ms"],
    ]);
  });

  test("red is how the call ended, not the words of its line", () => {
    const [answered] = stepRows([call("exec grep failed log", "a", "exec"), done("exec exit 1 · failed to match · 3ms", "a", "exit")]);
    const [stalled] = stepRows([call("exec curl", "b", "exec"), done("exec ok · 30s", "b", "timed_out")]);
    expect(answered?.failed).toBe(false);
    expect(stalled?.failed).toBe(true);
  });

  test("its icon comes from the tool's name", () => {
    expect(stepIcon({ kind: "tool", text: "looking around", name: "exec" })).toBe("💻");
    expect(stepIcon({ kind: "tool", text: "2 of 5 done", name: "plan" })).toBe("📋");
    // `plan`'s name until 0.7.16, in a conversation from before: a tool like any other.
    expect(stepIcon({ kind: "tool", text: "2 of 5 done", name: "task_plan" })).toBe("🔧");
  });
});
