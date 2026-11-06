/**
 * One question in front of a person at a time.
 *
 * ## The problem this solves
 *
 * Until now the executor refused to run two tool calls at once if either of them could stop for a
 * human — see `llm/executor/tool-batching.ts`. That rule conflates two different things. Whether two
 * calls can interfere is a question about the *machine*. Whether two calls can be answered at once is
 * a question about the *person*, and the person is the scarce one: a chat has exactly one of them and
 * they read it top to bottom.
 *
 * So the rule was doing double duty, and the cost was paid by the one tool where it matters most.
 * `ask_agent` hands work to another agent, which runs a whole turn of its own — a turn that can stop
 * for approval one level down, somewhere `canParallelise` cannot see. Marking it parallel-safe with
 * nothing else in place would race two prompts into one conversation, where a bare `/approve` cannot
 * tell them apart and the person cannot tell whose question they are looking at.
 *
 * The answer is not to serialize the work. It is to **parallelise the work and serialize the asking**:
 * two peers run at the same time, and at most one of them has the floor in front of the person.
 *
 * ## What holding the floor does and does not mean
 *
 * It is about *delivery*, not about being answerable. A queued request is `pending` in the database
 * like any other: `nouride approvals`, the dashboard and `/approve all` all see it and can answer it,
 * because an operator reaching the daemon through a token-guarded surface is entitled to answer
 * anything. What waits is the chat prompt, and only the chat prompt.
 *
 * The second consequence is the one that would otherwise be a bug: the request's own clock must not
 * start until it is shown. A five-minute window that spends four of those minutes behind somebody
 * else's question is a request that expires shortly after the person first reads it. `approvals.store`
 * therefore arms the expiry timer inside `show`, not at insert.
 *
 * ## Scope
 *
 * Per conversation, keyed by gateway instance *and* chat id — the same scope `pendingForChat` uses,
 * and for the same reason. Two chats are two people; making them wait for each other would be a
 * deadlock dressed as politeness.
 *
 * The conversation is the one the question is put in front of, not the one that asked: a mission's turn
 * asks in a conversation nobody reads, and its prompt goes to the chat the mission began in (`askedIn`).
 * Keyed by the asking one (0.8.7, live), a mission's second question waited 37 minutes behind its first
 * while the chat's own turn's question went straight past both — two queues in one chat, read as none.
 *
 * In memory, not in SQLite. A restart rebuilds it from the rows it keeps: each kept request enters the
 * floor again in the order it was asked (`SqliteApprovalGate.showKept`, D8), so the state is only ever
 * as old as the process.
 */

/** A prompt that has not been shown to anybody yet. */
export interface HeldPrompt {
  id: string;
  /**
   * Show this prompt now.
   *
   * `behind` is how many more are still waiting in this conversation, counted at the moment it is
   * shown rather than when it was queued — the number in a prompt has to be the number that is true
   * when somebody reads it.
   */
  show: (behind: number) => void;
  /**
   * While it is shown, the count behind it changed — one more asked, or one answered from somewhere else. The
   * number it went up with was true then; this keeps it true, or the person answers it and thinks they are done.
   */
  recount?: (behind: number) => void;
}

/**
 * Gateway instance and chat, as one key.
 *
 * Length-prefixed rather than joined on a separator. A chat id is whatever the platform says it is —
 * a Discord snowflake, a Telegram negative integer, a WhatsApp JID with an `@` and a `:` in it — so
 * "a character no id contains" is a claim nobody can check. This one needs no claim: only one split
 * of the string parses.
 */
export function chatKey(gatewayId: string, chatId: string): string {
  return `${gatewayId.length}:${gatewayId}${chatId}`;
}

export class ApprovalFloor {
  /** Conversation → the request currently in front of the person. */
  private holder = new Map<string, HeldPrompt>();
  /** Conversation → prompts waiting for it, oldest first. */
  private queue = new Map<string, HeldPrompt[]>();
  /** Request → conversation, so `leave` needs no database round trip on a hot path. */
  private room = new Map<string, string>();

  /**
   * Take the floor, or wait behind whoever has it.
   *
   * Returns whether the prompt was shown. The caller does not usually need the answer — `show` is
   * where everything happens — but a log line that says "queued" rather than "asked" is the
   * difference between a diagnosable delay and a silent one.
   */
  enter(key: string, held: HeldPrompt): boolean {
    this.room.set(held.id, key);
    const shown = this.holder.get(key);
    if (!shown) {
      this.holder.set(key, held);
      held.show(this.queue.get(key)?.length ?? 0);
      return true;
    }
    const waiting = this.queue.get(key) ?? [];
    waiting.push(held);
    this.queue.set(key, waiting);
    shown.recount?.(waiting.length);
    return false;
  }

  /**
   * The request a person in this conversation is actually looking at, if any.
   *
   * Read by a bare `/approve`. Without it, two pending requests made it ask "name one" and list two
   * ids — for a conversation where only one of them was ever on screen. The one being shown is both
   * the one they meant and the only one they could have meant.
   */
  displayed(key: string): string | null {
    return this.holder.get(key)?.id ?? null;
  }

  /** Whether this request is the one its conversation shows — not while it waits its turn, nor before it asked. */
  shown(id: string): boolean {
    const key = this.room.get(id);
    return key !== undefined && this.holder.get(key)?.id === id;
  }

  /**
   * These are being expired in bulk — never show them.
   *
   * `expireAll` finishes a list of requests one at a time, and each finish would otherwise promote the
   * next in line, which may be the next one on its own list. The person would watch a prompt appear
   * and expire in the same instant. Dropping them first means the floor passes to the first request
   * that is actually going to survive.
   */
  drop(ids: Iterable<string>): void {
    const doomed = new Set(ids);
    for (const [key, waiting] of [...this.queue]) {
      const kept = waiting.filter((held) => !doomed.has(held.id));
      if (kept.length === waiting.length) continue;
      if (kept.length === 0) this.queue.delete(key);
      else this.queue.set(key, kept);
      // What stays on screen says how many are left behind it — unless it is going with them.
      const shown = this.holder.get(key);
      if (shown && !doomed.has(shown.id)) shown.recount?.(kept.length);
    }
  }

  /** A request settled, however it settled. If it had the floor, the next one takes it. */
  leave(id: string): void {
    const key = this.room.get(id);
    this.room.delete(id);
    if (key === undefined) return;

    // Answered from the CLI or the dashboard while it was still queued: it never had the floor, so
    // nothing is promoted — it simply stops being in the line.
    if (this.holder.get(key)?.id !== id) {
      this.drop([id]);
      return;
    }

    this.holder.delete(key);
    const waiting = this.queue.get(key) ?? [];
    const next = waiting.shift();
    if (waiting.length === 0) this.queue.delete(key);
    if (!next) return;
    this.holder.set(key, next);
    next.show(waiting.length);
  }

  /** Shutdown. Nothing is promoted on the way out — the process is going. */
  clear(): void {
    this.holder.clear();
    this.queue.clear();
    this.room.clear();
  }
}
