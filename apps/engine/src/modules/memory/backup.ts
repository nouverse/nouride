/**
 * Snapshots of the vault.
 *
 * The database is backed up daily and the packs are, but the database is only memory's index: the
 * truth is the vault, and it had no copy. One bad SD card was every profile and every conversation.
 *
 * A snapshot is a full directory tree under `data/backups/memory/<stamp>/`, so recovery is `cp -r`,
 * readable by anyone without this code — the rule the pack backups keep. A file unchanged since the
 * previous snapshot is hard-linked to it rather than copied (`rsync --link-dest`), so a week of
 * snapshots costs about one vault plus what changed; where the filesystem refuses a link, it is copied.
 *
 * "Unchanged" is decided from size and modification time, as `rsync` decides it, never by reading: each copy keeps
 * its source's time (`copyFileAtomic`), so the next snapshot compares two stats per file. Comparing contents read
 * every vault file and its previous copy on every boot, from an SD card (E10). A vault restored or synced from
 * elsewhere has new times on unchanged files, so its first snapshot copies them all once, and links from then on.
 */

import { join } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { filesUnder, newestSnapshotAt, snapshotFiles, type SnapshotResult } from "@/commons/snapshot-files.ts";

const log = createLogger("memory.backup");

export type VaultBackupResult = SnapshotResult;

/** Where the daemon's own snapshots of the vault go — always those taken before a rewrite, and the daily ones unless `[daemon] backup_dir` moves them. */
export function vaultBackupDir(dataDir: string): string {
  return join(dataDir, "backups", "memory");
}

/** Where the daemon's own snapshots of the knowledge folder go (0.8.20, KNOWLEDGE_BASE §4). */
function knowledgeBackupDir(dataDir: string): string {
  return join(dataDir, "backups", "knowledge");
}

/** When the newest snapshot of the knowledge folder was taken, or null: as the vault's is read. */
export function newestKnowledgeBackupAt(input: { dataDir: string; backupDir?: string }): number | null {
  return newestSnapshotAt([knowledgeBackupDir(input.dataDir), ...(input.backupDir ? [join(input.backupDir, "knowledge")] : [])]);
}

/**
 * One snapshot of the knowledge folder, the oldest dropped: the documents people kept, kept like the vault, unchanged
 * files hard-linked, so a week of snapshots of a folder of PDFs costs about one copy plus what changed. Never throws.
 */
export async function backupKnowledge(input: { knowledgeDir: string; dataDir: string; backupDir?: string; keep: number; now?: () => number; skipUnchanged?: boolean }): Promise<VaultBackupResult> {
  const root = input.backupDir ? join(input.backupDir, "knowledge") : knowledgeBackupDir(input.dataDir);
  const empty: VaultBackupResult = { path: null, files: 0, linked: 0, removed: 0 };
  try {
    const files = filesUnder(input.knowledgeDir).map((rel) => ({ rel, abs: join(input.knowledgeDir, rel) }));
    if (files.length === 0) return empty;
    const result = snapshotFiles({ root, files, keep: input.keep, now: (input.now ?? Date.now)(), ...(input.skipUnchanged ? { skipUnchanged: true } : {}) });
    if (result.path) log.info("knowledge base backed up", { path: result.path, files: result.files, linked: result.linked, removed: result.removed });
    return result;
  } catch (err) {
    log.error("could not back up the knowledge base", { error: String(err) });
    return empty;
  }
}

/**
 * When the newest snapshot of the vault was taken — of any kind, in the daemon's own directory and in `backupDir` —
 * or null when there is none. From the name, as the database's are read (`db/backup.ts`): a restored filesystem
 * rewrites mtimes.
 */
export function newestVaultBackupAt(input: { dataDir: string; backupDir?: string }): number | null {
  return newestSnapshotAt([vaultBackupDir(input.dataDir), ...(input.backupDir ? [join(input.backupDir, "memory")] : [])]);
}

/**
 * Take one snapshot of the vault, then drop the oldest (`commons/snapshot-files.ts`, unchanged files hard-linked).
 *
 * Never throws: a backup that fails must not take the daemon down.
 *
 * `skipUnchanged`, for the scheduled snapshots: when every file is the previous snapshot's and none was added or
 * removed, nothing is written. Another copy of the same vault adds nothing, and it pushed an older, different one out
 * of the rotation — a week nobody talked to the agents cost the week before it. A snapshot taken before a rewrite
 * (`before`) is always taken: it is that rewrite's way back.
 */
export async function backupVault(input: { vaultDir: string; dataDir: string; backupDir?: string; keep: number; now?: () => number; before?: string; skipUnchanged?: boolean }): Promise<VaultBackupResult> {
  // `backupDir` is `commons/backup-dir.ts`'s answer; absent, the daemon's own `<dataDir>/backups`.
  const root = input.backupDir ? join(input.backupDir, "memory") : vaultBackupDir(input.dataDir);
  const empty: VaultBackupResult = { path: null, files: 0, linked: 0, removed: 0 };
  // A vault configured around the data directory would copy its own backups into each snapshot.
  if (`${root}/`.startsWith(`${input.vaultDir.replace(/\/+$/, "")}/`)) {
    log.error("the memory vault contains the backup directory; not backed up", { vault: input.vaultDir, backups: root });
    return empty;
  }
  try {
    const files = filesUnder(input.vaultDir).map((rel) => ({ rel, abs: join(input.vaultDir, rel) }));
    const result = snapshotFiles({
      root,
      files,
      keep: input.keep,
      now: (input.now ?? Date.now)(),
      ...(input.before ? { before: input.before } : {}),
      ...(input.skipUnchanged ? { skipUnchanged: true } : {}),
    });
    if (result.path) log.info("memory vault backed up", { path: result.path, files: result.files, linked: result.linked, removed: result.removed });
    return result;
  } catch (err) {
    log.error("could not back up the memory vault", { error: String(err) });
    return empty;
  }
}
