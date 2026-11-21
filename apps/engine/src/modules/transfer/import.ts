/**
 * An export brought into this install: opened and checked first, then put in place of what is here.
 *
 * Two steps, so that everything that can refuse does so before anything of this install is touched. `openImport`
 * unpacks the file into a folder of its own and reads it: not an export, damaged, made by a newer Nouride ("Update
 * Nouride first"), its secrets not opened by the passphrase. Only what it hands back can be applied.
 *
 * `applyImport` runs while no daemon has the database open: from the command with the daemon stopped, or as the daemon
 * starts (`boot/staged-import.ts`). It replaces; nothing is merged. Each thing this install holds is first moved into
 * a folder beside it (`kept`), which is the snapshot, and stays there after; then the export's is moved in. A step that
 * fails moves everything back as it was, in reverse. What the import then does to the database it brought, before any
 * daemon opens it: migrated as an update would, every sign-in ended, the missions at work paused, and the mark that
 * holds connections and automations back until "Go live" (`held.ts`).
 *
 * The places an install names for itself stay this machine's: where its folders are, and where its dashboard listens.
 */

import { databaseVersion, dirExists, ensureDir, extractTarGz, fileExistsSync, join, dirname, openWithPassphrase, parseToml, readBytesSync, readTextFileSync, removePath, renamePath, restrictDatabaseFiles, statFile, writeBytesSync } from "@nouride/runtime";
import { SecretStore, secretsOf, type StoredSecret } from "@nouride/secrets";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { ImportReport } from "@nouride/wire";
import { LAST_RUN_FILE, PENDING_FILE } from "@/boot/last-run.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { verify } from "@/db/backup.ts";
import { rotateDatabaseEpoch } from "@/db/epoch.ts";
import { openAndMigrate } from "@/db/index.ts";
import { FLOOR_SCHEMA, MIGRATIONS } from "@/db/migrations.ts";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { EXPORT_FORMAT, placesOf, type ExportManifest } from "./archive.ts";
import { recordImport } from "./held.ts";
import { automationsOn, endEverySignIn } from "./transfer.store.ts";

const log = createLogger("transfer");

export type ImportRefusal = {
  ok: false;
  why: "not-an-export" | "cut-short" | "damaged" | "newer" | "older" | "passphrase";
  /** For the log. */
  error: string;
  /** In everyday words, as the terminal says it; the page's are written at its route, from `why`. */
  plain: string;
  /** The release that made the file, where it could be read. */
  from?: string;
};

export interface OpenedImport {
  ok: true;
  manifest: ExportManifest;
  /** The folder the file was unpacked into: an install's parts, by their names. */
  staging: string;
  /** Its secrets, opened; null where it holds none. */
  secrets: Record<string, StoredSecret> | null;
}

const refusal = (why: ImportRefusal["why"], error: string, plain: string, from?: string): ImportRefusal => ({ ok: false, why, error, plain, ...(from ? { from } : {}) });

/** `1.2.3` as numbers, a part that is not one as 0: enough to tell an older release from a newer one. */
const numbers = (version: string): number[] => version.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);

