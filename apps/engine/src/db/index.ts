/**
 * Database open + migrations.
 *
 * Migrations are numbered `.sql` files applied in order, tracked by SQLite's
 * `user_version`. No ORM, no migration library, no `_migrations` table (TD-005):
 * `user_version` is a single integer that already ships with the file format.
 *
 * Forward-only. There are no `down` migrations, because the recovery path for a
 * bad migration on a single-file database is to restore the file, and pretending
 * otherwise builds a rollback nobody tests.
 *
 * ## The rule forward-only implies, and did not enforce
 *
 * **An applied migration must never be edited.** `user_version` records *how many* have run, never
 * *what they said* — so editing `069_baseline.sql` after it has been applied somewhere leaves
 * every existing install with the old schema and every fresh one with the new, and nothing notices.
 * That was written down and relied on people remembering it.
 *
 * It gets much worse the moment this ships to somewhere you cannot reach. A container a customer
 * rents, or a device sold with the daemon preinstalled, is a database at some version applied by
 * some earlier build. A binary whose migrations disagree with what that file actually had applied
 * will run queries against a schema it is wrong about, and the failure surfaces as data.
 *
 * So the fingerprint below refuses to boot instead. It is stored in `application_id`, the file
 * format's *other* spare integer — which keeps TD-005's reasoning intact rather than working around
 * it, and needs no migration of its own to introduce. A checksum table would have been the obvious
 * alternative and is circular: it is a migration, so it cannot verify itself.
 */

import {
  availableMemoryBytes,
  createHash,
  ensureDir,
  join,
  openDatabase,
  restrictDatabaseFiles,
  type SqliteDb,
} from "@nouride/runtime";
import { createLogger, formatBytes } from "@nouride/shared";
import { backupBeforeMigration } from "@/db/backup.ts";
import { FLOOR_SCHEMA, MIGRATIONS, type Migration } from "@/db/migrations.ts";
import { crossTheFloor, UPGRADE_FLOOR } from "@/commons/upgrade-floor.ts";

const log = createLogger("db");

/**
 * Let a boot continue past a fingerprint mismatch.
 *
 * Deliberately available and deliberately awkward. Refusing to start is the right default — a
 * schema this build is wrong about is worse than an outage — but a refusal with no way past it
 * turns one bad guess in this file into every install down at once, and an operator at 3am needs a
 * way to get a box back up while they work out which build is the right one.
 */
const OVERRIDE = "NOURIDE_ALLOW_SCHEMA_DRIFT";

export class SchemaDriftError extends Error {
  override name = "SchemaDriftError";
}

/**
 * A number that changes if any applied migration's text changes.
 *
 * Folded over `version`, filename and SQL of every migration up to `version`, so it answers "were
 * *these* migrations the ones applied" and not merely "how many". Truncated to the 32 bits
 * `application_id` holds, which is far short of collision-proof and is not trying to be: the thing
 * being caught is an edited file, not an adversary choosing one.
 *
 * A baseline folded from a chain this build no longer has states the chain's fingerprint (`migrations.ts`): that is
 * what a database at its version holds, and the migrations after it are folded onto it. Its own text is held by
 * `schema-fingerprint.test.ts` instead.
 *
 * Never 0. That is the unset value: a database at a version above 0 that holds it is refused like any other mismatch.
 */
export function schemaFingerprint(migrations: readonly Migration[], upTo: number): number {
  const applied = migrations.filter((migration) => migration.version <= upTo);
  const start = applied.findLastIndex((migration) => migration.fingerprint !== undefined);
  const base = applied[start];
  const after = applied.slice(start + 1);
  if (base?.fingerprint !== undefined && after.length === 0) return base.fingerprint;
  const hash = createHash("sha256");
  if (base?.fingerprint !== undefined) hash.update(`${base.fingerprint}\u0000`);
  for (const migration of after) {
    // The version and name are in the hash too: renaming a migration file, or renumbering one, is
    // the same class of mistake as editing its body and produces the same silent divergence.
    hash.update(`${migration.version}\u0000${migration.name}\u0000${migration.sql}\u0000`);
  }
  const digest = hash.digest();
  const value = digest.readInt32BE(0);
  return value === 0 ? 1 : value;
}

