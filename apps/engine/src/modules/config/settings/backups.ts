/**
 * `[daemon] backup_seal` (0.8.18): the passphrase the snapshots' secrets are sealed to, kept only as the public half
 * of the key it derives (`config/sealed-secrets.ts`). Never the passphrase in a log, an audit row or an answer.
 *
 * A config snapshot is taken as it is set, so the person can open it straight away and know the passphrase works,
 * rather than learn it on the day they need it. With none set, the sealed copy beside the store goes at once; the
 * snapshots already taken keep theirs, sealed to the passphrase of their day.
 */

import { createLogger } from "@nouride/shared";
import { backupDirFor, missingBackupDir } from "@/commons/backup-dir.ts";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { backupSealFor, sealedSecretsCopy } from "@/modules/config/sealed-secrets.ts";
import { backupConfig } from "@/modules/config/snapshot.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

/** Shorter than this guards nothing a snapshot on a lost drive needs guarding from. */
const MIN_PASSPHRASE = 12;

/** A seal set: the snapshot taken with it, or why none could be (a backup drive not mounted). */
export type SealResult = SaveResult & { snapshot?: string; skipped?: string };

export async function setBackupSeal(deps: SettingsDeps, params: { passphrase: string | null; actor?: string }): Promise<SealResult> {
  if (params.passphrase !== null && params.passphrase.length < MIN_PASSPHRASE) {
    return { ok: false, error: `a backup passphrase is at least ${MIN_PASSPHRASE} characters: it is all that stands between a lost drive and every credential` };
  }
  const value = params.passphrase === null ? null : backupSealFor(params.passphrase);
  const saved = await editConfigFile(deps, (source) => (value === null ? removeTomlKey(source, "daemon", "backup_seal") : upsertTomlTable(source, "daemon", { backup_seal: value })));
  if (!saved.ok) return saved;
  log.info(value ? "secrets go into the config snapshots, sealed to the backup passphrase" : "secrets are kept out of the config snapshots", { actor: params.actor });
  deps.audit?.record({ action: value ? "backup_seal_set" : "backup_seal_removed", actor: params.actor });

  const daemon = deps.config.daemon;
  if (value === null) {
    sealedSecretsCopy(daemon.dataDir, "", null);
    return { ok: true, restartRequired: false };
  }
  const where = backupDirFor(daemon);
  if ("missing" in where) return { ok: true, restartRequired: false, skipped: missingBackupDir(where.missing) };
  const taken = backupConfig({ configPath: deps.configPath, agentsDir: daemon.agentsDir, dataDir: daemon.dataDir, backupDir: where.dir, keep: daemon.backupKeep, seal: value, secrets: () => deps.secrets.sealedCopyText() });
  return { ok: true, restartRequired: false, ...(taken.path ? { snapshot: taken.path } : {}) };
}