function newer(theirs: string, ours: string): boolean {
  const [a, b] = [numbers(theirs), numbers(ours)];
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/**
 * `file` unpacked into `staging` (emptied first) and checked. Refused, with the staging folder emptied again: a file
 * that is not an export of Nouride or cannot be read to its end; one from a newer release or a newer database than this
 * build knows; one from before the oldest this build starts on; a database that does not check out; and, where it holds
 * secrets, a passphrase that does not open them.
 */
export async function openImport(input: { file: string; staging: string; passphrase?: string | undefined; version: string }): Promise<OpenedImport | ImportRefusal> {
  let from: string | undefined;
  const refuse = (why: ImportRefusal["why"], error: string, plain: string): ImportRefusal => {
    removePath(input.staging);
    return refusal(why, error, plain, from);
  };
  removePath(input.staging);
  ensureDir(input.staging, 0o700);
  try {
    await extractTarGz(input.file, input.staging);
  } catch (err) {
    return refuse("cut-short", `${input.file} could not be unpacked: ${err instanceof Error ? err.message : String(err)}`, "This file could not be read to its end. It may not be an export of Nouride, or it was cut short on its way here.");
  }
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(readTextFileSync(join(input.staging, "manifest.json"))) as ExportManifest;
    if (manifest.product !== "nouride" || typeof manifest.format !== "number" || typeof manifest.version !== "string") throw new Error("its manifest is not an export's");
  } catch (err) {
    return refuse("not-an-export", `${input.file} is not an export of Nouride: ${err instanceof Error ? err.message : String(err)}`, "This file is not an export of Nouride.");
  }
  from = manifest.version;
  const database = join(input.staging, "data", "nouride.db");
  const schema = databaseVersion(database);
  const newest = MIGRATIONS.at(-1)!.version;
  if (manifest.format > EXPORT_FORMAT || manifest.schema > newest || (schema ?? 0) > newest || newer(manifest.version, input.version)) {
    return refuse("newer", `${input.file} was made by Nouride ${manifest.version} (schema ${manifest.schema}), newer than this one (${input.version}, schema ${newest})`, `Update Nouride first. This file was made by Nouride ${manifest.version}, which is newer than the one running here (${input.version}).`);
  }
  const verdict = statFile(database) ? verify(database) : { ok: false, detail: "it holds no database" };
  if (!verdict.ok || schema === null) return refuse("damaged", `the database in ${input.file} does not check out: ${verdict.detail}`, "The database in this file is damaged. Export again from the old machine.");
  if (schema < FLOOR_SCHEMA) {
    return refuse("older", `${input.file} holds a database this version does not start on (schema ${schema})`, `This file was made by Nouride ${manifest.version}, which is too old to bring in here. Update the old machine first, then export again.`);
  }

  let secrets: Record<string, StoredSecret> | null = null;
  if (manifest.secrets !== null) {
    const sealed = join(input.staging, "secrets.sealed");
    try {
      if (!input.passphrase) throw new Error("no passphrase was given");
      secrets = secretsOf(JSON.parse(new TextDecoder().decode(openWithPassphrase(input.passphrase, readBytesSync(sealed)))) as unknown, sealed);
    } catch (err) {
      return refuse("passphrase", `the secrets in ${input.file} did not open: ${err instanceof Error ? err.message : String(err)}`, "That password does not open this file's secrets. It is the one typed when the file was made.");
    }
  }
  return { ok: true, manifest, staging: input.staging, secrets };
}

/** The keys of `config.toml` that say where this install is and where it listens: this machine's own, never an export's. */
const OWN_PLACES: readonly (readonly [table: string, key: string])[] = [
  ["daemon", "data_dir"],
  ["daemon", "agents_dir"],
  ["daemon", "workspace_dir"],
  ["daemon", "backup_dir"],
  ["memory", "dir"],
  ["dashboard", "host"],
  ["dashboard", "port"],
  ["dashboard", "public_url"],
  ["nougate", "port"],
];

/** An export's config with this machine's own places: each as `here` writes it, and absent where `here` leaves it out. */
export function configForHere(theirs: string, here: string): string {
  const mine = parseToml<Record<string, Record<string, unknown> | undefined>>(here);
  let text = theirs;
  for (const [table, key] of OWN_PLACES) {
    const value = mine[table]?.[key];
    text = typeof value === "string" || typeof value === "number" ? upsertTomlTable(text, table, { [key]: value }) : removeTomlKey(text, table, key);
  }
  return text;
}

/** Every setting whose value reads as a path of this machine and is not there: for the page that says how it went. */
export function missingPlaces(configText: string): { setting: string; path: string }[] {
  const missing: { setting: string; path: string }[] = [];
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") {
      if (/^\/[^\s]*$/.test(value) && !value.startsWith("//") && !fileExistsSync(value) && !dirExists(value)) missing.push({ setting: at, path: value });
    } else if (Array.isArray(value)) value.forEach((one, n) => walk(one, `${at}[${n}]`));
    else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) walk(inner, at ? `${at}.${key}` : key);
  };
  try {
    walk(parseToml(configText), "");
  } catch {
    // A config that does not parse is said by the daemon as it starts, in its own words.
  }
  return missing;
}

/** One thing of this install an import touches: where it is, and where it is kept while the import's is in its place. */
interface Moved {
  path: string;
  kept: string;
  had: boolean;
}

export type Applied = { ok: true; report: ImportReport } | { ok: false; error: string; /** Whether everything is back as it was. */ restored: boolean };

/**
 * `opened` put in place of what this install holds. `kept`: a new folder, on the disk the install is on, for what it
 * held. `before` is called as each step starts, by name: a test's way in to fail one.
 */
