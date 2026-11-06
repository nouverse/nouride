/**
 * When the daemon first saw each agent (0.8.1): the order agents were made in, as near as an install can tell — what
 * Nouride Office shows first when there are more agents than it has room for. A pack carries no date of its own, and
 * a folder's birth time is lost to every restore and copy (on the live box five of six packs share one), so the daemon
 * writes the moment down itself: every agent there at the first start of 0.8.1 at that start, each one made later when
 * it loads. A time once written is kept.
 */

export class AgentsSeen {
  private readonly seen: Record<string, number>;

  constructor(
    private readonly file: { load(): Record<string, number>; save(seen: Record<string, number>): void },
    private readonly now: () => number = Date.now,
  ) {
    this.seen = file.load();
  }

  /** Write down the agents not seen before, at this moment; the others keep the moment they were first seen. */
  note(ids: readonly string[]): void {
    const at = this.now();
    const fresh = ids.filter((id) => this.seen[id] === undefined);
    if (fresh.length === 0) return;
    for (const id of fresh) this.seen[id] = at;
    this.file.save(this.seen);
  }

  /** When this agent was first seen, or null for one never seen. */
  since(id: string): number | null {
    return this.seen[id] ?? null;
  }
}
