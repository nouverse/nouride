/**
 * Snapshots of the persona packs.
 *
 * `docs/DEPLOY.md` names what to keep and puts one thing first: **`agents/` — `MEMORY.md` above all.
 * Months of accumulated identity, not in git, and the only thing here that cannot be rebuilt.** The
 * database can be restored from a backup, the config can be retyped, the workspace is output. An
 * agent's memory is the one file whose loss is permanent.
 *
 * `memory_write` already rotates five `.bak` files, and that covers the failure it was written for:
 * the agent corrupting its own memory with a bad edit. It does not cover the operator deleting the
 * directory, a bad `git checkout`, or a disk. Those need a copy somewhere else.
 *
 * ## Deliberately boring
 *
 * A directory of dated copies, not an archive. No tar, no compression, no external binary — the point
 * is that recovery is `cp`, readable by anyone at three in the morning without needing this code to
 * still work. These are kilobytes of markdown; the space argument for an archive does not apply.
 *
 * Inside `data/`, which is the mounted volume in every deployment shape, so a snapshot lands wherever
 * the operator already backs up. Putting it beside `agents/` would mean the one directory that gets
 * deleted takes its own backups with it.
 */

import { ensureDir, join, listDir, readTextFileIfExists, removePath, statFile, writeTextFileAtomic } from "@nouride/runtime";
import { createLogger, snapshotStamp } from "@nouride/shared";

const log = createLogger("agents.backup");

/** What is worth keeping. Everything else in a pack is either derived or already in git. */
const BACKED_UP = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "MEMORY.md", "config.toml", "skills.toml", "mcp.toml"];

export interface BackupResult {
  /** Directory written, or null when there was nothing to copy. */
  path: string | null;
  agents: number;
  files: number;
  removed: number;
  /** Nothing was written because every file is as the newest snapshot has it — see `skipUnchanged`. */
  unchanged?: true;
}

// Sortable, and sorting is how the sweep decides what is oldest — the one stamp every backup writes.
const stamp = snapshotStamp;

function snapshots(root: string): string[] {
  return listDir(root)
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort();
}

/** When the newest snapshot of the packs was taken, from its name — or null when there is none. */
export function newestAgentBackupAt(input: { dataDir: string; backupDir?: string }): number | null {
  const newest = snapshots(join(input.backupDir ?? join(input.dataDir, "backups"), "agents")).at(-1);
  const m = newest ? /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(newest) : null;
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}

/**
 * Copy every pack's durable files into a dated directory, then drop the oldest.
 *
 * Never throws. A backup that fails must not take the daemon down — the failure it protects against is
 * rarer than the daemon being useful, and an operator who finds no snapshots has lost less than one
 * who finds no daemon.
 *
 * `skipUnchanged`, for the scheduled snapshots: when every file reads as it does in the newest snapshot, and that
 * snapshot holds no other, nothing is written. Another copy of the same packs adds nothing and pushes an older,
 * different one out of the rotation. Compared by content: these are kilobytes.
 */
export async function backupAgents(input: {
  agentsDir: string;
  dataDir: string;
  /** The backups directory, when the daemon was told to keep them elsewhere. Absent: `<dataDir>/backups`. */
  backupDir?: string;
  keep: number;
  now?: () => number;
  skipUnchanged?: boolean;
}): Promise<BackupResult> {
  const now = (input.now ?? Date.now)();
  const root = join(input.backupDir ?? join(input.dataDir, "backups"), "agents");
  const empty: BackupResult = { path: null, agents: 0, files: 0, removed: 0 };

  try {
    const entries = listDir(input.agentsDir).filter((entry) => entry.isDirectory);
    if (entries.length === 0) return empty;

    // Read first, written after: what is read decides whether anything is.
    const found: { agent: string; name: string; content: string }[] = [];
    for (const entry of entries) {
      for (const name of BACKED_UP) {
        const content = await readTextFileIfExists(join(input.agentsDir, entry.name, name));
        // A pack legitimately lacks most of these. Absent is not an error, and writing an empty file
        // for one would make a restore create files the original never had.
        if (content !== null) found.push({ agent: entry.name, name, content });
      }
    }
    if (found.length === 0) return empty;

    const newest = snapshots(root).at(-1);
    if (input.skipUnchanged && newest) {
      const held = listDir(join(root, newest)).flatMap((agent) => (agent.isDirectory ? listDir(join(root, newest, agent.name)).map(() => 1) : []));
      let same = held.length === found.length;
      for (const file of found) {
        if (!same) break;
        same = (await readTextFileIfExists(join(root, newest, file.agent, file.name))) === file.content;
      }
      if (same) return { ...empty, unchanged: true };
    }

    const target = join(root, stamp(now));
    for (const file of found) await writeTextFileAtomic(join(target, file.agent, file.name), file.content);
    const agents = new Set(found.map((file) => file.agent)).size;
    const files = found.length;

    const removed = sweep(root, input.keep);
    log.info("persona packs backed up", { path: target, agents, files, removed });
    return { path: target, agents, files, removed };
  } catch (err) {
    log.error("could not back up the persona packs", { error: String(err) });
    return empty;
  }
}

/**
 * Keep the newest `keep` snapshots.
 *
 * By name, which sorts chronologically because the stamp was built to. Reading mtimes would be the
 * obvious alternative and is the wrong one: an mtime changes when a filesystem is restored from a
 * backup, so a retention rule keyed on it either wipes a restored archive or never fires — the same
 * trap the attachment sweep documents.
 */
function sweep(root: string, keep: number): number {
  if (keep <= 0) return 0;
  if (!statFile(root)) return 0;

  const names = snapshots(root);
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const name of doomed) removePath(join(root, name));
  return doomed.length;
}

/** Ensure the backup root exists, so a first run does not fail on a missing parent. */
export function prepareBackupDir(dataDir: string): void {
  ensureDir(join(dataDir, "backups", "agents"));
}