export async function applyImport(input: {
  opened: OpenedImport;
  config: GlobalConfig;
  configPath: string;
  kept: string;
  store: { env: Record<string, string | undefined>; layout: NonNullable<Parameters<typeof SecretStore.restore>[3]>["layout"] };
  now?: () => number;
  before?: (step: string) => void;
}): Promise<Applied> {
  const { opened, config, configPath } = input;
  const { manifest, staging } = opened;
  const data = config.daemon.dataDir;
  const dbPath = join(data, "nouride.db");
  const now = (input.now ?? Date.now)();
  const moved: Moved[] = [];
  const step = (name: string): void => input.before?.(name);

  /** What is at `path` moved into `kept`, and remembered: whatever is put at `path` after this is undone with it. */
  const aside = (path: string, name: string): void => {
    const kept = join(input.kept, name);
    const had = statFile(path) !== null;
    moved.push({ path, kept, had });
    if (!had) return;
    ensureDir(dirname(kept));
    renamePath(path, kept);
  };
  const putBack = (): boolean => {
    let whole = true;
    for (const one of moved.reverse()) {
      try {
        removePath(one.path);
        if (one.had) renamePath(one.kept, one.path);
      } catch (err) {
        whole = false;
        log.error("a part of this install could not be put back after a failed import", { path: one.path, kept: one.kept, error: String(err) });
      }
    }
    return whole;
  };

  try {
    ensureDir(input.kept, 0o700);
    const hereConfig = fileExistsSync(configPath) ? readTextFileSync(configPath) : "";

    step("files");
    for (const place of placesOf(config, configPath, manifest.folders)) {
      aside(place.path, place.name);
      const from = join(staging, place.name);
      ensureDir(dirname(place.path));
      if (statFile(from)) renamePath(from, place.path);
      else if (place.kind === "folder") ensureDir(place.path);
    }

    step("config");
    writeBytesSync(configPath, new TextEncoder().encode(configForHere(fileExistsSync(configPath) ? readTextFileSync(configPath) : "", hereConfig)), 0o600);

    step("database");
    for (const suffix of ["", "-wal", "-shm", ".epoch"]) aside(`${dbPath}${suffix}`, `data/nouride.db${suffix}`);
    // What the daemon keeps beside the database about its last run here: another database's is not this one's.
    for (const name of ["clean-shutdown.json", LAST_RUN_FILE, PENDING_FILE, "secrets.sealed", "secrets.sealed.for", "approvals-kept.json"]) aside(join(data, name), `data/${name}`);
    ensureDir(data);
    renamePath(join(staging, "data", "nouride.db"), dbPath);
    restrictDatabaseFiles(dbPath);
    rotateDatabaseEpoch(dbPath);
    // The release the database last ran on: this build then brings it forward as it would after an update.
    writeBytesSync(join(data, LAST_RUN_FILE), new TextEncoder().encode(`${manifest.version}\n`));

    step("secrets");
    for (const name of ["secrets.enc", "secrets.json"]) aside(join(data, name), `data/${name}`);
    await SecretStore.restore(data, opened.secrets ?? {}, input.store.env, { layout: input.store.layout });

    step("migrate");
    const db = await openAndMigrate(dbPath);
    let report: ImportReport;
    try {
      step("mark");
      const ended = endEverySignIn(db, now);
      const missions = new MissionStore(db);
      let paused = 0;
      for (const mission of missions.open()) {
        if (mission.status === "waiting") continue;
        // As a person's pause is kept (`person.ts`): it goes on from its checklist when someone says to.
        Object.assign(mission, { status: "waiting", waitKind: "paused", pausedBy: "the import", pausedByAgent: null, reason: "paused by the import: this install was moved to another machine", updatedAt: now });
        missions.save(mission);
        paused += 1;
      }
      const text = readTextFileSync(configPath);
      const gateways = parseToml<{ gateways?: Record<string, Record<string, { enabled?: boolean }>> }>(text).gateways ?? {};
      report = {
        at: now,
        from: { version: manifest.version, madeAt: manifest.madeAt },
        agents: manifest.agents,
        secrets: manifest.secrets,
        folders: manifest.folders,
        parts: manifest.parts,
        passed: manifest.passed,
        ended,
        held: {
          connections: Object.entries(gateways).flatMap(([platform, named]) => Object.entries(named).filter(([, one]) => one.enabled === true).map(([name]) => `${platform}:${name}`)),
          automations: automationsOn(db),
          missions: paused,
        },
        missing: missingPlaces(text),
        kept: input.kept,
        live: false,
      };
      recordImport(new DaemonStateStore(db), report);
    } finally {
      db.close();
    }
    removePath(staging);
    log.info("an export was imported", { from: manifest.version, agents: manifest.agents.length, secrets: manifest.secrets, kept: input.kept });
    return { ok: true, report };
  } catch (err) {
    const restored = putBack();
    // Everything is back where it was: what is left of the folder is the empty folders it was moved through.
    if (restored) removePath(input.kept);
    log.error("an import failed, and this install was put back as it was", { error: String(err), restored });
    return { ok: false, error: err instanceof Error ? err.message : String(err), restored };
  }
}