/**
 * Open the database and bring it to this build's schema — the whole upgrade, with nobody at a terminal.
 *
 * `nouride update --start` swaps the binary and restarts, and this is what the new one does first:
 * checks its own SQLite can hold the schema, snapshots an existing database before changing it, applies
 * what is pending, and compacts the file when a migration left most of it empty. Nothing to configure
 * and nothing to run afterwards.
 *
 * `manifest` is this build's. A test passes one with a migration after the baseline — which this build does not have
 * yet — to see what an upgrade does to a database that has rows.
 */
export async function openAndMigrate(dbPath: string, manifest: readonly Migration[] = MIGRATIONS): Promise<SqliteDb> {
  const dataDir = join(dbPath, "..");
  ensureDir(dataDir);
  const db = openDatabase(dbPath);
  try {
    assertSqliteCapabilities(db);
  } catch (err) {
    db.close();
    throw err;
  }
  const applied = await migrate(db, {
    beforeApplying: (version) => {
      const snapshot = backupBeforeMigration({ db, dataDir, version });
      // Not a reason to stay on the old schema: the migration is its own transaction either way, and
      // the daily snapshots are still there. Said loudly because it is the undo for this upgrade.
      if (snapshot.error) log.warn("no snapshot before migrating (`nouride db list` has the daily ones)", { error: snapshot.error });
    },
  }, manifest);
  if (applied > 0) compactIfMostlyFree(db);
  // Re-applied: the first write after migration is what creates `-wal` and `-shm` in some cases,
  // and they would otherwise keep the umask's mode.
  restrictDatabaseFiles(dbPath);
  return db;
}

/** What `migrate` calls around the migrations it applies. */
export interface MigrateHooks {
  /** Once, before the first pending migration is applied to a database that already has a schema. */
  beforeApplying?(version: number): void;
}

/** Bring `db` to this build's schema. Returns how many migrations it applied. */
export async function migrate(db: SqliteDb, hooks: MigrateHooks = {}, manifest: readonly Migration[] = MIGRATIONS): Promise<number> {
  assertSchemaMatches(db, manifest);
  const applied = db.userVersion();
  // From the compiled-in manifest, never from a directory listing — see `migrations.ts` for the
  // binary that reported "up to date" on an empty database.
  const pending = manifest.filter((m) => m.version > applied).toSorted(
    (a, b) => a.version - b.version,
  );

  if (pending.length === 0) {
    log.debug("schema up to date", { version: applied });
    return 0;
  }

  // A fresh database has nothing to lose, so only an existing one is snapshotted.
  if (applied > 0) hooks.beforeApplying?.(pending[0]!.version);

  for (const migration of pending) {
    log.info("applying migration", { migration: migration.name });
    // One transaction per migration: a failure leaves the database at the previous
    // version cleanly, rather than half-applied with a version number that lies.
    db.transaction(() => {
      db.exec(migration.sql);
      db.setUserVersion(migration.version);
    });
  }

  log.info("schema migrated", { version: db.userVersion(), applied: pending.length });
  recordFingerprint(db, manifest);
  return pending.length;
}

/**
 * What this build's schema needs from the SQLite it runs on, by name — empty when it has all of it.
 *
 * 3.43 for FTS5's `contentless_delete`, which is what lets the memory index replace one item's text
 * (`memory_fts` in `069_baseline.sql`). Every release binary bundles a SQLite that has both; a source checkout on
 * an old system SQLite is the case this names, before SQLite's own "no such module: fts5" could.
 */
export function missingCapabilities(info: { version: string; compileOptions: readonly string[] }): string[] {
  const missing: string[] = [];
  const [major = 0, minor = 0] = info.version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 43)) missing.push(`SQLite ${info.version}: needs 3.43 or later (FTS5 contentless_delete)`);
  if (!info.compileOptions.includes("ENABLE_FTS5")) missing.push("FTS5: not compiled in");
  return missing;
}

