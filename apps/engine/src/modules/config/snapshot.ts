/**
 * Snapshots of what the database, the vault and the packs did not hold (0.8.18, REVIEW B2): the daemon's own
 * `config.toml` and its people, whose only copies were the five `.bak` slots beside them; the install's MCP library;
 * the secret store, sealed to the backup passphrase when one is set (D5, `sealed-secrets.ts`); and the skill pool,
 * where an approved improvement overwrote `SKILL.md` and kept nothing.
 *
 * `<backups>/config/<stamp>/` holds `config.toml`, `people/<key>.toml`, `mcp.toml` and `secrets.sealed`;
 * `<backups>/skills/<stamp>/` the pool as it is on disk. Taken as the vault's are (`commons/snapshot-files.ts`): weekly
 * and at boot, unchanged files hard-linked, nothing written when nothing changed, `[daemon] backup_keep` of each.
 * Restored by copying back, the secrets through `nouride secret unseal`.
 */

import { join, listDir, statFile } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { filesUnder, newestSnapshotAt, snapshotFiles, type SnapshotFile, type SnapshotResult } from "@/commons/snapshot-files.ts";
import { peopleDirOf } from "@/modules/people/files.ts";
import { sealedSecretsCopy } from "./sealed-secrets.ts";

const log = createLogger("config.snapshot");

const rootsOf = (kind: string, input: { dataDir: string; backupDir?: string }) => [
  join(input.dataDir, "backups", kind),
  ...(input.backupDir ? [join(input.backupDir, kind)] : []),
];

const rootOf = (kind: string, input: { dataDir: string; backupDir?: string }) => join(input.backupDir ?? join(input.dataDir, "backups"), kind);

/** What the config snapshot holds: the daemon's config, each person's file (no backups, no history), the MCP library. */
function configSnapshotFiles(configPath: string, agentsDir: string): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  if (statFile(configPath)) files.push({ rel: "config.toml", abs: configPath });
  const people = peopleDirOf(configPath);
  for (const entry of listDir(people)) {
    if (!entry.isDirectory && entry.name.endsWith(".toml")) files.push({ rel: `people/${entry.name}`, abs: join(people, entry.name) });
  }
  const library = join(agentsDir, "mcp.toml");
  if (statFile(library)) files.push({ rel: "mcp.toml", abs: library });
  return files;
}

type SnapshotInput = { dataDir: string; backupDir?: string; keep: number; now?: () => number; skipUnchanged?: boolean };

/**
 * One snapshot of the config, its people, the MCP library and, with `seal` (`[daemon] backup_seal`), the secret store
 * sealed to it. Never throws: a failed backup must not take the daemon down.
 */
export function backupConfig(input: SnapshotInput & { configPath: string; agentsDir: string; seal?: string; secrets?: () => string | null }): SnapshotResult {
  return taken("config", "the config and its people", input, () => {
    const sealed = sealedSecretsCopy(input.dataDir, input.seal ?? "", input.seal ? (input.secrets?.() ?? null) : null);
    return [...configSnapshotFiles(input.configPath, input.agentsDir), ...(sealed ? [{ rel: "secrets.sealed", abs: sealed }] : [])];
  });
}

/** What a skill's tools install for themselves, made again by installing them: not what a person wrote. */
const INSTALLED = new Set(["node_modules", "__pycache__", ".venv"]);

/** One snapshot of the skill pool, `agents/skills/`, without what its tools installed. Never throws. */
export function backupSkillPool(input: SnapshotInput & { agentsDir: string }): SnapshotResult {
  const pool = join(input.agentsDir, "skills");
  return taken("skills", "the skill pool", input, () => filesUnder(pool, "", INSTALLED).map((rel) => ({ rel, abs: join(pool, rel) })));
}

/** When the newest snapshot of a kind was taken, in the daemon's own directory or `backupDir`; null when there is none. */
export function newestSnapshotOf(kind: "config" | "skills", input: { dataDir: string; backupDir?: string }): number | null {
  return newestSnapshotAt(rootsOf(kind, input));
}

function taken(kind: string, what: string, input: SnapshotInput, files: () => SnapshotFile[]): SnapshotResult {
  try {
    const result = snapshotFiles({
      root: rootOf(kind, input),
      files: files(),
      keep: input.keep,
      now: (input.now ?? Date.now)(),
      ...(input.skipUnchanged ? { skipUnchanged: true } : {}),
    });
    if (result.path) log.info(`${what} backed up`, { path: result.path, files: result.files, linked: result.linked, removed: result.removed });
    return result;
  } catch (err) {
    log.error(`could not back up ${what}`, { error: String(err) });
    return { path: null, files: 0, linked: 0, removed: 0 };
  }
}
