/**
 * A message for a coding CLI's turn, handed over while its prompt runs (0.8.10) — through
 * `_session/steering`, which claude-agent-acp and codex-acp offer. Before, a message sent while the CLI worked was its
 * next prompt, read once the running one ended: hours later, in a mission whose one prompt ran 2h42m — while the person
 * had been told "I'll read that before my next step".
 *
 * Never on top of a command: Claude's adapter moves a foreground tool call to the background
 * when a steer lands on it, and a test run's result would then go unread. Held while a tool call is open,
 * `STEER_HOLD_MS` at most, then sent anyway. The CLI stops the generation it was in to read it — that is how its
 * steering works, and the prompt answers once it has answered the steer too.
 *
 * Held, too, while the line in the agent's own words is written for them (`pipeline/steer-reply.ts`, no longer than
 * `steer_reply_timeout_ms`): taken at once, the CLI read them before that line existed, the line was dropped as late,
 * and the person was left with an English "Got it" (seen live, 2026-10-31). Held, the line is said first and the CLI
 * reads the words with it, as a model's turn does.
 *
 * What the CLI answers decides where the words went: `injected`, into this prompt; `startedNewTurn` (codex-acp, which
 * reads no `_meta`), a turn the CLI began for them by itself, whose words arrive as its own; `promptRequired` or
 * `failed`, not taken — the turn's next prompt, as before.
 */

import type { SteerOutcome } from "@nouride/acp";
import type { ChatMessage, ContentPart } from "@nouride/shared";

/** How long a message waits for an open tool call to end before it goes into the prompt anyway. */
const STEER_HOLD_MS = 5 * 60_000;
/** How often a held message looks again. */
const HOLD_POLL_MS = 500;

export interface MidPromptDeps {
  /** The messages waiting for the turn, taken — `TurnRequest.steer` — or null where none wait. */
  take: () => ChatMessage | null;
  /** Into the running prompt, as the CLI's content blocks. */
  send: (message: ChatMessage) => Promise<SteerOutcome>;
  /** A tool call is open in the prompt. */
  busy: () => boolean;
  /** A line in the agent's own words is being written for what waits (`pipeline/steer-reply.ts`). */
  replying?: () => boolean;
  /** Taken by the CLI, and so said in this turn. */
  taken: (message: ChatMessage, outcome: SteerOutcome) => void;
  holdMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One prompt's mid-prompt messages: poked as each is put in front of the turn, ended when the prompt ends. */
export class MidPrompt {
  private delivering: Promise<void> | null = null;
  private again = false;
  private ended = false;
  /** Not taken by the CLI: the turn's next prompt, in the order they came. */
  private left: ChatMessage | null = null;
  /** Ends the hold's wait before its next look. */
  private woken: (() => void) | null = null;

  constructor(private readonly deps: MidPromptDeps) {}

  /**
   * The last tool call open has ended: a held message looks again now rather than at its next poll. Live, Codex ran its
   * steps back to back, ten milliseconds apart; a look every half second found none of the gaps, and a question waited
   * 82 s for a pause.
   */
  wake(): void {
    this.woken?.();
  }

  /** A message was put in front of the turn. One delivery at a time; one poked meanwhile goes in the same. */
  poke(): void {
    if (this.ended) return;
    if (this.delivering) {
      this.again = true;
      return;
    }
    this.delivering = this.deliver().finally(() => {
      this.delivering = null;
    });
  }

  /**
   * The prompt ended: nothing more goes into it, and one on its way is waited for. Answers what the CLI did not take —
   * for the next prompt; what was still waiting in the turn is taken by the turn's own `steer` as before.
   */
  async end(): Promise<ChatMessage | null> {
    this.ended = true;
    await this.delivering;
    const left = this.left;
    this.left = null;
    return left;
  }

  private async deliver(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const holdMs = this.deps.holdMs ?? STEER_HOLD_MS;
    do {
      this.again = false;
      const since = now();
      while (!this.ended && (this.deps.busy() || this.deps.replying?.() === true) && now() - since < holdMs) {
        await new Promise<void>((resolve) => {
          this.woken = resolve;
          void sleep(HOLD_POLL_MS).then(resolve);
        });
        this.woken = null;
      }
      // Ended while held: the messages are still the turn's, and its next prompt takes them.
      if (this.ended) return;
      const message = this.deps.take();
      if (!message) continue;
      const outcome = await this.deps.send(message);
      if (outcome === "injected" || outcome === "startedNewTurn") this.deps.taken(message, outcome);
      else this.left = this.left ? merged(this.left, message) : message;
    } while (this.again && !this.ended);
  }
}

/**
 * Until the line in the agent's own words being written for what waits is said — before a prompt that ended hands it to
 * the next one, as `MidPrompt` waits before it hands it into a running one: a prompt that ends inside the seconds the line
 * takes would hand the words on at once, and the line be dropped as late. The hold bounds a writer that never ends.
 */
export async function untilSaid(replying: () => boolean, holdMs = STEER_HOLD_MS, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<void> {
  const since = Date.now();
  while (replying() && Date.now() - since < holdMs) await sleep(HOLD_POLL_MS);
}

/** Two messages for one prompt, in the order they came. */
export function merged(first: ChatMessage, then: ChatMessage): ChatMessage {
  if (typeof first.content === "string" && typeof then.content === "string") return { ...first, content: `${first.content}\n\n${then.content}` };
  const parts = (content: ChatMessage["content"]): ContentPart[] => (typeof content === "string" ? [{ type: "text", text: content }] : content);
  return { ...first, content: [...parts(first.content), { type: "text", text: "\n\n" }, ...parts(then.content)] };
}
