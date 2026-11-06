/**
 * What an asleep agent does with what reaches it (0.8.0 — asleep replaced Pause): it takes no work from anywhere.
 *
 * - A person's message is not answered, and the chat is told so at most once an hour — silence read as a crash, and a
 *   notice per message would be the flood.
 * - What the daemon itself sends it — a job that ended, an approval answered, a mission's next turn — is kept, and goes
 *   back into the queue in order when it wakes: running jobs keep running while it sleeps and report when it wakes.
 *
 * In memory: a restart is itself a wake for what the last process held, which the jobs' own boot report repeats.
 */

import type { MessageEnvelope } from "@nouride/shared";

/** At most this many kept per agent: a job that ends every minute through a night must not grow without bound. */
const HELD_MAX = 50;
const TELL_EVERY_MS = 60 * 60_000;

export class Asleep {
  private readonly held = new Map<string, MessageEnvelope[]>();
  private readonly told = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Back into the queue — set by the pipeline, which owns it. */
  requeue: (envelope: MessageEnvelope) => void = () => {};

  /** Something the daemon sent an asleep agent, kept for when it wakes. The oldest goes past the cap. */
  hold(agentId: string, envelope: MessageEnvelope): void {
    const kept = [...(this.held.get(agentId) ?? []), envelope].slice(-HELD_MAX);
    this.held.set(agentId, kept);
  }

  /** What a person's chat is told, the first time this hour — or null. */
  notice(agent: { id: string; displayName: string }, envelope: Pick<MessageEnvelope, "gatewayId" | "chatId">): string | null {
    const key = `${agent.id}\u0000${envelope.gatewayId}\u0000${envelope.chatId}`;
    const last = this.told.get(key);
    if (last !== undefined && this.now() - last < TELL_EVERY_MS) return null;
    this.told.set(key, this.now());
    return `${agent.displayName} is asleep and takes no work until someone wakes it: /wake.`;
  }

  /** It woke: what was kept goes back in, in the order it came. How many. */
  release(agentId: string): number {
    const kept = this.held.get(agentId) ?? [];
    this.held.delete(agentId);
    for (const key of [...this.told.keys()]) if (key.startsWith(`${agentId}\u0000`)) this.told.delete(key);
    // A new id, keeping the old as its prefix: the queue remembers ids it has taken, and would drop the same one as a
    // copy — while a marker an id carries (`resume:<turn>`) still reads.
    for (const envelope of kept) this.requeue({ ...envelope, id: `${envelope.id}~woke` });
    return kept.length;
  }
}
