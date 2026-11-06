/**
 * A group's subject — its name on WhatsApp — for the `message` event's `chatTitle` (0.7.24).
 *
 * Kept here, and asked of WhatsApp in the background: a message is never held for a group's metadata. The first message
 * from a group not yet asked goes up without a name and starts the ask; the ones after carry it. A subject a day old is
 * asked again, and a rename WhatsApp announces (`groups.update`) is taken at once.
 */

/** How old a subject may be before it is asked again. */
const REFRESH_MS = 24 * 60 * 60_000;
/** After an ask that failed, how long until the next. */
const RETRY_MS = 10 * 60_000;
/** Groups remembered; cleared wholesale past it, which costs one ask per group. */
const CAP = 2_000;

export class GroupSubjects {
  private readonly known = new Map<string, { subject: string; at: number }>();
  private readonly tried = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The subject known for `jid`, if any — asking `fetch` for it, not awaited, when there is none or it is old. */
  of(jid: string, fetch: (jid: string) => Promise<{ subject?: string | null }>): string | undefined {
    const now = this.now();
    const known = this.known.get(jid);
    const last = this.tried.get(jid);
    if ((!known || now - known.at >= REFRESH_MS) && (last === undefined || now - last >= RETRY_MS)) {
      if (this.tried.size >= CAP) this.tried.clear();
      this.tried.set(jid, now);
      void fetch(jid)
        .then((metadata) => {
          if (metadata.subject?.trim()) this.note(jid, metadata.subject);
        })
        .catch(() => {});
    }
    return known?.subject;
  }

  /** A subject WhatsApp said — an ask's answer, or a rename it announced. */
  note(jid: string, subject: string): void {
    const trimmed = subject.trim();
    if (!trimmed) return;
    if (this.known.size >= CAP) this.known.clear();
    this.known.set(jid, { subject: trimmed, at: this.now() });
  }
}
