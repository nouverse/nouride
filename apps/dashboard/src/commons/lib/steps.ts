/**
 * How a step is labelled and how long things read.
 *
 * Presentation only, and deliberately dumb: everything about *what happened* comes from the daemon
 * now. This file's whole job is to turn `exec bun test` into something with an icon in front of it,
 * and 224318 into `3m 44s`.
 */

import type { TurnStep, TurnStatus } from "@/commons/lib/api";

const TOOL_MARKS: [RegExp, string][] = [
  [/^exec\b/, "💻"],
  [/^(read|memory_read|read_file)\b/, "📖"],
  [/^(write|edit|multi_edit|memory_write|write_file|edit_file)\b/, "✏️"],
  [/^(glob|grep|search|find_path)\b/, "🔍"],
  [/^web_/, "🌐"],
  [/^(delegate|ask_agent)\b/, "👥"],
  [/^plan\b/, "📋"],
  [/^session/, "💬"],
  [/^skill_/, "🧩"],
  [/^send_file\b/, "📎"],
  [/^nouride\b/, "⚙️"],
  [/^(agent_|harness_|provider_)/, "⚙️"],
  [/^[a-z0-9-]+__/i, "🔌"],
];

/**
 * The icon for one step.
 *
 * Keyed on the kind first, and that ordering matters: a reasoning line that happens to begin with the
 * word "read" is not a file read. Sniffing the text was how thinking ended up under the same mark as
 * a tool call, which reads as something the agent *did*.
 */
export function stepIcon(step: Pick<TurnStep, "kind" | "text" | "name">): string {
  const mark = KIND_MARKS[step.kind as TurnStep["kind"]];
  // A kind newer than this page — the stream may add one within its major version (`docs/EVENTS.md`). Shown plainly,
  // not as a tool call the agent ran.
  if (mark === undefined) return "•";
  if (mark !== "call") return mark;
  // The tool's name where the stream gave it; the line's first word only for a turn from before it did.
  return TOOL_MARKS.find(([pattern]) => pattern.test(step.name ?? step.text))?.[1] ?? "🔧";
}

/**
 * Each step kind's mark — every kind of `TurnStep`, which the contract test holds to the daemon's, or this does not
 * compile. A remark about a call (`note`) is marked so it does not read as a tool the agent ran; a retry and a
 * compaction carry the marks the chat bubble uses; `steer` and `steer_reply` are drawn as said, not as steps.
 */
const KIND_MARKS = {
  reasoning: "🧠",
  tool: "call",
  tool_done: "call",
  note: "ℹ️",
  waiting: "⏸",
  steer: "•",
  steer_reply: "•",
  retry: "🔁",
  compact: "🗜️",
} as const satisfies Record<TurnStep["kind"], string>;

/**
 * A finished turn's tokens as its pill says them — `15,600 in / 260 out tokens` — or nothing when its record holds none.
 * A coding CLI's turn is recorded with 0 in and 0 out: what its CLI spent is its plan's, recorded prompt by prompt as a
 * model call. "0 in / 0 out tokens" sat above "3,207,215 in / 55,013 out" under Model calls as though the two disagreed
 * (0.8.12); the figure is the model call's, listed under it, and a zero here is no figure at all.
 */
export function turnTokens(input: number | undefined, output: number | undefined): string | null {
  if (input === undefined || (input === 0 && !output)) return null;
  return `${input.toLocaleString()} in${output === undefined ? "" : ` / ${output.toLocaleString()} out`} tokens`;
}

/** `480ms`, `12s`, `3m 44s`. Whole seconds: a tenth of a second is noise at this scale. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * A running clock: `0s`, `4s`, `1m 5s`. Floored, so it ticks once a second instead of rounding up
 * early and appearing to skip.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * One row per tool call, instead of two.
 *
 * The daemon emits a `tool` step when a call starts and a `tool_done` when it ends, which is right
 * for a live feed and wrong for a list: every call took two rows, and the second one repeated its own
 * duration — once inside the text the daemon wrote, once in the column on the right.
 *
 *     💻 exec which chromium chromium-browser google-chrome     7.2s
 *     💻 exec failed · 3ms                                       4ms
 *
 * Four numbers and two icons for one command. Worse, the `7.2s` on the first row is not what the
 * label claims: `ms` is the gap since the *previous* step, so on a call row it measures how long the
 * model spent deciding, and only on the `tool_done` row does it measure the call. The pair now
 * collapses into the call, with the outcome the daemon wrote on the right where the duration was:
 *
 *     💻 exec which chromium chromium-browser google-chrome     +7.2s  exit 1 · 3ms
 *
 * The thinking gap is kept because on a slow turn it is the interesting number, and shown only when
 * it is worth a reader's attention.
 */