/** The SQLite this binary carries and what it lacks for the schema — for `nouride doctor`, daemon running or not. */
export function sqliteCapabilities(): { version: string; fts5: boolean; missing: string[] } {
  const db = openDatabase(":memory:");
  try {
    const info = db.sqliteInfo();
    return { version: info.version, fts5: info.compileOptions.includes("ENABLE_FTS5"), missing: missingCapabilities(info) };
  } finally {
    db.close();
  }
}

/** Refuse, before any migration runs, a SQLite that cannot hold this build's schema (TD-015, guardrail 1). */
function assertSqliteCapabilities(db: SqliteDb): void {
  const missing = missingCapabilities(db.sqliteInfo());
  if (missing.length === 0) return;
  throw new Error(
    `refusing to start: the SQLite inside this build cannot hold the memory index.\n` +
      missing.map((line) => `  ${line}\n`).join("") +
      `This is the build, not the data. Use a release binary: they bundle a SQLite that has both.`,
  );
}

/** The share of free pages above which a migration's leftovers are worth a VACUUM. */
const COMPACT_ABOVE = 0.25;

/**
 * Give a migration's emptied pages back to the disk, once — one that rebuilds a large table can free most of a file.
 *
 * With `temp_store = MEMORY` the rebuilt database is held in memory while it is written, so a file that
 * would not fit comfortably is left alone: its free pages are reused by the next writes, and the file
 * simply does not shrink. Never fatal: VACUUM is atomic, and a failed one leaves the file as it was.
 */
export function compactIfMostlyFree(db: SqliteDb, available: number = availableMemoryBytes()): boolean {
  const { pages, free, pageSize } = db.pageStats();
  if (pages === 0 || free / pages <= COMPACT_ABOVE) return false;
  const before = pages * pageSize;
  const kept = (pages - free) * pageSize;
  const room = available > 0 ? available / 4 : 256 * 1024 * 1024;
  if (kept > room) {
    log.warn("not compacting the database: rebuilding it would take more memory than is free", {
      kept: formatBytes(kept),
      available: formatBytes(available),
    });
    return false;
  }
  const started = Date.now();
  try {
    db.vacuum();
  } catch (err) {
    log.warn("could not compact the database: it keeps its free pages, which later writes reuse", { error: String(err) });
    return false;
  }
  const after = db.pageStats();
  log.info("database compacted", {
    before: formatBytes(before),
    after: formatBytes(after.pages * after.pageSize),
    ms: Date.now() - started,
  });
  return true;
}

/**
 * Refuse to go on if the migrations already applied to this file are not the ones in this build.
 *
 * Before anything is applied, so a build carrying an edited migration cannot write a *further*
 * migration on top of a schema it is already wrong about.
 *
 * Two states, after a database from before the floor, which is refused first whatever its fingerprint says
 * (`refuseBeforeFloor`):
 *
 * - **A fresh database** — `user_version` is 0, so there is nothing to have diverged. The
 *   fingerprint is written after the migrations run.
 * - **A fingerprint that disagrees** — refused, unless `NOURIDE_ALLOW_SCHEMA_DRIFT` is set. An unset one (0) is
 *   one: 0.8.0 stamped every database it ran on, and the floor is that it ran.
 */
export function assertSchemaMatches(db: SqliteDb, manifest: readonly Migration[] = MIGRATIONS): void {
  const applied = db.userVersion();
  if (applied === 0) return;
  refuseBeforeFloor(applied);

  const stored = db.applicationId();
  const expected = schemaFingerprint(manifest, applied);
  if (stored === expected) return;

  const newer = newerThanThisBuild(applied, manifest);
  const message = newer
    ? `${newer}\n  → to start anyway, against tables this build may not find: ${OVERRIDE}=1`
    : `refusing to start: the migrations applied to this database are not the ones in this build.\n` +
      `  schema version:  ${applied}\n` +
      `  this build:      ${expected}\n` +
      `  the database:    ${stored}\n` +
      `An already-applied migration has been edited, renamed or renumbered, or this is the wrong ` +
      `build for this data directory. Running anyway would query a schema this binary is wrong about.\n` +
      `  → use the build that matches, or restore a snapshot: nouride db list\n` +
      `  → if this build is right about the schema (after a squash, say), accept it: nouride db adopt\n` +
      `  → to start anyway without accepting it: ${OVERRIDE}=1`;

  if (process.env[OVERRIDE]) {
    log.warn("schema fingerprint does not match, continuing because it was overridden", {
      version: applied,
      expected,
      stored,
    });
    // Not adopted. The override is for getting a box up, not for making the mismatch go away — the
    // next boot without it has to refuse again.
    return;
  }

  throw new SchemaDriftError(message);
}

