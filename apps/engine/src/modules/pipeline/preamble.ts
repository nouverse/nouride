/**
 * The opening line before long work, said to the chat at once.
 *
 * Live: in a WhatsApp group a person waited eight minutes through a fifteen-step turn and saw nothing at all. Telegram
 * and Discord have the edited progress line (`chat-progress.ts`); WhatsApp cannot edit, so it had no sign of life. What
 * fixes it everywhere is what a person would do: say one sentence — "Oke Kak, aku cek 52 dokumennya dulu ya" — and then
 * work. The model writes that sentence in the same step as its first tool call; this decides whether it goes out.
 *
 * - The first one of a turn goes out immediately.
 * - A later one only when `gapMs` (two minutes) has passed since the last one sent: a status on long work, not a running
 *   commentary on every step. One held back is not lost — it is in the conversation like any assistant message.
 * - A message of its own goes out whatever the gap (`offer`'s `own`): a coding CLI's words between its steps are its
 *   messages, each said as it is written, as its own terminal shows them — held back, they reached the chat minutes
 *   later as one long answer, and the person felt ignored until then (0.8.5).
 * - The final answer is not sent again when it is word for word a line already sent (`alreadySaid`) — a turn cut off
 *   by its clock ends on the last step's words.
 *
 * Plain sends, so it works on a platform that cannot edit a message. Only a turn with a person waiting gets one —
 * `turn.ts` wires it for a chat message and not for a system event; helper, peer and scheduled turns never do.
 */

/** Two minutes between status lines — longer than a person waits before wondering, shorter than a long turn. */
export const PREAMBLE_GAP_MS = 120_000;

/** How long a line may hold the turn before its tools start: past this the send goes on alone and the work starts. */
const PREAMBLE_SEND_WAIT_MS = 5_000;

export class Preamble {
  private lastSentAt: number | undefined;
  private readonly said = new Set<string>();

  constructor(
    private readonly send: (text: string) => Promise<unknown>,
    private readonly options: {
      gapMs?: number;
      now?: () => number;
      /**
       * Whether the words call another agent by name. Such a line is kept for the answer: on a platform the other bot
       * reads it and starts a handover, and the answer naming the same agent would start a second one.
       */
      callsAnotherAgent?: (text: string) => boolean;
      sendWaitMs?: number;
    } = {},
  ) {}

  /**
   * Said to the chat when it is the turn's first, the gap has passed, or it is a message of its own (`own`); kept
   * internal otherwise. True when sent.
   */
  async offer(text: string, said: { own?: boolean } = {}): Promise<boolean> {
    const words = text.trim();
    if (!words || this.options.callsAnotherAgent?.(words)) return false;
    const now = (this.options.now ?? Date.now)();
    if (!said.own && this.lastSentAt !== undefined && now - this.lastSentAt < (this.options.gapMs ?? PREAMBLE_GAP_MS)) return false;
    this.lastSentAt = now;
    this.said.add(words);
    // Never holds the work for long: a platform that hangs on a send gets the line late, not the turn stuck behind it.
    const sent = this.send(words).catch(() => undefined);
    await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, this.options.sendWaitMs ?? PREAMBLE_SEND_WAIT_MS).unref?.())]);
    return true;
  }

  /** Whether the chat already has these words from this turn — the final answer is then not sent twice. */
  alreadySaid(text: string): boolean {
    return this.said.has(text.trim());
  }
}