export interface StepRowModel {
  seq: number;
  kind: TurnStep["kind"];
  text: string;
  /** What the daemon said about the result — `ok · 438ms`, `exit 1 · 3ms`, `12 found · 45ms`. */
  outcome?: string;
  /** True only for a result that is a fault, not a command answering "no" — see `isFault` and `FAULTS`. */
  failed?: boolean;
  /** Milliseconds between the previous step and this call: the model deciding, not the call running. */
  waitedMs?: number;
  /** A call with nothing closing it yet. */
  running?: boolean;
  /** The call it pairs by, and the tool — from the stream; absent on a turn from before 0.7.6. */
  callId?: string;
  name?: string;
}

/** Gaps below this are not worth a number on screen. */
const WAIT_WORTH_SHOWING_MS = 2000;

/** Said while the turn worked, rather than done by it — see `saidWhileWorking`. */
const SAID = new Set<TurnStep["kind"]>(["steer", "steer_reply"]);

/**
 * The conversation inside a turn: a message sent while it worked (`steer`), and what its sender was told back at
 * once (`steer_reply`) — "↪ Got it", then a line in the agent's own words. In the order it was said.
 *
 * Kept out of the steps. Nothing here is the agent doing anything, and drawn as a row each would have read as a
 * call it made.
 */
export function saidWhileWorking(steps: TurnStep[]): TurnStep[] {
  return steps.filter((step) => SAID.has(step.kind));
}

/** What the turn did — everything but what was said while it did it. */
export function workSteps(steps: TurnStep[]): TurnStep[] {
  return steps.filter((step) => !SAID.has(step.kind));
}

/**
 * A result closes the **oldest call still open**, not whatever step happens to sit above it.
 *
 * Adjacency was the rule until a screenshot arrived of a working turn full of spinners that never
 * stopped. Two things put a step between a call and its result, and both were common:
 *
 * - an auto-approved call emitted a second `tool` step carrying the same command with `(auto)` on
 *   the end, so the real call was never adjacent to anything but another call — it span forever and
 *   the duplicate below it carried the outcome. One live turn: eleven successful writes, eleven
 *   spinners that never stopped. Fixed on the daemon side too — the marker is on the result line.
 * - an approval pause emits a `waiting` step in between, so **every** manually approved call left a
 *   spinner behind and a stray result row under it.
 *
 * Oldest-first rather than newest-first because that is the order the daemon emits results in: a
 * parallel group announces its calls in the order the model asked for them and reports their
 * outcomes in that same order, whatever order they finished in (`executor/index.ts`). Newest-first
 * would pair the first result with the last call of every batch.
 *
 * The third thing that lands between a call and its result — a spilled-output warning — is not
 * handled here at all any more. It used to be a `tool_done` and closed the call it was about, taking
 * the outcome slot and leaving the real result with nothing to attach to. It is a `note` now, which
 * is a row and never a result. See the kind in the daemon's `commons/activity.ts`.
 */
export function stepRows(steps: TurnStep[]): StepRowModel[] {
  const rows: StepRowModel[] = [];
  /** Calls with nothing closing them yet, oldest first. */
  const open: StepRowModel[] = [];
  /**
   * The gap a message landed in. `ms` is measured from the step before, so a message sent while the model was
   * deciding splits that wait in two — and the call after it would claim only the half since the message.
   */
  let carried = 0;

  for (const step of steps) {
    if (SAID.has(step.kind)) {
      carried += step.ms ?? 0;
      continue;
    }
    const waited = (step.ms ?? 0) + carried;
    carried = 0;
    if (step.kind === "reasoning") continue;

    // A remark, not a result: its own row, and it closes nothing. Bare, like the orphan below —
    // `ms` on one of these is the gap since the call started, which is the call's business. A retry and a
    // compaction are remarks of the same kind.
    if (step.kind === "note" || step.kind === "retry" || step.kind === "compact") {
      rows.push({ seq: step.seq, kind: step.kind, text: step.text });
      continue;
    }

    if (step.kind === "tool_done") {
      // Paired by the call's id where the stream gave one — parallel calls finish in any order — and by position,
      // oldest first, only for a turn from before it did.
      const at = step.callId ? open.findIndex((call) => call.callId === step.callId) : 0;
      const call = at >= 0 ? open.splice(at, 1)[0] : undefined;
      // Nothing open: a result whose call is older than the window, or an old record from before
      // spilled-output warnings had a kind of their own. Reads fine on its own either way.
      if (!call) {
        rows.push({ seq: step.seq, kind: step.kind, text: step.text });
        continue;
      }
      call.outcome = outcomeOf(call.text, step.text);
      // How it ended, as the daemon says it; the line's words only for a turn from before it did.
      call.failed = step.outcome ? FAULTS.has(step.outcome) : isFault(step.text);
      delete call.running;
      continue;
    }

    const row: StepRowModel = {
      seq: step.seq,
      kind: step.kind,
      text: step.text,
      ...(step.callId ? { callId: step.callId } : {}),
      ...(step.name ? { name: step.name } : {}),
      ...(step.kind === "tool" ? { running: true } : {}),
      ...(waited >= WAIT_WORTH_SHOWING_MS ? { waitedMs: waited } : {}),
    };
    rows.push(row);
    if (step.kind === "tool") open.push(row);
  }

  return rows;
}