/**
 * A database from before the floor: schema below 69, the one 0.8.0 left.
 *
 * 0.8.0 migrated one on its first start; this version does not — its only migration up to 69 is the baseline, which
 * makes a new database. So one an older build left is refused, with the way across, before anything is applied
 * or snapshotted. Neither `adopt` nor the override can help: the steps in between are the floor's to take.
 */
function refuseBeforeFloor(applied: number): void {
  if (applied >= FLOOR_SCHEMA) return;
  throw new SchemaDriftError(
    `refusing to start: this database is at schema ${applied}, from before ${UPGRADE_FLOOR}, and this version upgrades only from ${UPGRADE_FLOOR}. Install ${UPGRADE_FLOOR} first.\n` +
      `${crossTheFloor("it migrates the database")}\n` +
      `  → or restore a snapshot taken by ${UPGRADE_FLOOR} or later: nouride db list`,
  );
}

/**
 * Record this build's fingerprint against a database, on the operator's word that it is right.
 *
 * The escape hatch a fingerprint needs and the reason it is a *command* rather than an automatic
 * step: the check cannot tell "an applied migration was edited" from "the schema was deliberately
 * rewritten and this build is correct about it". Only a person knows which, and they say so by
 * running this with the daemon stopped.
 *
 * It exists because the first squash needed it: folding thirty-two migrations into one file changed the fingerprint
 * of a schema that did not change at all, and every install refused to boot until somebody confirmed the new baseline
 * described what they had. The alternative — adopting silently whenever the version matches — is the check switching
 * itself off in exactly the case it was written for.
 */
export function adoptSchema(db: SqliteDb): { version: number; fingerprint: number } {
  const version = db.userVersion();
  // A database from before the floor is not this build's to vouch for: the steps that bring it here are 0.7's.
  refuseBeforeFloor(version);
  const newer = newerThanThisBuild(version, MIGRATIONS);
  if (newer) throw new SchemaDriftError(newer);
  const fingerprint = schemaFingerprint(MIGRATIONS, version);
  db.setApplicationId(fingerprint);
  log.info("schema fingerprint adopted", { version, fingerprint });
  return { version, fingerprint };
}

/**
 * A database a newer build has already migrated past everything this one has: what an update that
 * was rolled back leaves behind.
 *
 * The update guard (`service/update-guard.ts`) puts the previous binary back when a new one does not
 * come up, and the new one may have migrated the file before it failed. Those migrations are not this
 * build's to vouch for, so `adopt` refuses — recording this build's fingerprint over them would claim a
 * schema it has never seen — and the way back is named instead: the snapshot from before the upgrade.
 */
function newerThanThisBuild(applied: number, manifest: readonly Migration[]): string | null {
  const latest = Math.max(...manifest.map((migration) => migration.version));
  if (applied <= latest) return null;
  return (
    `refusing to start: this database is at schema ${applied}, and this build only knows up to ${latest}.\n` +
    `A newer Nouride has already upgraded it: an update that was rolled back leaves exactly this.\n` +
    `  → start the newer build again, or\n` +
    `  → restore the snapshot taken before the upgrade: nouride db list, then nouride db restore <file>`
  );
}

/** Stamp the fingerprint for what is now applied. Best-effort: a read-only file must still boot. */
function recordFingerprint(db: SqliteDb, manifest: readonly Migration[]): void {
  try {
    db.setApplicationId(schemaFingerprint(manifest, db.userVersion()));
  } catch (err) {
    log.warn("could not record the schema fingerprint", { error: String(err) });
  }
}
