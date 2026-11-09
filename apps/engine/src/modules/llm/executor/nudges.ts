/**
 * Notes the harness adds to a tool result when a habit is costing the turn something.
 *
 * A rule in the prompt is read once, before the model has done anything; a note on a result is read
 * at the moment the habit shows. Both exist because the prompt alone had not moved the one below.
 */

import { sha256Text } from "@nouride/runtime";

/** What the loop already knows about the calls before this one. */
interface Step {
  name: string;
  ok: boolean;
  path?: string;
}

/**
 * A second `edit` to the same file in one turn, and the tool that would have done both at once.
 *
 * Measured on the live box over two weeks: 162 `edit` calls against one `multi_edit` — and that one
 * was a probe with no edits in it. 33 times a turn made two to seven `edit` calls in a row to one
 * file, 62 calls that one `multi_edit` each would have folded away. Every one of them was a round trip
 * re-sending the conversation and, under the default policy, an approval of its own; a failure
 * partway left the file half-changed, which `multi_edit` never does.
 *
 * Only for a call that worked: after a failed edit the next move is to fix that one, not to batch.
 */
export function repeatedEditNote(earlier: readonly Step[], call: { name: string; ok: boolean; path?: string }): string | null {
  if (call.name !== "edit" || !call.ok || !call.path) return null;
  const before = earlier.filter((step) => step.name === "edit" && step.ok && step.path === call.path).length;
  if (before === 0) return null;
  const file = call.path.split("/").pop() || call.path;
  return (
    `[harness] That is edit #${before + 1} to ${file} this turn. When you already know more than one change to a ` +
    "file, make them in ONE `multi_edit`: one call and one approval, and nothing is written unless every " +
    "change applies. Use it for the rest of the changes to this file."
  );
}

/** What one round asked for, as the chain check reads it. */
export interface RoundShape {
  /** The tool, when the round was exactly one call; absent for a round of several. */
  tool?: string;
  /** Whether that one call already used its tool's list parameter. */
  batched: boolean;
}

/**
 * The list parameter each read-only tool has, or `null` for one whose batch is several calls.
 *
 * `glob` has no list parameter, so for it the advice is the other half of the rule: several calls in
 * one reply, which the executor runs at the same time.
 */
const BATCH_SHAPES: Record<string, string | null> = {
  read: "`paths`",
  grep: "`patterns`",
  web_search: "`queries`",
  web_fetch: "`urls`",
  glob: null,
};

/** The round's shape, from the calls the model asked for in it. */
export function roundShape(calls: readonly { name: string; arguments: Record<string, unknown> }[]): RoundShape {
  if (calls.length !== 1) return { batched: calls.length > 1 };
  const [call] = calls;
  const list = { read: "paths", grep: "patterns", web_search: "queries", web_fetch: "urls" }[call!.name];
  return { tool: call!.name, batched: list !== undefined && Array.isArray(call!.arguments[list]) };
}

/**
 * A third reply in a row that asked one read-only tool for one thing.
 *
 * The same habit as `repeatedEditNote`, and the bigger one. Two weeks on the live box: 679 `read`
 * calls, 45 with `paths`, and 257 times a read was followed by another in the *next* reply — chains
 * ran to ten. `web_search` did it 92 times (a chain of seventeen), `grep` 60, `glob` 33. The prompt
 * already said to batch; it is read once, before the turn, and this is read at the moment it happens.
 *
 * On the third, not the second: two single reads in a row are often one read that revealed the next.
 * Three is a list the model already had. Once per tool per turn, so a turn that genuinely walks a
 * chain of references is told once and then left alone.
 */
