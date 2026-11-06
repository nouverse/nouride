/**
 * The pipeline's side of the inbox (`inbox.store.ts` is the other): what is written down on arrival, what is too old to answer, the status a message moves through,
 * and what is put back after a restart.
 */

import { createLogger, type MessageEnvelope } from "@nouride/shared";
import { localTime, safeTimeZone } from "@/commons/clock.ts";
import { isSystemEvent, type PipelineDeps } from "./deps.ts";
import { INBOX_FRESH_MS, inboxId, inboxIds, sentAt, type InboxRow } from "./inbox.store.ts";
import { mergeEnvelopes } from "./messages.ts";

const log = createLogger("pipeline.inbox");

export class InboxDesk {
  /** Chats told recently that a message arrived too late to answer, so a backlog is one notice, not ten. */
  private readonly staleTold = new Map<string, number>();

  constructor(
    private readonly deps: Pick<PipelineDeps, "inbox" | "journal" | "notifier" | "config" | "chatEvents">,
    /** Where a message put back after a restart goes — the batcher, so a burst of media is one turn again. */
    private readonly batcher: { accept(envelope: MessageEnvelope): void; flush(): void },
    /** Whether a message is waiting in a running turn's steers (`TurnContext.holds`). */
    private readonly held: (envelope: MessageEnvelope) => boolean = () => false,
  ) {}

  /**
   * Write an admitted message down before anything acts on it, and decide whether it is answered at all.
   *
   * False for a message seen before — a platform redelivering what a process that died never confirmed —
   * and for one sent too long ago, a backlog after downtime: that one gets a notice instead of an answer,
   * because answering yesterday's question today is worse than saying it came in while nobody was here.
   * Both rules are the inbox's: without one (a test bench, a process that only answers) a message is
   * answered whenever it arrives, as it always was.
   */
  intake(envelope: MessageEnvelope): boolean {
    const inbox = this.deps.inbox;
    if (!inbox || isSystemEvent(envelope)) return true;
    const now = Date.now();
    if (!inbox.receive(envelope, now)) {
      log.info("a message received before is not answered twice", { gateway: envelope.gatewayId, chat_id: envelope.chatId });
      return false;
    }
    if (now - sentAt(envelope, now) <= INBOX_FRESH_MS) return true;
    inbox.settle(inboxIds(envelope), "unanswered", "stale", now);
    this.tellStale(envelope.gatewayId, envelope.chatId, sentAt(envelope, now));
    return false;
  }

  /**
   * Follow a message through its handling: taken by a turn, then handled — however it was handled. A
   * message whose turn the daemon could not finish is closed with its work kept and its person told, which
   * is handled too: it must not be answered again from the inbox after a restart.
   */
  async track(envelope: MessageEnvelope, handle: () => Promise<void>): Promise<void> {
    this.deps.inbox?.placed(inboxIds(envelope));
    try {
      await handle();
    } finally {
      const ids = inboxIds(envelope);
      const settled = ids.every((id) => this.settledWithTurn.has(id));
      for (const id of ids) this.settledWithTurn.delete(id);
      // Handed to a turn already at work in a room, to read at its next step: owed until it does — the
      // turn settles it then (`TurnContext.takeSteers`), and a restart before then answers it.
      if (this.held(envelope)) this.deps.inbox?.unplaced(ids);
      else if (!settled) this.deps.inbox?.settle(ids, "done");
    }
  }

  /** Inbox ids a turn settled in its own end (`settleWithTurn`), so `track` writes nothing more for them. */
  private readonly settledWithTurn = new Set<string>();

  /**
   * Handled, inside the transaction that ends the turn the message started (E7): the turn's record, its conversation
   * and the message it answered are one commit, where the message's own was one more after it. A crash after it and
   * before the reply is sent leaves the reply owed (`delivered_at = 0`), and the boot sends it — handled is true.
   */
  settleWithTurn(envelope: MessageEnvelope): void {
    if (!this.deps.inbox || isSystemEvent(envelope)) return;
    const ids = inboxIds(envelope);
    this.deps.inbox.settle(ids, "done");
    // Bounded, though `track` takes each back out: a turn nothing tracked would otherwise leave its ids for good.
    if (this.settledWithTurn.size > 1_000) this.settledWithTurn.clear();
    for (const id of ids) this.settledWithTurn.add(id);
  }

