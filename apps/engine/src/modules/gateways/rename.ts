/**
 * Renaming a gateway instance, which is not renaming a gateway instance.
 *
 * `telegram:bot` looks like a label. It is a **key**, stored in every column `db/keys.ts` lists as naming a gateway —
 * on its own, at the front of memory's chat keys and the inbox's ids, inside a JSON document, and — the part that
 * makes a hand-edit dangerous — inside every session id, `ses_<agent>:<gateway>:<chat>`, so the gateway's name is in
 * the primary key of every conversation it ever carried, and in every turn record and usage row that names one. Outside
 * the database it is in `config.toml`, in each agent pack's `[channels]` and `sender_allowlist`
 * (`rename-packs.ts`), and in the memory vault (`modules/memory/rename.ts`).
 *
 * Change it in `config.toml` alone and nothing errors. What happens instead is quieter and worse:
 *
 *   - every conversation on that gateway is orphaned — a new one starts, the old transcript belongs
 *     to a gateway that no longer exists, and the agent has no memory of anything said there
 *   - `[security.access] allowlist` entries still name the old id, so the sender is no longer
 *     recognised and gets a pairing code instead of an answer
 *   - a cron job's `target_gateway_id` still names the old id, so its delivery fails on the next run
 *
 * So this is a migration. It runs with the daemon stopped, in one transaction, and it reports what it
 * would touch before it touches anything.
 *
 * ## What is deliberately *not* rewritten
 *
 * The columns `db/keys.ts` marks as records — `audit_log.gateway` and the log's own lines. Each says what happened, and
 * what happened was on a gateway that was called `telegram:bot` at the time. Rewriting an append-only history to agree
 * with the present is how a history stops being evidence. Reported, so the operator knows a filter on the new name will
 * not reach back past the rename.
 *
 * ## What it refuses
 *
 * A rename onto an id rows already name — a gateway removed from the config leaves its sender access, its
 * conversations and its memory behind, and moving another gateway's rows onto them is a merge, which has to decide
 * what happens to two rows with one key. And work still in flight on the old id — a message waiting for its turn, a
 * turn that never ended — which the next boot acts on from a document this would have to rewrite: start and stop the
 * daemon once, and they settle.
 */

import { escapeRegex, likeLiteral } from "@/commons/text.ts";
import type { SqliteDb } from "@nouride/runtime";
import { IN_FLIGHT, KEY_COLUMNS } from "@/db/keys.ts";

/**
 * A gateway id: `<platform>:<instance>`, and the instance is the half being renamed. The platforms a person configures:
 * `web` is the daemon's own and cannot be renamed, and `local` has been gone since 0.6.
 */
const GATEWAY_ID = /^(discord|telegram|whatsapp):([A-Za-z0-9_-]+)$/;

/** Where a gateway id sits in a value — the three shapes `db/keys.ts` names that a rename can find and rewrite. */
type Shape = "gateway" | "session" | "gatewayPrefixed";

/** One place the id is kept: a column, or a path inside a JSON column. */
interface Spot {
  table: string;
  column: string;
  shape: Shape;
  /** The JSON path, when the column is a document. */
  path?: string;
}

function spotsOf(record: boolean): Spot[] {
  return KEY_COLUMNS.filter((key) => (key.record === true) === record).flatMap((key): Spot[] => {
    if (key.kind === "json") {
      return Object.entries(key.paths ?? {}).map(([path, shape]) => ({ table: key.table, column: key.column, shape, path }));
    }
    if (key.kind === "gateway" || key.kind === "session" || key.kind === "gatewayPrefixed") {
      return [{ table: key.table, column: key.column, shape: key.kind }];
    }
    return [];
  });
}

/** Every place a rename rewrites, from the registry — so a column added there is a column renamed here. */
const REWRITTEN = spotsOf(false);
/** Records that name a gateway: counted for the report, never rewritten. */
const RECORDS = spotsOf(true);

/**
 * Every identifier the rename interpolates, flattened — exported so a test can assert they all
 * satisfy the guard.
 *
 * The failure this prevents is badly timed rather than subtle: a column added with a capital letter
 * would pass review and throw when somebody ran the rename, which is with the daemon stopped and
 * halfway through a migration.
 */
