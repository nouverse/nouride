/**
 * Going back one version on purpose — `nouride update --rollback` (D7).
 *
 * The unit's guard puts the previous build back by itself when a new one does not start (`confirm.ts`). What it
 * cannot catch is a version that starts and is wrong, and the way back from that was "install the older build by
 * hand, then restore a snapshot", with which snapshot left to whoever was reading the docs at the time.
 *
 * Every install keeps the build it replaces in `.nouride-previous/` — `nouride update` and, since 0.7.4,
 * `install.sh` — so putting that back is the easy half. The other is the database: a version that migrated it
 * leaves a schema the older binary refuses to open. The snapshot the new version took just before migrating is the
 * database as the older one left it — a `before-NNN` snapshot, stamped after the build was put aside — so it goes
 * back with the build, and what was written since is said to be lost before anything is touched.
 *
 * And the secrets (0.8.19): a build from before 0.8.19 reads `secrets.json` alone, which the encrypted store replaced.
 * Put back without it, that build ran with no secret at all, and the first one it saved made a `secrets.json` newer
 * than the encrypted store, which coming forward again would read in its place. So they go back with the build, as it
 * reads them; `secrets.enc` stays, and the newer `secrets.json` is what 0.8.19 encrypts again.
 */

import { join, listDir, readTextFileSync, removePath, renamePath, statFile, writeBytesSync } from "@nouride/runtime";
import { takenAt, type RestoreOutcome } from "@/db/backup.ts";
import { PENDING_FILE, SWAPPED } from "@/service/update-guard.ts";
import { rememberRollback } from "./confirm.ts";

const PREVIOUS = ".nouride-previous";
/** In `.nouride-previous/`: which version is kept there, which one put it aside, and when. */
const RELEASE_FILE = "release.json";

export interface KeptBuild {
  /** What is in `.nouride-previous/`, but for this file's own record. */
  names: string[];
  /** Its version, when the install that kept it said — `install.sh` does not run the binary it replaces, and installs before 0.7.4 said nothing. */
  version: string | null;
  /** The version that put it aside — the one installed in its place. Unknown for what installs before 0.7.4 kept. */
  by: string | null;
  /** When it was put aside: a migration's snapshot from after this is this update's. */
  putAsideAt: number;
}

export interface RollbackPlan extends KeptBuild {
  /** The database as the kept build left it, when the update since migrated it; null when it did not. */
  snapshot: { name: string; path: string; at: number } | null;
}

/** Called by an install, beside what it kept: the version it replaced, the one replacing it, and when. */
export function recordKeptBuild(backupDir: string, record: { version: string | null; by: string | null }, at = Date.now()): void {
  const text = JSON.stringify({ version: record.version, by: record.by, at: new Date(at).toISOString() });
  writeBytesSync(join(backupDir, RELEASE_FILE), new TextEncoder().encode(`${text}\n`));
}

/** What `.nouride-previous/` holds, or null when there is nothing to go back to. */
export function keptBuild(installDir: string): KeptBuild | null {
  const dir = join(installDir, PREVIOUS);
  const stat = statFile(dir);
  if (!stat?.isDirectory) return null;
  // Sorted: a directory's order is its filesystem's — ZFS on the live box listed `nouride, dashboard`.
  const names = listDir(dir).map((entry) => entry.name).filter((name) => name !== RELEASE_FILE).sort();
  if (!names.includes("nouride")) return null;
  let record: { version?: unknown; by?: unknown; at?: unknown } = {};
  try {
    record = JSON.parse(readTextFileSync(join(dir, RELEASE_FILE))) as typeof record;
  } catch {
    // Kept by an install from before the record: the directory's own time is when it was made.
  }
  const version = (value: unknown) => (typeof value === "string" && /^v?\d+\.\d+\.\d+\S*$/.test(value.trim()) ? value.trim() : null);
  const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  return { names, version: version(record.version), by: version(record.by), putAsideAt: Number.isFinite(at) ? at : stat.mtimeMs };
}

/**
 * The plan: the kept build, and the snapshot the update took as it migrated — the newest `before-NNN` one stamped
 * after the build was put aside. A snapshot taken by hand (`nouride db backup`) is not a migration's and is never
 * picked, and an older update's migration is from before this one. By the stamp in the name, as the backups
 * directory keeps its own chronology, and so to the second. Pure.
 */
export function planRollback(kept: KeptBuild, snapshots: readonly { name: string; path: string; at: number }[]): RollbackPlan {
  const since = Math.floor(kept.putAsideAt / 1000) * 1000;
  const migrated = snapshots
    .filter((snapshot) => snapshot.name.includes("-before-"))
    .map((snapshot) => ({ ...snapshot, at: takenAt(snapshot.name) ?? snapshot.at }))
    .filter((snapshot) => snapshot.at >= since)
    .sort((a, b) => b.at - a.at);
  return { ...kept, snapshot: migrated[0] ?? null };
}

const bare = (version: string) => version.replace(/^v/, "");

/** The first version that reads the encrypted store. */
const ENCRYPTED_STORE_SINCE = [0, 8, 19] as const;

/**
 * Whether the build going back in reads its secrets from `secrets.json` alone: one from before 0.8.19, or one whose
 * version is not known, which is taken for one, as writing the file for a build that does not need it costs nothing.
 * Pure.
 */