  /**
   * What a message said when it was written down, and when it was sent — what its edit is measured against (G11). Null
   * without an inbox, or for a message it never received.
   */
  recorded(gatewayId: string, chatId: string, messageId: string): { text: string; sentAt: number } | null {
    const row = this.deps.inbox?.find(inboxId(gatewayId, chatId, messageId));
    return row ? { text: row.envelope.text, sentAt: row.sentAt } : null;
  }

  /** A message still waiting, edited: the corrected one is what a restart answers. */
  revise(envelope: MessageEnvelope): void {
    if (!isSystemEvent(envelope)) this.deps.inbox?.revise(envelope);
  }

  /** A message the queue dropped. True when it is kept for after a restart — a shutdown — and nothing more is owed. */
  dropped(envelope: MessageEnvelope, reason: string): boolean {
    if (reason === "shutdown") return true;
    this.deps.inbox?.settle(inboxIds(envelope), "unanswered", "dropped");
    return false;
  }

  /**
   * Messages the last process received and never got to — put back now that the gateways are up, or
   * answered with a notice when they are too old (`boot/durable.ts`).
   */
  reopen(rows: readonly InboxRow[], now: number = Date.now()): { redelivered: number; stale: number; interrupted: number } {
    const counts = { redelivered: 0, stale: 0, interrupted: 0 };
    /**
     * What one person left waiting in one chat, as one message — in the order it was received. The batcher folds only
     * media, so text went back one message at a time and each was a turn: after a restart, 0.8.14 answered one question
     * five times, the five sent while the chat waited (2026-11-02).
     */
    const waiting = new Map<string, MessageEnvelope>();
    for (const row of rows) {
      // Taken by a turn that died with the process: that turn was closed with its work kept, and its
      // person told (`recoverTurns`). Not answered again.
      if (row.status === "placed") {
        this.deps.inbox?.settle([row.id], "unanswered", "interrupted", now);
        counts.interrupted += 1;
      } else if (now - row.sentAt > INBOX_FRESH_MS) {
        this.deps.inbox?.settle([row.id], "unanswered", "stale", now);
        this.tellStale(row.gatewayId, row.chatId, row.sentAt);
        counts.stale += 1;
      } else {
        const key = `${row.gatewayId} ${row.chatId} ${row.envelope.senderId}`;
        const before = waiting.get(key);
        waiting.set(key, before ? mergeEnvelopes(before, row.envelope) : row.envelope);
        counts.redelivered += 1;
      }
    }
    for (const envelope of waiting.values()) this.batcher.accept(envelope);
    // Queued now rather than after the batch window, ahead of what the restart itself set off: a person's
    // message from before it is answered before a background job it killed wakes its agent.
    if (counts.redelivered > 0) this.batcher.flush();
    return counts;
  }

  /**
   * What durable turns hold right now — `nouride doctor`. Turns in flight each have a journal; messages
   * waiting are in the inbox. Null when this process was built without them.
   */
  durability(): { inFlight: number; waiting: number } | null {
    if (!this.deps.journal || !this.deps.inbox) return null;
    return { inFlight: this.deps.journal.count(), waiting: this.deps.inbox.openCount() };
  }

  /** One notice per chat per quarter hour, saying when the message was sent. */
  private tellStale(gatewayId: string, chatId: string, sent: number): void {
    const key = `${gatewayId} ${chatId}`;
    const now = Date.now();
    if ((this.staleTold.get(key) ?? 0) > now - INBOX_FRESH_MS) return;
    // A notice older than the quarter hour holds nothing back, so it is not kept: the map holds the chats told lately,
    // not every chat ever told (`memory-growth-since-0-6`).
    for (const [chat, at] of this.staleTold) if (at <= now - INBOX_FRESH_MS) this.staleTold.delete(chat);
    this.staleTold.set(key, now);
    // The one clock (`commons/clock.ts`): a zone the runtime does not know reads as UTC here, as everywhere, rather
    // than throwing out of the notice that says a message was missed.
    const at = localTime(sent, safeTimeZone(this.deps.config.daemon.timezone)).time;
    const text = `\u26a0\ufe0f I was offline when you sent your message at ${at}, so I did not answer it. If you still need it, send it again.`;
    // On the timeline too: the dashboard's own connection hands a notice only to a request still waiting
    // for it, so a message answered with nothing there would read as ignored.
    this.deps.chatEvents?.record({ gatewayId, chatId, audience: "ui", kind: "dropped", text, details: { reason: "stale", sentAt: sent } });
    void this.deps.notifier
      ?.toChat({ gatewayId, chatId }, text)
      .catch((err: unknown) => log.warn("could not send the stale-message notice", { chat_id: chatId, error: String(err) }));
  }
}
