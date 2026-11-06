/**
 * A byte count, for a person.
 *
 * One function because there were **seven**, and four of them were wrong in the same way: they
 * stopped at megabytes, so a 2GB file read `2048.0MB`. The CLI's copy handled gigabytes and used a
 * space; everything else did not and did not. Same monorepo, same afternoon, four different answers
 * for one number — and two of the copies were added by the commit that was tidying up the database
 * layer, which is how a four-line function becomes seven copies.
 *
 * The compact spelling is kept because it is the one already pinned by tests and already in prompt
 * text an agent reads back (`234KB`, `5.0MB`); gigabytes are added, which is the actual bug.
 *
 * `apps/dashboard` keeps its own copy on purpose. It has **no workspace dependencies at all** — it
 * declares its own wire types and talks HTTP (ARCHITECTURE.md §3) — so importing this would be the
 * first crack in a boundary worth more than four lines of duplication.
 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0B";
  if (size < 1024) return `${Math.round(size)}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