export function singleCallChainNote(previous: readonly RoundShape[], current: RoundShape, told: ReadonlySet<string>): string | null {
  const tool = current.tool;
  if (!tool || current.batched || told.has(tool)) return null;
  if (tool === "exec") return execChainNote(previous);
  if (!(tool in BATCH_SHAPES)) return null;
  const last = previous.slice(-2);
  if (last.length < 2 || !last.every((round) => round.tool === tool && !round.batched)) return null;
  const list = BATCH_SHAPES[tool];
  const how = list
    ? `ask for them in ONE \`${tool}\` with ${list}`
    : `put the calls in ONE reply: they run at the same time`;
  return (
    `[harness] That is the third reply in a row that asked \`${tool}\` for one thing. Each reply re-sends this ` +
    `whole conversation. When you already know the next few you need, ${how}.`
  );
}

/**
 * The fourth reply in a row that sent one `exec` alone (0.7.17).
 *
 * The biggest habit of the expensive turns: two weeks on the live box, runs of single `exec` round trips had a median
 * of five and a 90th percentile of thirteen, and nearly half of those calls were one `ssh` each. The fourth, not the
 * third: a command often decides the next, and three is a short look around. Not batching — `exec` changes things —
 * but chaining: what is already known goes in one command, and the remote half in one `ssh`.
 *
 * It says so outright when each output decides the next command (0.7.24): read live as a false alarm during remote
 * probing, where there was nothing to chain, so the note now tells that case to carry on rather than leaving it to guess.
 */
function execChainNote(previous: readonly RoundShape[]): string | null {
  const last = previous.slice(-3);
  if (last.length < 3 || !last.every((round) => round.tool === "exec" && !round.batched)) return null;
  return (
    "[harness] That is four commands in four round trips, each re-sending this whole conversation. If you know the " +
    "next ones, send them in ONE `exec` (chained with `&&`, or as a script), and on another machine the whole " +
    "sequence in ONE `ssh host 'bash -s' <<'EOF' … EOF`. When each result decides the next command, this is not " +
    "about you: carry on as you were."
  );
}

/** Where a chat turn counts as long: this many calls made, or this long since it began. */
const LONG_TURN_CALLS = 8;
const LONG_TURN_MS = 120_000;

/** Calls into a turn at which work notes still unwritten are asked for outright (0.7.26). */
const NOTES_INSIST_AT = 8;

/**
 * Work whose notes say nothing of it (0.7.26). A model told in its tools to keep notes keeps them when it remembers to —
 * and the weaker the model, the less it does; the four-hour audit that lost its place had none. Live, the first tries of
 * this build: asked to do two of four and wait for "go on", Gemini Flash made three calls, then two, answered, and wrote
 * nothing — a count of calls says nothing about whether the work goes on; the person's words do, and the model reads them.
 *
 * So the harness asks twice, each once a turn, where the turn has written neither `notes` nor `plan`: on the first call's
 * result, where the conversation has no notes at all, on the condition that decides it — the work goes on past this
 * turn, or waits on a person; at the eighth call, outright. Not the first ask where notes exist: the model has the habit
 * there, and the ask would be one more line on every turn. On a tool's result rather than as a call of its own: read
 * before the answer is written, and no extra request.
 */
export function longWorkNotesNote(turn: { calls: number; offered: boolean; wrote: boolean; told: number; empty: () => boolean }): { note: string; told: number } | null {
  if (!turn.offered || turn.wrote) return null;
  if (turn.calls >= NOTES_INSIST_AT && turn.told < 2) {
    return {
      told: 2,
      note:
        "[harness] This is long work, and your work notes do not say where it stands. Write it to `notes` now (the goal, " +
        "what is done, what is next, the rules the person set and the facts you found), so a summary, the daily rollover or " +
        "a restart cannot lose it. Then go on.",
    };
  }
  if (turn.told < 1 && turn.empty()) {
    return {
      told: 1,
      note:
        "[harness] If this work goes on after this turn (the person will say go on, or you stop to wait for them or for " +
        "something to finish), write where it stands to `notes` before you answer: what is done, what is next, the rules " +
        "they set. If it ends with this answer, carry on.",
    };
  }
  return null;
}