export const RENAMED_IDENTIFIERS: string[] = [
  ...[...REWRITTEN, ...RECORDS].flatMap(({ table, column }) => [table, column]),
  ...Object.keys(IN_FLIGHT),
];

/** Rows of one column that name the id. */
export interface ColumnCount {
  table: string;
  column: string;
  count: number;
}

export interface RenamePlan {
  from: string;
  to: string;
  /** Rows per column that will be rewritten, only where there is at least one — a JSON column as `column $.path`. */
  rows: ColumnCount[];
  /** Records that name it and stay as they are. */
  kept: ColumnCount[];
  /** Lines of `config.toml` that mention it, with their line numbers, for the report. */
  configLines: { line: number; text: string }[];
  /** What the new `config.toml` would be. */
  configAfter: string;
  total: number;
}

export class RenameRefusal extends Error {
  override name = "RenameRefusal";
}

/**
 * A table or column name, checked before it reaches a query string.
 *
 * This file is the only place in the tree that builds SQL by interpolation, and it has to: it walks every column
 * `db/keys.ts` lists in one transaction, and a bound parameter cannot name an identifier. Today every value comes from
 * that registry, so nothing attacker-supplied can reach it — which is exactly the reassurance that stops being true the
 * first time somebody adds a caller.
 *
 * So the guard is on the *interpolation* rather than on the registry. Assert here and the registry becomes one way of
 * satisfying it instead of the reason it is safe. An identifier that is not a plain lowercase name is a bug in this
 * file or an injection attempt from outside it, and both should stop before a statement is prepared.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Exported for the test that pins it — see the note above on why the guard and not the registry. */
export function identifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    // Not a `RenameRefusal`: that class is for a plan a person got wrong and can correct. This is
    // unreachable from any input a person supplies, so reaching it means the code is wrong.
    throw new Error(`refusing to build SQL with "${name}" as an identifier`);
  }
  return name;
}

/** A clause and its parameters. */
interface Clause {
  sql: string;
  params: unknown[];
}

/**
 * The value a spot holds: the column, or what is at its JSON path — read only where the column holds JSON, so a
 * malformed document is a row that does not match rather than an error that stops the whole rename.
 */
function valueAt(spot: Spot): Clause {
  const column = identifier(spot.column);
  return spot.path === undefined
    ? { sql: column, params: [] }
    : { sql: `(CASE WHEN json_valid(${column}) THEN json_extract(${column}, ?) END)`, params: [spot.path] };
}

/**
 * Rows where this spot names `id`.
 *
 * The id goes into LIKE through `likeLiteral`: a gateway id may hold `_` (`telegram:my_bot`), which LIKE reads as
 * any one character — so renaming `my_bot` would also have rewritten the rows of a `myxbot`.
 */

function naming(spot: Spot, id: string): Clause {
  const value = valueAt(spot);
  switch (spot.shape) {
    case "gateway":
      return { sql: `${value.sql} = ?`, params: [...value.params, id] };
    case "session":
      // `%` around it: a session id is `ses_<agent>:<gateway>:<chat>`, so the gateway is in the middle.
      return { sql: `${value.sql} LIKE ? ESCAPE '\\'`, params: [...value.params, `%${likeLiteral(`:${id}:`)}%`] };
    case "gatewayPrefixed":
      return { sql: `${value.sql} LIKE ? ESCAPE '\\'`, params: [...value.params, `${likeLiteral(`${id}:`)}%`] };
  }
}

/** What a spot holds once `from` is `to`, as an expression over the row. */
function renamed(spot: Spot, from: string, to: string): Clause {
  const value = valueAt(spot);
  switch (spot.shape) {
    case "gateway":
      return { sql: "?", params: [to] };
    case "session":
      /**
       * `replace()` on the middle segment, not a rebuild from parts.
       *
       * A chat id can itself contain a colon (`120363000000000001@g.us` cannot, but a Telegram topic
       * id like `12345:67` can), so splitting the session id and reassembling it would corrupt
       * exactly the rows that are hardest to notice. Replacing `:<from>:` is unambiguous — the
       * gateway id itself is colon-free by the pattern above.
       */
      return { sql: `replace(${value.sql}, ?, ?)`, params: [...value.params, `:${from}:`, `:${to}:`] };
    case "gatewayPrefixed":
      // The front replaced, the rest kept as it is: `substr` counts from 1, and the rest starts after `<from>:`.
      return { sql: `? || substr(${value.sql}, ?)`, params: [`${to}:`, ...value.params, from.length + 2] };
  }
}

