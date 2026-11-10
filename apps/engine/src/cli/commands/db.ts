/**
 * `nouride db backup`, `nouride db list`, `nouride db verify`, `nouride db restore` — the way back
 * from a bad day.
 *
 * The daemon snapshots the database itself, at boot and daily. These commands exist for the two
 * moments the schedule does not cover: **before** doing something risky, and **after** something
 * went wrong. Both are the moments somebody is standing at a terminal.
 *
 * ## Why these do not go through the API
 *
 * `backup`, `list` and `verify` could. `restore` cannot, and splitting the group across two
 * transports would mean the one command that matters behaves differently from the three beside it —
 * a person who has just learned `nouride db list` from a running daemon would find `restore` needs
 * a different mental model at the worst possible time.
 *
 * A restore replaces the file the daemon holds open. Doing that under a running daemon produces a
 * process whose page cache, WAL and in-memory sessions all belong to a database that no longer
 * exists, and it writes them back over the restored one. So it refuses while the daemon is up, the
 * same way `gateway rename` does and by asking the same question of the same pid.
 */

import {
  databaseVersion,
  dirname,
  fileExistsSync,
  join,
  openDatabase,
  statFile,
} from "@nouride/runtime";
import { formatBytes } from "@nouride/shared";
import {
  backupDatabase,
  dbBackupDir,
  listBackups,
  restoreDatabase,
  verify,
} from "@/db/backup.ts";
import { adoptSchema } from "@/db/index.ts";
import { backupDirFor, missingBackupDir } from "@/commons/backup-dir.ts";
import { FLOOR_SCHEMA, MIGRATIONS } from "@/db/migrations.ts";
import { UPGRADE_FLOOR } from "@/commons/upgrade-floor.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, emit, fail, say, usageError } from "@/cli/ui.ts";
import { helpFor, unknownAction } from "@/cli/usage.ts";
import { bareArgs } from "@/cli/args.ts";
import { startHint } from "@/service/hints.ts";
import { runningDaemon } from "@/cli/daemon-lock.ts";
import { loadConfig } from "@/cli/load-config.ts";

export async function db(args: string[]): Promise<void> {
  const [action, ...rest] = bareArgs(args);
  // Bare, what the group does — said as help, as `nouride db --help` is: it is the answer to what was asked, and exit 0.
  // It printed the same lines from a copy of its own, with nothing to say they were help.
  if (action === undefined) return helpFor("db");

  const { config } = await loadConfig();
  const dataDir = config.daemon.dataDir;
  const dbPath = join(dataDir, "nouride.db");
  // Where snapshots are written, and — while a configured drive is missing — the reason none can be.
  const where = backupDirFor(config.daemon);
  const backupDir = "dir" in where ? where.dir : undefined;

  switch (action) {
    case "backup":
      if ("missing" in where) fail("No snapshot was taken.", missingBackupDir(where.missing));
      return takeBackup(dataDir, backupDir, dbPath, config.daemon.backupKeep);
    case "list":
      return showList(dataDir, backupDir);
    case "verify":
      return runVerify(resolveSnapshot(dataDir, backupDir, rest[0]) ?? dbPath);
    case "restore":
      return runRestore(dataDir, backupDir, dbPath, rest[0]);
    case "adopt":
      return runAdopt(dataDir, dbPath);
    default:
      unknownAction("db", action);
  }
}

/**
 * A bare name is looked up among the snapshots; a path is taken as given.
 *
 * So `nouride db restore nouride-2026-09-09-11-00-00.db` works from anywhere, which is what a
 * person copies out of `nouride db list` — in whichever of the two directories it lives.
 */
function resolveSnapshot(dataDir: string, backupDir: string | undefined, name: string | undefined): string | null {
  if (!name) return null;
  if (name.includes("/")) return name;
  return listBackups(dataDir, backupDir).find((snapshot) => snapshot.name === name)?.path ?? join(dbBackupDir(dataDir), name);
}

function takeBackup(dataDir: string, backupDir: string | undefined, dbPath: string, keep: number): void {
  if (!statFile(dbPath)) fail(`No database at ${dbPath}.`, "Has this daemon ever started?");

  /**
   * Opened read-write, because `VACUUM INTO` is a statement rather than a file read — and safe
   * against a running daemon, which is the point of using it: SQLite serialises the two, so this
   * takes a consistent snapshot of a database being written to.
   */
  const live = openDatabase(dbPath);
  try {
    const result = backupDatabase({ db: live, dataDir, ...(backupDir ? { backupDir } : {}), keep });
    if (!result.path) fail("The backup did not complete.", result.error);
    emit({ path: result.path, bytes: result.bytes, removed: result.removed, keep });
    say(`${GREEN}✓${RESET} ${result.path}  ${DIM}${formatBytes(result.bytes)}${RESET}`);
    if (result.removed > 0) {
      say(`${DIM}  ${result.removed} older snapshot(s) removed, keeping ${keep}${RESET}`);
    }
  } finally {
    live.close();
  }
}

