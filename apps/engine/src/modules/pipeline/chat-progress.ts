/**
 * What the agent is doing, shown in the conversation while it does it.
 *
 * The daemon has always produced this — `TurnExecutor` emits `tool`, `tool_done` and `waiting` as it
 * works, and the CLI has rendered them since Phase 3. Chat gateways were never wired to the same
 * stream, so from a phone a turn that reads four files and runs a command looked identical to one
 * that had hung.
 *
 * ## One message, edited
 *
 * Not a message per step. A twenty-iteration turn would be twenty messages and — the part that
 * settles it — twenty notifications on someone's phone. **Editing re-notifies nobody**, so the
 * conversation stays readable and the person's phone stays quiet.
 *
 * It is also why this is throttled rather than immediate: an edit per event would be a write per
 * tool call, and platforms rate-limit edits like anything else. One every `minIntervalMs`, always
 * carrying the newest state, is enough for a human reading along.
 *
 * ## Nothing to say, nothing sent
 *
 * The first message is posted on the first *tool*, never at turn start. A plain question that the
 * model simply answers produces no progress message at all, which is right: there was no progress to
 * report, and a "working…" that is immediately replaced by an answer is noise with extra steps.
 */

import { contained, createLogger, elide, type Gateway, oneLine, plural } from "@nouride/shared";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import type { ActivityKind } from "@/commons/activity.ts";
import { NUDGE_READ } from "@/modules/llm/executor/nudges.ts";

const log = createLogger("chat-progress");

/** Long enough that a burst of fast tools is one edit, short enough to read as live. */
const DEFAULT_MIN_INTERVAL_MS = 1500;

/**
 * How long the model works after its steps with nothing to show before the bubble says so, and how often the time it
 * gives moves on: one edit in ten seconds. A step a few seconds after the last never shows it.
 */
const QUIET_TICK_MS = 10_000;

/** Progress lines are one short sentence; anything longer is the answer's job. */
const MAX_LINE = 140;
/** A batch names several calls, so it gets more room than one — still short enough for a phone. */
const MAX_BATCH_LINE = 240;

/**
 * What the bubble draws of each kind: a call as a step; the daemon remarking — a spilled output, a retry, a compaction
 * ("compacting the conversation…" is what a phone shows while the summary takes its twenty seconds) — as a note; the
 * rest not at all. `thinking` and `reasoning` fire many times a turn and say nothing a person waiting can act on; a
 * `tool_done` is replaced by the next call at once; a wait seals the bubble instead (`seal`). Every kind, or this does
 * not compile.
 */
const BUBBLE = {
  thinking: null,
  reasoning: null,
  tool: "step",
  tool_done: null,
  note: "note",
  waiting: null,
  retry: "note",
  // Context upkeep is the daemon's business, not news for the person waiting (owner, 2026-10-21): it still runs, and the
  // turn record and the dashboard still show it. See `upkeep` for the notes that are upkeep under another kind.
  compact: null,
} as const satisfies Record<ActivityKind, "step" | "note" | null>;

/**
 * The kind of work, at a glance.
 *
 * Someone watching a phone is not reading the line, they are recognising a shape. A tool name alone
 * makes every step look identical until you read it; a mark in front means "reading" and "running a
 * command" are told apart without reading anything.
 */
