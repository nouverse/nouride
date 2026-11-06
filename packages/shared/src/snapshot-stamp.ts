/**
 * The time in a snapshot's name — the database's, the vault's, a pack's — written and read back in one place.
 *
 * Each backup wrote its own copy of the stamp, and the database's was read back by a parser in another file: three
 * writers and two readers of one format, any of which could drift and leave a rotation keeping the wrong snapshots.
 *
 * Sortable, to the second, in UTC: `2026-10-17-09-30-05`. Sorting the names is how a sweep decides what is oldest —
 * no parsing, no clock arithmetic.
 */

/** `now` as a snapshot's name carries it. */
export function snapshotStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/** When the snapshot `name` was taken, from the stamp after `prefix` at its start; null for a name without one. */
export function snapshotTakenAt(name: string, prefix = ""): number | null {
  if (!name.startsWith(prefix)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(name.slice(prefix.length));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}