/**
 * A chat turn that has run long, where a helper in the background could have the rest (0.7.15).
 *
 * Measured live the day background helpers shipped (2026-10-18): asked to check every link in the docs, an agent made
 * 24 calls in the foreground over four minutes, the person waiting on it the whole time — though TOOLS said a task
 * that takes a while goes to ONE helper in the background. A rule in the prompt is read before the work has shown how
 * long it is; this is read when it has, which is the reason for the two notes above as well.
 *
 * Once a turn, on the result of the call that crosses the line, and only where a helper can be started: `offered` is
 * the toolset's `backgroundHelpers`, which a helper's own turn, a peer's and a scheduled one do not carry. What is left
 * may be one step from done; the note says to finish then, so the model decides with the turn in front of it.
 */
export function longTurnHelperNote(turn: { calls: number; elapsedMs: number; offered: number; told: boolean; draft?: boolean }): string | null {
  if (turn.told || turn.offered <= 0) return null;
  if (turn.calls < LONG_TURN_CALLS && turn.elapsedMs < LONG_TURN_MS) return null;
  // Where the turn can draft a mission (0.8.11): long work is one, which the person sees and
  // starts — this note offered a helper alone, and the work the rule had misjudged stayed in the chat.
  const draft = turn.draft
    ? " If what is left is long work (many files or steps, a long research, a wait on CI), draft a `mission` for it instead, then tell them what you drafted and stop here."
    : "";
  return (
    `[harness] This turn has made ${turn.calls} calls over ${Math.round(turn.elapsedMs / 1000)} s, and the person is waiting on ` +
    "you while it runs. If what is left is more than a few steps and they do not need it this minute, hand it to ONE " +
    "helper in the background (`delegate` with `background: true`, and what you have found so far in the brief's " +
    `\`context\`), then tell them you are on it and stop here.${draft} If it is nearly done, finish it.`
  );
}

/** How the step that says a nudge was read begins — what the chat's progress line leaves out (`chat-progress.ts`). */
export const NUDGE_READ = "read a nudge: ";

/**
 * The step a run gone long records when it reads its nudge (`TurnRequest.harnessNote`, `pipeline/budget-nudges.ts`):
 * the note's first sentence — "You have been on this for 5 min." — so the record says when it reached the turn.
 */
export function nudgeRead(note: string): string {
  const said = note.replace(/^\[harness\]\s*/, "");
  return `${NUDGE_READ}${said.split(/(?<=\.)\s/)[0] ?? said}`;
}

/** The same call answered the same this many times in a row: told it will not change; at the second figure, the turn ends. */
const SAME_ANSWER_NOTE_AT = 3;
export const SAME_ANSWER_END_AT = 5;

/**
 * The same call, answered the same, again and again — polling, inside one turn, for something that only ever arrives
 * after it.
 *
 * On the live box (0.8.0) a mission whose call was parked for a person ran `nouride approvals` 40 times in one turn —
 * 1.5M tokens — waiting for an answer that comes as a message of its own; told in the parked result not to, it did
 * anyway. A call whose answer changes is never counted, so waiting on a service that comes up is not in its way.
 */
export class SameAnswers {
  private readonly last = new Map<string, { answer: string; times: number }>();

  /** How many times in a row this call has had this answer, this one counted. */
  count(call: { name: string; arguments: Record<string, unknown> }, content: string): number {
    const key = `${call.name}\u0000${JSON.stringify(call.arguments)}`;
    const answer = sha256Text(content);
    const before = this.last.get(key);
    const times = before?.answer === answer ? before.times + 1 : 1;
    this.last.set(key, { answer, times });
    return times;
  }
}

export function sameAnswerNote(times: number): string | null {
  if (times !== SAME_ANSWER_NOTE_AT) return null;
  return (
    `[harness] The same call has given the same answer ${times} times this turn. It will not change by asking again: ` +
    "an approval's answer, a job's end and a person's reply each come to you as a message of their own, after this " +
    "turn. Go on with other work, or end your turn."
  );
}