const TOOL_MARKS: [RegExp, string][] = [
  [/^exec\b/, "💻"],
  [/^(read|memory_read)\b/, "📖"],
  [/^(write|edit|multi_edit|memory_write)\b/, "✏️"],
  [/^(glob|grep|search)\b/, "🔍"],
  [/^web_/, "🌐"],
  [/^delegate\b/, "👥"],
  [/^plan\b/, "📋"],
  [/^session/, "💬"],
  [/^skill_/, "🧩"],
  [/^(agent_|harness_|provider_)/, "⚙️"],
  // An MCP tool is `server__tool`, and which server it came from is the useful part.
  [/^[a-z0-9-]+__/i, "🔌"],
  // Context upkeep, which is a `note` rather than a call. See `note` below.
  [/^(compact|context full|the model's context)/, "🗜️"],
];

/**
 * A note about the context — an output kept as an excerpt, a context that overflowed — said as a retry or a note. And
 * a nudge the turn read (0.7.26): the harness talking to the model, for the record, not news for the person waiting.
 */
function upkeep(text: string): boolean {
  return /kept an excerpt, wrote the rest to a file|the model's context overflowed|^context full/.test(text) || text.startsWith(NUDGE_READ);
}

function mark(line: string): string {
  return TOOL_MARKS.find(([pattern]) => pattern.test(line))?.[1] ?? "🔧";
}

/**
 * One line, always.
 *
 * `describeToolCall` joins an argv with spaces, so `exec python3 -c "<script>"` arrives carrying every
 * newline of the script. In a terminal that wraps; in a chat message it is a wall of text where a
 * status line should be. Collapsed here rather than at the source, because the CLI renders the same
 * events in a place where more than one line is fine.
 *
 * The length cut is `elide`'s, not a second one of our own — see the note there. In practice a step
 * arrives already inside this budget and nothing is taken off; what this is really for is the
 * whitespace.
 */
function stepLine(text: string): string {
  return elide(oneLine(text), MAX_LINE);
}

export interface ChatProgressOptions {
  gateway: Gateway;
  chatId: string;
  /** Quote the message being worked on, so the line is attached to the request in a busy channel. */
  replyTo?: string | undefined;
  minIntervalMs?: number;
  /** `QUIET_TICK_MS`; shorter in a test. */
  quietTickMs?: number;
  /**
   * Prefixed on every progress line: `[nouva] ⏳ 📖 read …`.
   *
   * Set to the agent's `id` (lowercase, stable). Without it every agent's progress reads
   * identically. When nouva delegates to nix the platform shows "Nouva (Agent) typing" regardless
   * — which agent is actually working is invisible until it answers. A short label in front makes
   * the chain legible from a phone.
   */
  agentLabel?: string;
  /**
   * Report even when the turn called no tools.
   *
   * Off by default, and right to be: an ordinary turn that ran no tools has already said everything
   * it did — its answer *is* the trace, and a `✓ 0 steps` line above it is noise.
   *
   * A **peer** turn is the opposite. Its answer never reaches the conversation as its own message;
   * it goes back to the agent that asked, which folds it into a reply of its own. So the bubble is
   * the only sign the peer ran at all, and suppressing it at zero steps makes an agent that answered
   * from its prompt indistinguishable from one that was never asked. Two peers asked in parallel,
   * one of which used a tool, looked exactly like one peer being asked.
   */
  announceEmpty?: boolean;
  /**
   * The bubble is on the platform, under this id.
   *
   * So it can be recorded as the agent's. While a turn works, its bubble is the newest thing the agent has
   * said, and the message a person replies to — "use staging instead" under "⏳ 💻 exec deploy" — and a
   * reply to a message nobody recorded reaches nobody.
   */
  onPosted?: (messageId: string) => void;
}

export class ChatProgress {
  private messageId: string | undefined;
  private shown = "";
  private pending: string | undefined;
  private lastEditAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Per bubble, not per turn.
   *
   * Each bubble reports what *it* covered. A running total across approvals made one long turn read
   * as several cheap ones — the count kept climbing in a message the reader had scrolled past, and the
   * bubble that appeared after approving started at "step 13" with no way to see where that came from.
   */
  private steps = 0;
  /** Per-call steps still to come from a batch that was drawn as one line. */
  private absorb = 0;
  private startedAt = Date.now();
  private closed = false;
  /** Calls started and not yet done, across bubbles: a call waiting for approval runs on below the bubble it sealed. */
  private running = 0;
  /** When the last call ended with none running: the model at work since, thinking or writing, with no step to show. */
  private quietSince: number | undefined;
  /** Whether it has written any of its reply since then — what the quiet line says it is doing. */
  private writing = false;
  private ticker: ReturnType<typeof setTimeout> | undefined;
  /** Serialises writes: two edits in flight can land out of order and show a stale step. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly options: ChatProgressOptions) {}

  /** Whether this gateway can show progress at all. */
  static supported(gateway: Gateway): boolean {
    return typeof gateway.editMessage === "function";
  }

  /**
   * Record a step. Cheap and synchronous — the write happens on a timer.
   *
   * Never awaited by the caller: this runs from inside the tool loop, and a turn that waited on a
   * chat platform to acknowledge a status line would be slower for the sake of the status line.
   */
  step(text: string, blocked = false, like?: string): void {
    if (this.closed) return;
    const line = stepLine(text);
    if (!line) return;

    // `⏳` while it is our work, `⏸` while it is somebody else's — a turn parked on an approval is
    // not slow, it is waiting for a human, and those look identical without a mark that says so.
    const prefix = this.options.agentLabel ? `[${this.options.agentLabel}] ` : "";
    // One of a batch already drawn as a whole: counted there, and drawing it would replace that line.
    if (!blocked && this.absorb > 0) {
      this.absorb -= 1;
      return;
    }
    const rendered = blocked ? `${prefix}⏸ ${line}` : `${prefix}⏳ ${mark(like ?? line)} ${line}`;
    if (rendered === this.pending) return;

    this.steps += 1;

    // Summary style counts and stays quiet. The count is what `finish` reports, so the steps still
    // have to be tallied here — it is only the writing that is deferred to the end of the turn.
    if (this.summaryOnly) return;

    this.pending = rendered;
    this.schedule();
  }

  /**
   * One activity event, drawn if it is a kind the bubble shows.
   *
   * The decision lives here, not at the three call sites that feed a bubble: which kinds are worth a
   * line on a phone is a question about the bubble, and two sites answering it separately is how a
   * peer's bubble ended up showing less than the turn that asked it.
   *
   * `detail.like` is the tool of Nouride's a call is like, where its line does not start with one: a coding CLI's step
   * is its command alone, and every one of them was marked 🔧 (0.8.5).
   */
  show(kind: ActivityKind, text: string, detail?: Record<string, unknown>): void {
    if (kind === "tool") {
      this.running += 1;
      this.hush();
    } else if (kind === "tool_done" && this.running > 0) {
      this.running -= 1;
      if (this.running === 0) this.quiet();
    }
    if (upkeep(text)) return;
    const drawn = BUBBLE[kind];
    if (drawn === "step") this.step(text, false, typeof detail?.like === "string" ? detail.like : undefined);
    else if (drawn === "note") this.note(text);
  }

  /**
   * Several calls running at the same time, as one line.
   *
   * The bubble shows one line at a time, so four calls announced back to back showed only the last —
   * and a batch of four looked like one call. This line says they overlapped; the per-call `step`s
   * that follow are counted but not drawn, so they do not overwrite it.
   */
  batch(lines: string[]): void {
    if (this.closed || lines.length === 0) return;
    const prefix = this.options.agentLabel ? `[${this.options.agentLabel}] ` : "";
    this.steps += lines.length;
    this.absorb = lines.length;
    if (this.summaryOnly) return;
    const calls = lines.map((line) => `${mark(line)} ${stepLine(line)}`).join(" · ");
    this.pending = elide(`${prefix}⏳ ⚡ ${lines.length} at once: ${calls}`, MAX_BATCH_LINE);
    this.schedule();
  }

  /**
   * Something the daemon did that is not a call: compacting the conversation, trimming old results,
   * spilling a big output. Shown, because a turn doing it is otherwise a turn that looks stuck; not
   * counted, because the count is of what the agent did.
   */
  note(text: string): void {
    if (this.closed || this.summaryOnly) return;
    const line = stepLine(text);
    if (!line) return;
    const prefix = this.options.agentLabel ? `[${this.options.agentLabel}] ` : "";
    this.pending = `${prefix}⏳ ${mark(line)} ${line}`;
    this.schedule();
  }

  /** A piece of the reply, as it is written. Cheap: it only marks that the model is writing now, for the quiet line. */
  wrote(): void {
    this.writing = true;
  }

  /**
   * The model at work again with no call running — thinking, or writing its answer — and nothing on the bubble but the
   * last step. Said once that has gone on for a tick, then every tick, with how long: `⏳ ✍️ writing a reply… 40s`.
   *
   * A person's bubble read `✓ 1 step · 166s` for a turn whose one step took 18 s: the other 148 s Claude Code wrote a
   * long reply, and nothing said so — to a person waiting it looked like a hang (0.8.7). Its own timer, at the tick, so
   * a model that is silent while it thinks is said to be thinking all the same; one edit a tick, and no model asked.
   */
  private quiet(): void {
    this.hush();
    if (this.closed || this.summaryOnly) return;
    this.quietSince = Date.now();
    this.writing = false;
    this.arm();
  }

  private arm(): void {
    this.ticker = setTimeout(contained(log, "could not say how long the model has been at work", () => this.tick()), this.options.quietTickMs ?? QUIET_TICK_MS);
    this.ticker.unref?.();
  }

  /** The quiet line, drawn on the bubble the steps are on — never one of its own: a bubble with no step says nothing. */
  private tick(): void {
    this.ticker = undefined;
    if (this.closed || this.quietSince === undefined || this.steps === 0) return;
    const seconds = Math.round((Date.now() - this.quietSince) / 1000);
    const prefix = this.options.agentLabel ? `[${this.options.agentLabel}] ` : "";
    this.pending = `${prefix}⏳ ${this.writing ? "✍️ writing a reply" : "💭 thinking"}… ${seconds}s`;
    this.schedule();
    this.arm();
  }

  /** No quiet line from here: a step began, or the bubble is sealed or done. */
  private hush(): void {
    clearTimeout(this.ticker);
    this.ticker = undefined;
    this.quietSince = undefined;
  }

  /** See `Gateway.progressStyle`. */
  private get summaryOnly(): boolean {
    return this.options.gateway.progressStyle === "summary";
  }

  /**
   * Close the current bubble and start a new one for whatever comes next.
   *
   * Called when something interrupts the turn and posts its own message — an approval prompt. From
   * then on the live bubble is no longer the last thing in the conversation: it sits above the prompt,
   * above the person's `/approve`, above the daemon's acknowledgement. Editing it keeps the numbers
   * moving somewhere nobody is looking, so from the bottom of the chat the agent appears to have
   * stopped dead after approval — which is exactly what it looked like.
   *
   * Sealing writes the count so far and forgets the id. The next `step()` posts fresh, below the
   * approval, where the person actually is.
   *
   * Not `finish`: the turn is not over, and a `✓` beside a wait would claim it was. Without a reason it is the agent's
   * own words that come next (`preamble.ts`): the steps above them are done, and say so with a `✓` — the next bubble is
   * the turn going on.
   */
  async seal(reason?: string): Promise<void> {
    if (this.closed) return;
    this.hush();

    /**
     * Nothing to seal when nothing is live.
     *
     * Sealing exists because an approval prompt pushes the live bubble out of view. In summary style
     * there is no bubble to be pushed anywhere, and the counts deliberately keep running: one closing
     * line covering the whole turn is the point, and a turn that paused for an approval is still one
     * turn.
     */
    if (this.summaryOnly) return;

    // A post still on its way is a bubble: waited for, then closed. Sends are paced a second apart per chat, and a coding
    // CLI says its next words milliseconds after a step — taken for no bubble, it was closed a message too late (0.8.5).
    await this.inFlight;
    if (this.closed) return;

    // Nothing recorded and nothing posted: a turn parked before its first tool has no bubble, and must
    // not invent one.
    if (!this.messageId && this.pending === undefined) return;

    /**
     * Flushed **now**, throttle ignored.
     *
     * A tool that needs approval fires `tool` and `waiting` milliseconds apart, so the throttle has not
     * elapsed and nothing has been posted yet. Left to the timer, the bubble would land *below* the
     * approval prompt — which is exactly what it did: `✓ 1 step · 28s` sitting underneath the question
     * it was supposed to precede.
     */
    clearTimeout(this.timer);
    this.timer = undefined;

    const seconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    const steps = plural(this.steps, "step");
    const prefix = this.options.agentLabel ? `[${this.options.agentLabel}] ` : "";
    this.pending = reason === undefined ? `${prefix}✓ ${this.steps} ${steps} · ${seconds}s` : `${prefix}⏸ ${this.steps} ${steps} · ${seconds}s (${stepLine(reason)})`;
    await this.flush();

    // Forget the message and start the next bubble's count from zero. The sealed one stays where it is.
    this.messageId = undefined;
    this.shown = "";
    this.pending = undefined;
    this.steps = 0;
    this.absorb = 0;
    this.startedAt = Date.now();
  }

  /**
   * Post the closing line now, because it has to come *before* the answer.
   *
   * In summary style, and it is a position problem rather than a timing one. A live bubble was
   * created on the first tool and already sits above the answer, so `finish` can edit it whenever —
   * which is why the call in `turn.ts` is deliberately not awaited: a turn that waited on a chat
   * platform to acknowledge its own status line would hold the queue for it.
   *
   * Live, the steps the throttle has not posted yet are not posted at all — a coding CLI answers milliseconds after its
   * last step, inside the throttle, and its answer says what they did. Left to the timer, their bubble went out after
   * the answer and stayed ⏳ under it for good (0.8.5). One already on its way lands above the answer, and `finish`
   * closes it.
   *
   * In summary style there is no message yet, so whenever `finish` runs is where the line lands. Left
   * in the `finally` block it landed *under* the reply, reading as a footnote to an answer that was
   * already finished. One send before the answer is the cost of it being above.
   *
   * Safe to miss: `finish` is idempotent and is still called in `finally`, so a reply path that
   * forgets this only gets the old placement back.
   */
  async beforeAnswer(outcome: "ok" | "failed"): Promise<void> {
    if (this.summaryOnly) return this.finish(outcome);
    this.hush();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.messageId) this.pending = undefined;
  }

  /**
   * Replace the live line with a one-line record of what happened.
   *
   * Kept rather than deleted. The trace is the useful part afterwards — "it ran four tools and took
   * twelve seconds" answers the question people actually ask when an answer looks thin — and keeping
   * it needs no delete capability, which is one less thing for a gateway to implement and fail at.
   */
  async finish(outcome: "ok" | "failed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.hush();
    clearTimeout(this.timer);
    this.timer = undefined;
    // A post still on its way is the bubble, closed once it is there (see `seal`).
    await this.inFlight;

    /**
     * Nothing was ever posted, so there is nothing to tidy: a turn with no tools leaves no trace.
     *
     * In summary style nothing is *ever* posted before this point, so the test is the step count
     * instead — but the rule it enforces is the same one, and a turn that ran no tools still says
     * nothing. `flush` sends rather than edits when there is no message id, so this needs no separate
     * path.
     */
    const silent = this.summaryOnly ? this.steps === 0 : !this.messageId;
    if (silent && !this.options.announceEmpty) return;

    const seconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    // Not named `mark` — that is the module function above, and shadowing it here would work today
    // and break the moment someone adds a tool mark to the summary line.
    const outcomeMark = outcome === "ok" ? "✓" : "✕";
    const steps = plural(this.steps, "step");
    const prefix = this.options.agentLabel ? `[${this.options.agentLabel}] ` : "";
    this.pending = `${prefix}${outcomeMark} ${this.steps} ${steps} · ${seconds}s`;
    await this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, (this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS) - (Date.now() - this.lastEditAt));
    // Contained, though `flush` catches what a gateway does to it: out of a timer, anything it missed would be an
    // uncaught exception, and the daemon shuts down on one — for a status line.
    this.timer = setTimeout(
      contained(log, "could not update a progress line", () => {
        this.timer = undefined;
        return this.flush();
      }, { chat_id: this.options.chatId }),
      wait,
    );
    // Never a reason to hold the process open: an unsent status line is not worth delaying shutdown.
    this.timer.unref?.();
  }

  private flush(): Promise<void> {
    const text = this.pending;
    if (text === undefined || text === this.shown) return this.inFlight;
    // A cron session (`cron:<jobId>`) is an address on no platform: a status line there is a failed send
    // per step. The turn's reply finds its way out through `Voice.reply`; the progress line has nowhere to go.
    if (cronJobOfChat(this.options.chatId) !== null) {
      this.pending = undefined;
      return this.inFlight;
    }

    this.pending = undefined;
    this.lastEditAt = Date.now();

    // Chained, so the send that creates the message always completes before the first edit tries to
    // target its id — and so two edits cannot race into the wrong order.
    this.inFlight = this.inFlight
      .then(async () => {
        if (this.messageId) {
          await this.options.gateway.editMessage?.(this.options.chatId, this.messageId, text);
        } else {
          const ids = await this.options.gateway.send({
            gatewayId: this.options.gateway.id,
            chatId: this.options.chatId,
            text,
            // A URL inside a command is incidental to the status line. Left alone, Telegram renders a
            // preview card for a page nobody asked about, on the message that exists to say one thing.
            suppressPreview: true,
            ...(this.options.replyTo ? { replyTo: this.options.replyTo } : {}),
          });
          // No id means the gateway buffered it while disconnected. Leaving `messageId` unset makes
          // the next flush try to send again, which is the right behaviour: there is nothing to edit.
          this.messageId = ids[0];
          if (this.messageId) this.options.onPosted?.(this.messageId);
        }
        this.shown = text;
      })
      .catch((err: unknown) => {
        // A status line that cannot be delivered must never affect the turn it is describing.
        log.debug("progress update failed", { chat_id: this.options.chatId, error: String(err) });
      });

    return this.inFlight;
  }
}
