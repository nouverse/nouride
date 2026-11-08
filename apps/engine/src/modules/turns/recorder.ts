/**
 * One turn being written down while it runs.
 *
 * A handle rather than a bag of store calls, because two things about recording a live turn are easy
 * to get wrong in the middle of `turn.ts` and cost nothing to get right here:
 *
 * - **The reply is throttled.** The executor sees text a few characters at a time. Writing each delta
 *   would be a database write per token; writing none until the end would leave the dashboard with
 *   the same blank wait it has now. So it flushes on an interval or a length, whichever comes first.
 * - **Not every activity event is a step.** `thinking` fires every few hundred milliseconds with a
 *   byte count. It belongs in the live progress line, not in a permanent list of what the agent did:
 *   it goes out as the stream's `thinking` frame to whoever watches (`TurnStore.pulse`) and is kept
 *   nowhere, and routing it here means every caller does the same.
 *
 * Failures are swallowed and logged. A monitor that can break a turn is worse than no monitor: the
 * turn is the thing the person asked for, and a full disk must not cost them their answer.
 */

import { contained, createLogger, type TurnEventData, type TurnStepKind } from "@nouride/shared";
import type { ActivityKind } from "@/commons/activity.ts";
import type { BeginTurn, FinishTurn, TurnAttachment, TurnsPort } from "./turns.store.ts";

const log = createLogger("turns.recorder");

/** How often the answer is written while it is written: after `ms`, so a slow one still appears, or `chars` of new text. */
export interface ReplyFlush {
  ms: number;
  chars: number;
}
const FLUSH: ReplyFlush = { ms: 400, chars: 240 };
/**
 * On a Box: every write lands on its card, and a partial answer a second late on the dashboard is nothing anybody
 * reads — the finished one is written with the turn's end either way.
 */
export const APPLIANCE_REPLY_FLUSH: ReplyFlush = { ms: 1_000, chars: 1_024 };

/** Which activity kinds become permanent steps — every one but `thinking`, a byte count every few hundred ms. */
const STEP_KINDS: Record<ActivityKind, TurnStepKind | null> = {
  thinking: null,
  reasoning: "reasoning",
  tool: "tool",
  tool_done: "tool_done",
  note: "note",
  waiting: "waiting",
  retry: "retry",
  compact: "compact",
};

/** Whose steps a helper's or a peer's are, written into the turn that started them (stream 1.2: `via`, `by`). */
export interface DelegatedSteps {
  via: "delegate" | "ask_agent";
  /** The agent that takes them — the turn's own for a helper, which runs as it; the peer for `ask_agent`. */
  by: string;
}

/**
 * The step sink of a helper or a peer: its steps are the turn's that started it, numbered on in that turn's log and
 * stamped with its conversation — so whoever may follow that conversation sees them, and nobody else does. Each is
 * marked whose (`via`, `by`), and its line too — `↳ ` for a helper, `[nox] ` for a peer — for a reader that knows
 * neither key: a 0.7.10 dashboard, `nouride turns show`. Nothing when there is no turn to write into.
 */
export function stepsInto(
  store: TurnsPort | undefined,
  turnId: string | undefined,
  as: DelegatedSteps,
): ((kind: ActivityKind, text: string, detail?: Record<string, unknown>) => void) | undefined {
  if (!store || !turnId) return undefined;
  const mark = as.via === "delegate" ? "↳ " : `[${as.by}] `;
  return (kind, text, detail) => {
    const mapped = STEP_KINDS[kind];
    try {
      if (!mapped) return store.pulse(turnId, `${mark}${text}`);
      store.step(turnId, mapped, `${mark}${text}`, { ...detail, via: as.via, by: as.by });
    } catch (err) {
      log.debug("a delegated step not recorded", { turn: turnId, error: String(err) });
    }
  };
}

/**
 * The request-line sink of a helper or a peer waited on (0.7.26): written into the turn that waits, as its steps are,
 * marked whose (`via`, `by`). Nothing when there is no turn to write into.
 */
