/**
 * A deleted agent's rows (`ON_AGENT_DELETE` in `keys.ts`): the ones that go, gone, and the lists it is in, without it.
 *
 * The data layer's half of deleting an agent. What needs a service to end it (a mission stopped, an approval expired,
 * a job killed, a sign-in's tokens taken from the secret store) is done by that service first
 * (`web/control/agent-delete.ts`); this takes the rows, in one transaction, and says how many of each. Read from the
 * registry, so a column classified there tomorrow is deleted here with no line added.
 */

import type { SqliteDb } from "@nouride/runtime";
import { KEY_COLUMNS, ON_AGENT_DELETE, type AgentDeleteRule } from "./keys.ts";

/** A name the registry gave, as SQL takes one: letters, digits and underscores, or a thrown error. Never input. */
function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a table's or a column's name`);
  return name;
}

/** Every column that holds an agent's id, with what a delete does to it. One left unclassified is a thrown error. */
function agentColumns(): { table: string; column: string; rule: AgentDeleteRule }[] {
  return KEY_COLUMNS.filter((key) => key.kind === "agent").map((key) => {
    const rule = ON_AGENT_DELETE[`${key.table}.${key.column}`];
    if (!rule) throw new Error(`${key.table}.${key.column} holds an agent's id and ON_AGENT_DELETE does not say what deleting an agent does to it`);
    return { table: identifier(key.table), column: identifier(key.column), rule };
  });
}

/** How many rows of `table` name the agent in `column`. */
function named(db: SqliteDb, table: string, column: string, agentId: string): number {
  return db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(agentId)?.n ?? 0;
}

/**
 * The rows whose list in `column` holds the agent, each with the list as it would be without it. A comma-separated
 * list is read whole and looked at here: such a table holds a handful of rows (the tokens other tools reach Nouride
 * with), and a pattern match would take an id that is part of another's.
 */
function listed(db: SqliteDb, table: string, column: string, agentId: string): { rowid: number; without: string }[] {
  return db
    .prepare<{ rowid: number; held: string }>(`SELECT rowid, ${column} AS held FROM ${table}`)
    .all()
    .filter((row) => row.held.split(",").includes(agentId))
    .map((row) => ({ rowid: row.rowid, without: row.held.split(",").filter((one) => one && one !== agentId).join(",") }));
}

/** How many rows of each table still name the agent, by the tables whose rows a delete takes: what a summary counts. */
export function agentRowCounts(db: SqliteDb, agentId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { table, column, rule } of agentColumns()) {
    if (rule === "deleted") counts[table] = (counts[table] ?? 0) + named(db, table, column, agentId);
  }
  return counts;
}

/** The rows that go, deleted, and the agent taken out of each list it is in. How many rows changed, by table. */
export function forgetAgentRows(db: SqliteDb, agentId: string): Record<string, number> {
  const changed: Record<string, number> = {};
  db.transaction(() => {
    for (const { table, column, rule } of agentColumns()) {
      if (rule === "deleted") {
        changed[table] = (changed[table] ?? 0) + db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(agentId).changes;
      } else if (rule === "unlisted") {
        // A list left empty stays a row that reaches no agent, which its own page shows and revokes.
        const rows = listed(db, table, column, agentId);
        for (const row of rows) db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(row.without, row.rowid);
        changed[table] = (changed[table] ?? 0) + rows.length;
      }
    }
  });
  return changed;
}

/** The connectors the agent holds a stored sign-in to: each one's tokens are taken from the secret store by name. */
export function agentSignIns(db: SqliteDb, agentId: string): string[] {
  return db.prepare<{ server: string }>("SELECT server FROM mcp_oauth WHERE agent_id = ?").all(agentId).map((row) => row.server);
}
