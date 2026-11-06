/**
 * What a save wrote to `session_messages`: rows inserted and deleted since the last call, counted by temporary triggers.
 *
 * Counted rather than read off rowids: SQLite hands out a table's rowids again once it is empty, so a conversation
 * written whole after a compaction can come back with the rowids it had, and a test comparing them passes for the
 * wrong reason. A trigger counts each write as it happens.
 */

import type { SqliteDb } from "@nouride/runtime";

export function countWrites(db: SqliteDb): () => { inserted: number; deleted: number } {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS session_writes (kind TEXT PRIMARY KEY, n INTEGER NOT NULL);
    INSERT OR REPLACE INTO session_writes VALUES ('inserted', 0), ('deleted', 0);
    CREATE TEMP TRIGGER IF NOT EXISTS session_writes_insert AFTER INSERT ON main.session_messages
      BEGIN UPDATE session_writes SET n = n + 1 WHERE kind = 'inserted'; END;
    CREATE TEMP TRIGGER IF NOT EXISTS session_writes_delete AFTER DELETE ON main.session_messages
      BEGIN UPDATE session_writes SET n = n + 1 WHERE kind = 'deleted'; END;
  `);
  return () => {
    const counts = Object.fromEntries(db.prepare<{ kind: string; n: number }>("SELECT kind, n FROM session_writes").all().map((row) => [row.kind, row.n]));
    db.exec("UPDATE session_writes SET n = 0");
    return { inserted: counts.inserted ?? 0, deleted: counts.deleted ?? 0 };
  };
}