export function readsPlainSecrets(version: string | null): boolean {
  const parts = version ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim()) : null;
  if (!parts) return true;
  for (let i = 0; i < 3; i++) {
    const have = Number(parts[i + 1]);
    if (have !== ENCRYPTED_STORE_SINCE[i]) return have < ENCRYPTED_STORE_SINCE[i]!;
  }
  return false;
}

/**
 * Why this kept build is not the way back from `current`, or null when it is. Pure.
 *
 * A build put aside by another version is from before something else installed this one — a hand copy, or an
 * `install.sh` from before it kept anything — and swapping it in would skip a version and restore a snapshot that
 * version never had. The same version is nothing to go back to.
 */
export function rollbackRefusal(plan: KeptBuild, current: string): string | null {
  if (plan.by && bare(plan.by) !== bare(current)) {
    return `The build in ${PREVIOUS} was put aside by v${bare(plan.by)}, not by this version (v${bare(current)}): v${bare(current)} was installed some other way, and the build before it was not kept.`;
  }
  if (plan.version && bare(plan.version) === bare(current)) {
    return `The build in ${PREVIOUS} is v${bare(current)}, this same version: there is nothing older to go back to.`;
  }
  return null;
}

/**
 * Put back the build `.nouride-previous` holds, and keep the one it replaces there instead — so the same call goes
 * forward again. Here and not in the update plugin, as the unit's guard is: the way back has to work in a build that
 * cannot update. Each name is swapped through a third path beside it, and a failure part-way swaps back what it had
 * already swapped: an install left half on each version is a dashboard that does not match its binary.
 */
export function swapBack(installDir: string): string[] {
  const previous = join(installDir, PREVIOUS);
  const exists = (path: string) => statFile(path) !== null;
  const exchange = (name: string) => {
    const live = join(installDir, name);
    const kept = join(previous, name);
    const aside = join(installDir, `.nouride-swap-${name}`);
    removePath(aside);
    if (exists(live)) renamePath(live, aside);
    if (exists(kept)) renamePath(kept, live);
    if (exists(aside)) renamePath(aside, kept);
  };
  const swapped: string[] = [];
  try {
    for (const name of SWAPPED) {
      if (!exists(join(previous, name))) continue;
      exchange(name);
      swapped.push(name);
    }
  } catch (err) {
    for (const name of swapped.toReversed()) {
      try {
        exchange(name);
      } catch {
        // The error being reported is the one that started this.
      }
    }
    throw new Error(`putting the previous build back failed, and its files were left as they were: ${err instanceof Error ? err.message : String(err)}`);
  }
  return swapped;
}

export interface RollbackDeps {
  installDir: string;
  dbPath: string;
  /** The version being left, recorded in its place so a second rollback goes forward again. */
  currentVersion: string;
  swapBack: (installDir: string) => string[];
  restoreDatabase: (input: { from: string; dbPath: string }) => RestoreOutcome;
  /** The secrets as the build going back in reads them: `secrets.json`, for one before 0.8.19 (`readsPlainSecrets`). */
  plainSecrets?: { path: string; text: string } | null;
}

/**
 * Do it, with the daemon stopped. The database first: a snapshot that will not restore leaves everything as it was,
 * where a build swapped first would be an old binary over a database it refuses. Then the secrets as the older build
 * reads them, then the build. The version being left is then not taken again by an automatic update
 * (`rememberRollback`), and an update still waiting to be confirmed is not.
 */
export function applyRollback(plan: RollbackPlan, deps: RollbackDeps): { swapped: string[]; restored: RestoreOutcome | null; secrets: boolean } {
  let restored: RestoreOutcome | null = null;
  if (plan.snapshot) {
    restored = deps.restoreDatabase({ from: plan.snapshot.path, dbPath: deps.dbPath });
    if (!restored.ok) throw new Error(`the database could not be put back, so nothing was changed: ${restored.error}`);
  }
  let swapped: string[];
  try {
    if (deps.plainSecrets) writePlainSecrets(deps.plainSecrets.path, deps.plainSecrets.text);
    swapped = deps.swapBack(deps.installDir);
  } catch (err) {
    const undo = restored?.ok && restored.replaced ? ` The database was put back; the one it replaced is at ${restored.replaced}.` : "";
    throw new Error(`${(err instanceof Error ? err.message : String(err)).replace(/\.?$/, ".")}${undo}`);
  }
  // What is kept now is the version just left, put aside by the one going back in.
  recordKeptBuild(join(deps.installDir, PREVIOUS), { version: deps.currentVersion, by: plan.version });
  const pending = join(deps.installDir, PENDING_FILE);
  removePath(pending);
  removePath(`${pending}.attempts`);
  rememberRollback(deps.installDir, deps.currentVersion);
  return { swapped, restored, secrets: Boolean(deps.plainSecrets) };
}

/**
 * `secrets.json` whole or not at all, and 0600 from its creation: written beside it, then moved over whatever was
 * there (a plain copy older than the encrypted store, which the older build would otherwise read).
 */
function writePlainSecrets(path: string, text: string): void {
  const beside = `${path}.rollback`;
  removePath(beside);
  writeBytesSync(beside, new TextEncoder().encode(text), 0o600);
  renamePath(beside, path);
}
