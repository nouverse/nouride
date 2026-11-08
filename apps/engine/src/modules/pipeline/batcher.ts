/**
 * Hold a burst of media from one sender for a moment, then push it as one message.
 *
 * A phone sending four photos sends four events milliseconds apart, and four turns is the wrong
 * answer to one act — the model answers the first picture before it has seen the rest. Text with no
 * attachment is never held: waiting on it would add latency to every ordinary message to fix a case
 * that only arises with media.
 */

import { contained, createLogger, type MessageEnvelope } from "@nouride/shared";
import { BATCH_WINDOW_MS } from "./deps.ts";
import { isEdit } from "./edit-rules.ts";
import { mergeEnvelopes } from "./messages.ts";

const log = createLogger("pipeline.batcher");

export class Batcher {
  private readonly buffers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; envelope: MessageEnvelope }
  >();

  /** `push` is the queue's, handed in rather than held: a batcher that could reach the queue's other
   * methods could drain it. */
  constructor(private readonly push: (envelope: MessageEnvelope) => void) {}

  accept(envelope: MessageEnvelope): void {
    const batchKey = `${envelope.gatewayId}:${envelope.chatId}:${envelope.senderId}`;
    const existing = this.buffers.get(batchKey);
    const hasMedia = Boolean(envelope.attachments && envelope.attachments.length > 0);

    // An edit is never folded into a burst: it is about another message, and in a merge it would read as one more thing
    // said. What the burst held goes first, in the order it was sent.
    if (isEdit(envelope)) {
      if (existing) this.release(batchKey);
      this.push(envelope);
      return;
    }

    if (!existing && !hasMedia) {
      this.push(envelope);
      return;
    }

    if (existing) {
      clearTimeout(existing.timer);
      existing.envelope = mergeEnvelopes(existing.envelope, envelope);
      existing.timer = this.window(batchKey);
    } else {
      this.buffers.set(batchKey, { envelope, timer: this.window(batchKey) });
    }
  }

  /** Push everything held, now. Called before `idle()` and `drain()` so a held burst cannot be
   * mistaken for an empty queue. */
  flush(): void {
    for (const key of [...this.buffers.keys()]) this.release(key);
  }

  /** A burst still held whose message `match` picks — for an edit of it. The burst itself, so a change to it is what is pushed. */
  find(match: (envelope: MessageEnvelope) => boolean): MessageEnvelope | undefined {
    for (const entry of this.buffers.values()) if (match(entry.envelope)) return entry.envelope;
    return undefined;
  }

  /** One burst, to the queue now. */
  private release(batchKey: string): void {
    const entry = this.buffers.get(batchKey);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.buffers.delete(batchKey);
    this.push(entry.envelope);
  }

  /**
   * The burst's window: when it closes, what was held goes to the queue as one message.
   *
   * A push that throws — the queue refusing, a drop it could not write down — is logged with the burst. Out of the
   * timer it was an uncaught exception, and the daemon shuts down on one. The messages are in the inbox, still
   * queued, so a restart takes them up.
   */
  private window(batchKey: string): ReturnType<typeof setTimeout> {
    return setTimeout(
      contained(log, "could not hand a held burst of media to the queue", () => {
        const entry = this.buffers.get(batchKey);
        if (!entry) return;
        this.buffers.delete(batchKey);
        this.push(entry.envelope);
      }, { batch: batchKey }),
      BATCH_WINDOW_MS,
    );
  }
}
