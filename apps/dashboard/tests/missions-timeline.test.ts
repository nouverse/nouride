/**
 * A mission's turns as its page's timeline (0.8.8, `modules/missions/lib/timeline.ts`): why each started, in words a
 * person reads — each pattern a sentence the daemon writes — and the turns themselves, newest first, a run of the same
 * failure as one entry, the wait before a turn said where it was long.
 */

import { describe, expect, test } from "bun:test";
import type { ChatTurn } from "@/commons/lib/api";
import { reasonOf, timelineOf } from "@/modules/missions/lib/timeline";

/** A mission turn's prompt: its page, with the "Why this turn:" the daemon wrote, then the checklist's line. */
const page = (why: string) => `MISSION msn_1 — turn 2 · 5m of 8h · 1M of 100M tokens\nGoal: fix it\nDone when: a person accepts.\nWhy this turn: ${why}\nChecklist: 1 of 3 steps done`;

describe("why a turn started", () => {
  test("a wake-up's text read for what woke it — nox's answer, a job's end, a helper's, a wait, an approval", () => {
    // The page's line for a wake-up is its whole text: on msn_2fa88b the timeline read "[System event — not a message
    // from a person. Nobody is waiting on a reply.]".
    const event = "[System event — not a message from a person. Nobody is waiting on a reply.]\n@nix\n";
    expect(reasonOf({ prompt: page(`${event}The answer from nox has arrived, to what you asked at 22:31 (2m ago)`) })).toEqual({ kind: "answer", text: "nox answered" });
    expect(reasonOf({ prompt: page(`${event}Background job job_1 finished successfully after 7s: \`du -sh\``) })).toEqual({ kind: "job", text: "a background job finished" });
    expect(reasonOf({ prompt: page(`${event}Background job job_1 was interrupted by a restart after 11s`) })).toEqual({ kind: "job", text: "a background job was interrupted" });
    // `helper-wake-text.ts`: its id, its goal quoted, then how it went.
    expect(reasonOf({ prompt: page(`${event}Background helper job_2 ("count the lines") stopped before it finished its work.`) })).toEqual({ kind: "job", text: "a background helper stopped short" });
    expect(reasonOf({ prompt: page(`${event}Background helper job_2 ("count the lines") finished after 2m.`) })).toEqual({ kind: "job", text: "a background helper finished" });
    // `budget-nudges.ts`'s lead nudge, as 0.8.16 writes it and as turns stored before it carry it.
    expect(reasonOf({ prompt: page('[still working, not finished] nox has been working on "Code review…" for 10 min (job_23ae); it was asked') })).toEqual({ kind: "working", text: "nox still working, 10 min in" });
    expect(reasonOf({ prompt: page('[still working — not finished] nox has been working on "Code review…" for 10 min (job_23ae); it was asked') })).toEqual({ kind: "working", text: "nox still working, 10 min in" });
    expect(reasonOf({ prompt: page("[system] 5550001111 has just approved the `claude-code:Bash` call you asked about") })).toEqual({ kind: "approval", text: "claude-code:Bash approved" });
    expect(reasonOf({ prompt: page("[system] 5550001111 has just refused the `nouride` call you asked about") })).toEqual({ kind: "approval", text: "nouride refused" });
  });

  test("the mission's own reasons: its start, the next step, a person, a retry, a restart", () => {
    expect(reasonOf({ prompt: page("the mission starts. Write the checklist with `plan` first, then begin.") })).toEqual({ kind: "start", text: "the mission started" });
    expect(reasonOf({ prompt: page("continue with the next step.") })).toEqual({ kind: "next", text: "on to the next step" });
    expect(reasonOf({ prompt: page("Gading said to go on.") })).toEqual({ kind: "person", text: "Gading said to go on" });
    expect(reasonOf({ prompt: page("its model could not answer at the last try (overloaded). Trying again — carry on from the page.") })).toEqual({ kind: "retry", text: "tried again after its model failed" });
    expect(reasonOf({ prompt: page("the daemon restarted. Carry on from the page.") })).toEqual({ kind: "restart", text: "after a restart" });
    // `checking.ts` (0.8.10): its checks passed with a person's words unread — the sentence the daemon writes.
    expect(reasonOf({ prompt: page("your checks passed, but while they ran a person told you something you have not read — it is on this page. If it changes the work, do it; if not, call `mission` done again.") })).toEqual({
      kind: "told",
      text: "to read what a person told it during its checks",
    });
  });

  test("a wake-up none of these name reads as a system event, never its raw text; anything else as it was written", () => {
    expect(reasonOf({ prompt: page("[System event — not a message from a person.]\nsomething new") }).text).toBe("a system event");
    expect(reasonOf({ prompt: page("the reviewer found gaps: tests missing") })).toEqual({ kind: "other", text: "the reviewer found gaps: tests missing" });
    // A turn of no page at all: what started it, as the chat says it.
    expect(reasonOf({ prompt: "x", system: true, cause: { via: "job completion", outcome: "finished" } }).text).toBe("a background job finished");
  });
});

const turn = (n: number, over: Partial<ChatTurn> = {}): ChatTurn => ({
  id: `turn_${n}`,
  agentId: "nix",
  chatId: "msn_1",
  status: "done",
  prompt: page("continue with the next step."),
  reply: "",
  toolCalls: 1,
  startedAt: n * 60_000,
  endedAt: n * 60_000 + 30_000,
  durationMs: 30_000,
  steps: [],
  ...over,
});

describe("the turns, as entries", () => {
  test("newest first, numbered as they ran", () => {
    const entries = timelineOf([turn(1), turn(2), turn(3)]);
    expect(entries.map((entry) => (entry.kind === "turn" ? entry.number : 0))).toEqual([3, 2, 1]);
  });

  test("the same failure in a row is one entry, said once; a different one is its own", () => {
    // msn_2fa88b's first three: "Claude Code did not start: … You've hit your session limit", each a block of its own.
    const limit = "Claude Code did not start: session/prompt: Internal error: You've hit your session limit · resets 8:40pm (UTC)";
    const entries = timelineOf([
      turn(1, { status: "failed", error: limit }),
      turn(2, { status: "failed", error: limit }),
      turn(3, { status: "failed", error: limit }),
      turn(4, { status: "failed", error: "the model is overloaded" }),
      turn(5),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["turn", "turn", "repeat"]);
    const repeat = entries[2]!;
    expect(repeat.kind === "repeat" && [repeat.from, repeat.to, repeat.error, repeat.turns.length]).toEqual([1, 3, limit, 3]);
    expect(entries[1]!.kind === "turn" && entries[1]!.number).toBe(4);
  });

  test("the wait before a turn, where it was more than the daemon's own pace", () => {
    const entries = timelineOf([turn(1), turn(2), turn(40)]);
    // turn 2 started 30s after turn 1 ended; turn 40, 37m30s after turn 2.
    const waits = entries.map((entry) => entry.waitedMs);
    expect(waits).toEqual([37 * 60_000 + 30_000, null, null]);
  });
});