function showList(dataDir: string, backupDir: string | undefined): void {
  const snapshots = listBackups(dataDir, backupDir);
  const where = backupDir ? join(backupDir, "db") : dbBackupDir(dataDir);
  emit({ dir: where, snapshots });
  if (snapshots.length === 0) {
    return say(
      `${DIM}No snapshots in ${where}.\n` +
        `The daemon takes one at boot and daily; \`nouride db backup\` takes one now.${RESET}`,
    );
  }

  say(`${BOLD}${snapshots.length} snapshot(s)${RESET}  ${DIM}${where}${RESET}`);
  for (const snapshot of snapshots) {
    // Named only when it is not where the list says: a snapshot taken before a migration stays in
    // data/backups whatever [daemon] backup_dir says.
    const elsewhere = dirname(snapshot.path) === where ? "" : `  ${dirname(snapshot.path)}`;
    say(`  ${snapshot.name}  ${DIM}${formatBytes(snapshot.bytes)}${elsewhere}${RESET}`);
  }
}

/**
 * Say, deliberately, that this build's migrations are the right ones for this database.
 *
 * The daemon refuses to boot when its schema fingerprint disagrees with the one stored in the file,
 * and it cannot tell a genuinely edited migration from a deliberate rewrite — only a person can.
 * This is how they say which, and it is why the refusal names it.
 *
 * Needs the daemon stopped for the same reason a restore does: it writes a header field of the file
 * the daemon holds open, and a daemon that then exits would checkpoint over it.
 */
function runAdopt(dataDir: string, dbPath: string): void {
  if (!statFile(dbPath)) fail(`No database at ${dbPath}.`, "Has this daemon ever started?");
  refuseWhileRunning(dataDir);

  const live = openDatabase(dbPath);
  try {
    const before = live.applicationId();
    const { version, fingerprint } = adoptSchema(live);
    emit({ version, before, fingerprint, changed: before !== fingerprint });
    if (before === fingerprint) {
      return say(`${DIM}Already accepted: nothing to change (schema ${version}).${RESET}`);
    }
    say(`${GREEN}✓${RESET} this build's schema is now recorded as correct for this database`);
    say(`${DIM}  schema version ${version}, fingerprint ${before} → ${fingerprint}${RESET}`);
    say(`${DIM}  ${startHint()}${RESET}`);
  } finally {
    live.close();
  }
}

function runVerify(path: string): void {
  if (!fileExistsSync(path)) fail(`No such file: ${path}`);

  const verdict = verify(path);
  emit({ path, ...verdict });
  if (verdict.ok) return say(`${GREEN}✓${RESET} ${path} ${DIM}checks out${RESET}`);
  say(`${RED}✗${RESET} ${path}`);
  fail("That database does not check out.", verdict.detail);
}

/** Refuse while the daemon is up — asked of the process its lock names (`runningDaemon`). */
export function refuseWhileRunning(dataDir: string): void {
  const holder = runningDaemon(dataDir);
  if (holder === null) return;

  fail(
    `The daemon is running (pid ${holder}): it would overwrite this.`,
    `Stop it first: systemctl stop nouride   (or ${BOLD}nouride stop${RESET})`,
  );
}

function runRestore(dataDir: string, backupDir: string | undefined, dbPath: string, name: string | undefined): void {
  const from = resolveSnapshot(dataDir, backupDir, name);
  if (!from) {
    // Asking wrongly, exit 2 — it printed the list and exited 0 — with the snapshots it could have named.
    const newest = listBackups(dataDir, backupDir).slice(0, 3).map((snapshot) => snapshot.name);
    usageError(
      "usage: nouride db restore <file>",
      newest.length > 0
        ? `Name a snapshot (the newest: ${newest.join(", ")}). \`nouride db list\` shows every one.`
        : "There are no snapshots to put back yet: `nouride db list` says where they would be.",
    );
  }

  refuseWhileRunning(dataDir);

  // A snapshot from before the floor is a database this version does not start on — the steps that bring it here are
  // the floor's — so it is refused here, with nothing changed, rather than put back where the daemon then refuses it.
  const schema = databaseVersion(from);
  if (schema !== null && schema > 0 && schema < FLOOR_SCHEMA) {
    fail(
      `That snapshot is from before ${UPGRADE_FLOOR} (schema ${schema}): this version does not start on it. Nothing was changed.`,
      `Restore it with ${UPGRADE_FLOOR}'s \`nouride db restore\` and start ${UPGRADE_FLOOR} once, which brings it forward. Or use it to go back to the version that took it.`,
    );
  }

  const outcome = restoreDatabase({ from, dbPath });
  if (!outcome.ok) fail("Nothing was changed.", outcome.error);

  say(`${GREEN}✓${RESET} restored ${dbPath}`);
  say(`${DIM}  from ${outcome.from}${RESET}`);
  if (outcome.replaced) {
    // Named, because the most likely mistake here is restoring the wrong snapshot, and it is only
    // recoverable while the file it replaced still exists.
    say(`${YELLOW}  the database it replaced is at ${outcome.replaced}${RESET}`);
    say(`${DIM}  delete it once you are satisfied, or rename it back to undo this.${RESET}`);
  }
  const restored = openDatabase(dbPath);
  const version = restored.userVersion();
  restored.close();
  emit({ restored: dbPath, from: outcome.from, replaced: outcome.replaced ?? null, schema: version, current: version >= MIGRATIONS.at(-1)!.version });
  // Rehearsed on a copy of a live box: the hint said to start the daemon, and this build started on an
  // older version's database upgrades it straight back — a rollback undone by following the advice.
  if (version < MIGRATIONS.at(-1)!.version) {
    say(`${YELLOW}  this database is from an older version (schema ${version}): install that version, then start it.${RESET}`);
    say(`${DIM}  started on this build instead, it is upgraded again, which is also how to undo this restore.${RESET}`);
  } else {
    say(`${DIM}  ${startHint()}${RESET}`);
  }
}