/**
 * The result, without the tool name repeated.
 *
 * The daemon writes `exec exit 1 · 3ms`, and the name is already the first word of the row it is
 * being folded into. Read off rather than re-derived, because the daemon is the only thing that knows
 * how long the call took and what its metadata said — this is presentation, and the numbers are its.
 */
function outcomeOf(callText: string, doneText: string): string {
  const name = callText.split(" ")[0] ?? "";
  const stripped = doneText.startsWith(`${name} `) ? doneText.slice(name.length + 1) : doneText;
  return stripped.trim();
}

/** A result that is the call not doing its job — red. A command that answered with a non-zero exit is not one. */
const FAULTS = new Set(["failed", "timed_out", "killed"]);

/**
 * Whether a result is a fault or an answer.
 *
 * The distinction the old single word could not make. `which` exits 1 to say "not installed", and
 * three rows of red `failed` on a screen where nothing was wrong is what made a working turn look
 * broken. A non-zero exit is muted; only a refusal, a throw, a timeout or a kill is red.
 */
function isFault(doneText: string): boolean {
  return /\b(failed|timed out|killed)\b/.test(doneText);
}

/**
 * What a running turn is doing at this moment, in one line — a mission's "now" (0.8.0). Read as the live feed reads it
 * (`StepFeed`): a call with nothing closing it is running, the newest of them if several are; a wait is a call parked
 * on a person; otherwise the model is between steps, deciding — with its newest thought when it said one.
 */
export function stepNow(steps: TurnStep[]): { what: "call" | "waiting" | "thinking"; text: string | null } {
  const open = stepRows(steps).filter((row) => row.running);
  const call = open[open.length - 1];
  if (call) return { what: "call", text: call.text };
  const done = workSteps(steps);
  const last = done[done.length - 1];
  if (last?.kind === "waiting") return { what: "waiting", text: last.text };
  return { what: "thinking", text: last?.kind === "reasoning" ? last.text.slice(0, 400) : null };
}

/** How many steps a turn is credited with — the things it did, not the notes it made to itself. */
export function countedSteps(steps: TurnStep[]): TurnStep[] {
  return steps.filter((step) => step.kind === "tool" || step.kind === "waiting");
}

/** The model's own account of its working, in order, as one block. */
export function reasoningText(steps: TurnStep[]): string {
  return steps
    .filter((step) => step.kind === "reasoning")
    .map((step) => step.text)
    .join("\n");
}

/**
 * `<think>` blocks, for providers that put reasoning in the answer.
 *
 * The daemon strips reasoning out of the text it stores when the provider streams it separately; some
 * models write it inline instead, and leaving that on screen shows the reader the model's rough
 * draft as though it were the reply.
 */
export function splitThinking(raw: string): { thinking?: string; content: string } {
  const match = /<think>([\s\S]*?)(?:<\/think>|$)/i.exec(raw);
  if (!match) return { content: raw };
  const thinking = match[1]?.trim();
  return {
    ...(thinking ? { thinking } : {}),
    content: raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
  };
}

/** What a finished turn's pill says, and in what colour. */
export function statusMark(status: TurnStatus): { mark: string; tone: string; label?: string } {
  switch (status) {
    case "done":
      return { mark: "✓", tone: "text-success" };
    case "failed":
      return { mark: "✕", tone: "text-error", label: "failed" };
    case "cancelled":
      return { mark: "⊘", tone: "text-warning", label: "stopped" };
    case "interrupted":
      return { mark: "⚠", tone: "text-warning", label: "interrupted" };
    default:
      return { mark: "…", tone: "text-primary" };
  }
}
