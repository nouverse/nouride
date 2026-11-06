/**
 * The event streams open on the control API, so a shutdown can end them.
 *
 * A stream never finishes on its own — that is what it is for — and a graceful stop of the server waits for every
 * response to finish. One dashboard tab on a conversation, or `nouride events -f` left running, held every restart
 * and update to the thirty-second deadline, which then forced an exit past the lock, the database's close and the
 * clean-shutdown mark. Ended here instead, a reader reconnects to the next daemon and resumes from its cursor.
 */
export class OpenStreams {
  private readonly open = new Set<() => void>();

  /** A stream's way to end itself, held until it ends; the returned function lets go of it, for a reader that left. */
  add(end: () => void): () => void {
    this.open.add(end);
    return () => this.open.delete(end);
  }

  /** Ends every stream still open. How many. */
  closeAll(): number {
    const all = [...this.open];
    this.open.clear();
    for (const end of all) end();
    return all.length;
  }
}
