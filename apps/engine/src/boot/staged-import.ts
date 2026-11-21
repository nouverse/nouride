/**
 * An import asked for from the dashboard, applied as the daemon starts.
 *
 * The page cannot replace an install under the daemon that serves it: the database is open, and the config it runs on
 * is the one being replaced. So the daemon only checks the file and leaves it unpacked (`stageImport`), with a note
 * that says it is ready, then restarts. `nouride start` looks for the note before it reads its config, and applies the
 * import as the command does with the daemon stopped (`modules/transfer/import.ts`): what the install held is moved
 * aside first, and a failure moves it all back and leaves a line for the page to say.
 *
 * The secrets were opened with the passphrase while the person was there to type it. Between then and the restart they
 * wait in the unpacked folder under a key written in the note, both owner-only and both removed as the import is
 * applied: seconds, on the disk that holds the store they are about to be in.
 */

import { dirname, fileExistsSync, join, openAesGcm, randomBytes, readBytesSync, readTextFileSync, removePath, sealAesGcm, writeBytesSync } from "@nouride/runtime";
import type { StoredSecret } from "@nouride/secrets";
import { createLogger } from "@nouride/shared";
import { daemonKeyLayout } from "@/boot/secret-store.ts";
import { runningDaemon } from "@/cli/daemon-lock.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import type { ExportManifest } from "@/modules/transfer/archive.ts";
import { applyImport, type OpenedImport } from "@/modules/transfer/import.ts";

const log = createLogger("transfer");

const READY = "import-ready.json";
const FAILED = "import-failed.json";
const SECRETS = "secrets.staged";

/** The install's own folder, beside its data: where an import is unpacked, and what it replaced is kept. */
export const installFolder = (dataDir: string): string => dirname(dataDir);
export const stagingOf = (dataDir: string): string => join(installFolder(dataDir), "import-staging");
export const keptName = (now: number): string => `before-import-${new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

/** `opened` left ready for the next start, by `by`. */
export function stageImport(dataDir: string, opened: OpenedImport, by: string, now: number): void {
  let key: string | null = null;
  if (opened.secrets) {
    const raw = randomBytes(32);
    key = raw.toString("hex");
    writeBytesSync(join(opened.staging, SECRETS), sealAesGcm(raw, new TextEncoder().encode(JSON.stringify(opened.secrets))), 0o600);
  }
  writeBytesSync(join(installFolder(dataDir), READY), new TextEncoder().encode(JSON.stringify({ staging: opened.staging, key, by, at: now })), 0o600);
}

/** Whether an import waits for the next start. */
export const importStaged = (dataDir: string): boolean => fileExistsSync(join(installFolder(dataDir), READY));

/** An import taken back before the restart that would apply it. */
export function unstageImport(dataDir: string): void {
  removePath(join(installFolder(dataDir), READY));
  removePath(stagingOf(dataDir));
}

/** Why the last import asked for from the dashboard did not go in, until another is tried: null when it did, or none was. */
export function lastImportFailure(dataDir: string): { at: number; error: string; restored: boolean } | null {
  try {
    const path = join(installFolder(dataDir), FAILED);
    return fileExistsSync(path) ? (JSON.parse(readTextFileSync(path)) as { at: number; error: string; restored: boolean }) : null;
  } catch {
    return null;
  }
}

export const forgetImportFailure = (dataDir: string): void => removePath(join(installFolder(dataDir), FAILED));

/**
 * As `nouride start` begins: an import left ready is applied, before the config is read for the daemon. Never throws:
 * a start that cannot apply one starts on what the install holds, and the page says why.
 */
export async function applyStagedImport(now: () => number = Date.now): Promise<"none" | "applied" | "failed"> {
  let dataDir: string;
  let config: Awaited<ReturnType<typeof loadConfig>>["config"];
  let configPath: string;
  try {
    const loaded = await loadConfig({ soft: true });
    config = loaded.config;
    configPath = loaded.source ?? defaultConfigPath();
    dataDir = config.daemon.dataDir;
  } catch {
    // A config that does not load is the daemon's to say, as it starts.
    return "none";
  }
  const ready = join(installFolder(dataDir), READY);
  if (!fileExistsSync(ready) || runningDaemon(dataDir) !== null) return "none";
  const fail = (error: string, restored: boolean): "failed" => {
    log.error("the import left ready did not go in", { error, restored });
    writeBytesSync(join(installFolder(dataDir), FAILED), new TextEncoder().encode(JSON.stringify({ at: now(), error, restored })), 0o600);
    removePath(stagingOf(dataDir));
    return "failed";
  };
  let note: { staging: string; key: string | null };
  try {
    note = JSON.parse(readTextFileSync(ready)) as { staging: string; key: string | null };
  } finally {
    // Read once: a start after this one never applies the same note again, whatever became of this try.
    removePath(ready);
  }
  try {
    const manifest = JSON.parse(readTextFileSync(join(note.staging, "manifest.json"))) as ExportManifest;
    const sealed = join(note.staging, SECRETS);
    const secrets = note.key ? (JSON.parse(new TextDecoder().decode(openAesGcm(Buffer.from(note.key, "hex"), readBytesSync(sealed)))) as Record<string, StoredSecret>) : null;
    removePath(sealed);
    const kept = join(installFolder(dataDir), keptName(now()));
    const done = await applyImport({ opened: { ok: true, manifest, staging: note.staging, secrets }, config, configPath, kept, store: { env: { ...process.env }, layout: daemonKeyLayout({ dataDir, configPath }) }, now });
    if (!done.ok) return fail(done.error, done.restored);
    removePath(join(installFolder(dataDir), FAILED));
    log.info("the import left ready was applied", { from: manifest.version, kept });
    return "applied";
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), true);
  }
}