export function contextInto(
  store: TurnsPort | undefined,
  turnId: string | undefined,
  as: DelegatedSteps,
): ((line: Omit<TurnEventData["context"], "via" | "by">) => void) | undefined {
  if (!store || !turnId) return undefined;
  return (line) => {
    try {
      store.context(turnId, { ...line, via: as.via, by: as.by });
    } catch (err) {
      log.debug("a delegated request line not recorded", { turn: turnId, error: String(err) });
    }
  };
}

export class TurnRecorder {
  private text = "";
  private flushedLength = 0;
  private lastFlush = 0;
  /** The held text's write, when the interval is up. */
  private tail: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly store: TurnsPort,
    readonly id: string,
    private readonly flush: ReplyFlush,
  ) {}

  /**
   * Start recording, or don't.
   *
   * Returns `undefined` when there is no store (a test bench, a one-shot tool) or when the insert
   * fails, so the caller's `record?.step(...)` is the whole of its error handling.
   */
  static begin(store: TurnsPort | undefined, input: BeginTurn, flush: ReplyFlush = FLUSH): TurnRecorder | undefined {
    if (!store) return undefined;
    try {
      return new TurnRecorder(store, store.begin(input), flush);
    } catch (err) {
      log.warn("could not start a turn record", { error: String(err) });
      return undefined;
    }
  }

  /** `detail` is kept with the step — a call's id, why a model call was asked again — and not shown live. */
  step(kind: ActivityKind, text: string, detail?: Record<string, unknown>): void {
    const mapped = STEP_KINDS[kind];
    try {
      // `thinking` is no step: said to whoever watches now (the stream's `thinking` frame), and kept nowhere.
      if (!mapped) return this.store.pulse(this.id, text);
      this.store.step(this.id, mapped, text, detail);
    } catch (err) {
      log.debug("step not recorded", { turn: this.id, error: String(err) });
    }
  }

  /** What one model request carried (0.7.26): kept with the turn, never a step. */
  context(line: TurnEventData["context"]): void {
    try {
      this.store.context(this.id, line);
    } catch (err) {
      log.debug("request line not recorded", { turn: this.id, error: String(err) });
    }
  }

  /** Replace what this turn says was attached to it. Swallows its own failures, like every write here. */
  attachments(list: TurnAttachment[]): void {
    try {
      this.store.setAttachments(this.id, list);
    } catch (err) {
      log.debug("attachments not recorded", { turn: this.id, error: String(err) });
    }
  }

  /** A text delta from the provider. Accumulated here, written when it is worth a write. */
  delta(delta: string): void {
    this.text += delta;
    const waited = Date.now() - this.lastFlush;
    if (this.text.length - this.flushedLength < this.flush.chars && waited < this.flush.ms) {
      // Held, and written when the interval is up though nothing more comes: a coding CLI says a line and then works
      // in silence for a minute, and the dashboard showed the line's first letter the whole while (0.8.1, the live box).
      this.tail ??= setTimeout(contained(log, "could not write a turn's held reply", () => this.writeReply()), this.flush.ms - waited);
      return;
    }
    this.writeReply();
  }

  private writeReply(): void {
    clearTimeout(this.tail);
    this.tail = undefined;
    this.lastFlush = Date.now();
    this.flushedLength = this.text.length;
    try {
      this.store.setReply(this.id, this.text);
    } catch (err) {
      log.debug("partial reply not recorded", { turn: this.id, error: String(err) });
    }
  }

  /**
   * The turn is over.
   *
   * `reply` is passed explicitly rather than taken from the accumulated deltas: what the person was
   * sent is the authority, and the two differ in the cases that matter most — a turn that produced no
   * text and got the fallback message, and a turn that failed and got the error.
   */
  finish(patch: FinishTurn): void {
    // The tail written since the last flush — up to 240 characters of most answers never reached the stream.
    if (this.text.length > this.flushedLength) this.writeReply();
    clearTimeout(this.tail);
    try {
      this.store.finish(this.id, patch);
    } catch (err) {
      log.warn("turn record left open", { turn: this.id, error: String(err) });
    }
  }
}