/** The assignment that rewrites a spot: the column, or the path inside it, with the rest of the document kept. */
function assignment(spot: Spot, from: string, to: string): Clause {
  const column = identifier(spot.column);
  const next = renamed(spot, from, to);
  return spot.path === undefined
    ? { sql: `${column} = ${next.sql}`, params: next.params }
    : { sql: `${column} = json_set(${column}, ?, ${next.sql})`, params: [spot.path, ...next.params] };
}

/** How a spot is named in the report: the column, and the path when it is a document. */
function label(spot: Spot): string {
  return spot.path === undefined ? spot.column : `${spot.column} ${spot.path}`;
}

/**
 * What renaming would touch, without touching it.
 *
 * Everything is counted before anything is written, and the same plan is what `applyRename` uses —
 * so the report is not a second implementation that could disagree with the thing it describes.
 */
export function planRename(input: {
  db: SqliteDb;
  config: string;
  from: string;
  to: string;
  /** Gateway ids the config already defines, so a rename onto an existing one is refused. */
  existing: string[];
}): RenamePlan {
  const { db, config, from, to } = input;

  if (from === to) throw new RenameRefusal("the old and new ids are the same");
  const fromParts = GATEWAY_ID.exec(from);
  const toParts = GATEWAY_ID.exec(to);
  if (!fromParts) throw new RenameRefusal(`"${from}" is not a gateway id (expected <platform>:<instance>)`);
  if (!toParts) throw new RenameRefusal(`"${to}" is not a gateway id (expected <platform>:<instance>)`);
  /**
   * The platform cannot change.
   *
   * `telegram:bot` → `whatsapp:nouva` would keep every session, every allowlist entry and every
   * person id while silently reassigning them to a different network. The ids inside them belong to
   * one platform's namespace; a Telegram user id is not a WhatsApp jid.
   */
  if (fromParts[1] !== toParts[1]) {
    throw new RenameRefusal(
      `a rename cannot change the platform (${fromParts[1]} → ${toParts[1]}): the sender ids underneath it belong to one network`,
    );
  }
  if (input.existing.includes(to)) {
    throw new RenameRefusal(`"${to}" is already configured, and merging two gateways is not a rename`);
  }

  /**
   * Rows already under the new name are a merge too, though the config no longer says so: removing a gateway deletes
   * none of its rows, so its sender access, its conversations and its memory are still there. Moving another
   * gateway's rows onto them is two conversations with one key — and where that key is unique, a crash halfway
   * through the transaction, after a dry run that said it was fine.
   */
  const already = counted(db, REWRITTEN, to);
  if (already.length > 0) {
    throw new RenameRefusal(
      `rows already name "${to}": ${describe(already)}. They are a gateway's that was removed from the config, and ` +
        `moving another gateway's rows onto them is a merge, not a rename. Pick a name nothing has used`,
    );
  }

  const waiting = inFlight(db, from);
  if (waiting.length > 0) {
    throw new RenameRefusal(
      `work on "${from}" was still in flight when the daemon stopped: ${describe(waiting)}. The next boot acts on it, ` +
        `so it is not rewritten: start the daemon, let it settle what was waiting, stop it, and run this again`,
    );
  }

  const rows = counted(db, REWRITTEN, from);
  const configLines: RenamePlan["configLines"] = [];
  config.split("\n").forEach((text, index) => {
    if (mentionsGateway(text, from)) configLines.push({ line: index + 1, text: text.trim() });
  });

  return {
    from,
    to,
    rows,
    kept: counted(db, RECORDS, from),
    configLines,
    configAfter: rewriteConfig(config, from, to),
    total: rows.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/** Each spot's rows naming `id`, where there are any. */
function counted(db: SqliteDb, spots: readonly Spot[], id: string): ColumnCount[] {
  const out: ColumnCount[] = [];
  for (const spot of spots) {
    const where = naming(spot, id);
    const count = countWhere(db, spot.table, where.sql, where.params);
    if (count > 0) out.push({ table: spot.table, column: label(spot), count });
  }
  return out;
}

/** Rows of work in flight that name `id`, per table — a row counted once, whichever of its columns names it. */
function inFlight(db: SqliteDb, id: string): ColumnCount[] {
  const out: ColumnCount[] = [];
  for (const [table, condition] of Object.entries(IN_FLIGHT)) {
    const spots = REWRITTEN.filter((candidate) => candidate.table === table).map((spot) => naming(spot, id));
    if (spots.length === 0) continue;
    const any = `(${spots.map((spot) => spot.sql).join(" OR ")})`;
    const count = countWhere(db, table, condition === null ? any : `(${condition}) AND ${any}`, spots.flatMap((spot) => spot.params));
    if (count > 0) out.push({ table, column: "", count });
  }
  return out;
}

function describe(counts: readonly ColumnCount[]): string {
  return counts.map((entry) => `${entry.count} in ${entry.table}${entry.column ? `.${entry.column}` : ""}`).join(", ");
}

/**
 * Do it, in one transaction.
 *
 * All of it or none of it: a rename that updated the sessions table and then failed on the allowlist
 * would leave a daemon whose history is under the new name and whose access rules are under the old
 * one — which is worse than either name, because the bot would stop answering the person who owns it.
 */
export function applyRename(db: SqliteDb, plan: RenamePlan): void {
  db.transaction(() => {
    for (const spot of REWRITTEN) {
      const table = identifier(spot.table);
      const set = assignment(spot, plan.from, plan.to);
      const where = naming(spot, plan.from);
      db.prepare(`UPDATE ${table} SET ${set.sql} WHERE ${where.sql}`).run(...set.params, ...where.params);
    }
  });
}

/**
 * The new `config.toml`, or an agent pack's.
 *
 * Three shapes, because TOML spells one id three ways:
 *
 *   `[gateways.telegram.bot]`   the table header that defines it
 *   `"telegram:bot:5550001111"` inside an allowlist
 *   `telegram:bot`              on its own, in a binding or a comment
 *
 * Line-oriented and textual, like every other edit to this file — it is config-as-code somebody
 * hand-writes, and a rewrite through a TOML serialiser would return it without its comments.
 */
export function rewriteConfig(config: string, from: string, to: string): string {
  const [platform, oldInstance] = from.split(":") as [string, string];
  const [, newInstance] = to.split(":") as [string, string];

  return config
    .split("\n")
    .map((line) => {
      // The header first: `[gateways.telegram.bot]`, and the sub-tables under it — `[gateways.telegram.bot.resilience]`,
      // whose tuning a rename used to leave behind under the old id, a ghost of the gateway with none of it working.
      // Bounded by `.` or `]`, so `[gateways.telegram.bot2]` is another gateway's.
      const header = new RegExp(
        `^(\\s*\\[gateways\\.${escapeRegex(platform)}\\.)${escapeRegex(oldInstance)}((?:\\.[^\\]]*)?\\]\\s*(?:#.*)?)$`,
      );
      if (header.test(line)) return line.replace(header, `$1${newInstance}$2`);
      // Then the id wherever it appears as a value or inside a longer sender id. Bounded on the left
      // so `telegram:bot` cannot match the tail of something else, and on the right so it cannot
      // match a longer instance name — `telegram:bot2` must survive a rename of `telegram:bot`.
      return line.replace(
        new RegExp(`(^|[^A-Za-z0-9_:-])${escapeRegex(from)}(?![A-Za-z0-9_-])`, "g"),
        `$1${to}`,
      );
    })
    .join("\n");
}

/** Whether one line of a config file names the gateway — the lines a report shows. */
export function mentionsGateway(line: string, from: string): boolean {
  const [platform, instance] = from.split(":") as [string, string];
  if (new RegExp(`^\\s*\\[gateways\\.${escapeRegex(platform)}\\.${escapeRegex(instance)}[.\\]]`).test(line)) {
    return true;
  }
  return new RegExp(`(^|[^A-Za-z0-9_:-])${escapeRegex(from)}(?![A-Za-z0-9_-])`).test(line);
}

/**
 * Rows matching a clause. A missing table throws: the CLI refuses a database this build has not migrated, and a count
 * that read a missing table as zero once let a plan report nothing for rows `applyRename` would then trip over.
 */
function countWhere(db: SqliteDb, table: string, where: string, params: unknown[]): number {
  const row = db
    .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${identifier(table)} WHERE ${where}`)
    .get(...params);
  return row?.n ?? 0;
}

