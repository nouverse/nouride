/**
 * An install as one file: what an export holds, and writing it.
 *
 * Nothing took an install to another machine as a whole. The snapshots keep its parts apart (the database, the config,
 * the packs, the memory), each for putting one part back where it was; moving house meant knowing all of them, and the
 * secrets did not travel at all without the key beside them.
 *
 * An export is a `.tar.gz` a person opens with their own tools. First in it `manifest.json`, which says what the rest
 * is; then `data/nouride.db`, a verified snapshot taken as the scheduled ones are (`db/backup.ts`); the config and its
 * people; the agents' packs with the skill pool; the memory; the documents; what was sent in chats; the work notes.
 * The secrets are in it only sealed to a passphrase given for this export (`secrets.sealed`, as a config snapshot seals
 * its copy): with none, it holds no secret. The agents' own folders are in it when asked for, without what holds a
 * sign-in or a key (the rule Files lists by) and without what tools installed for themselves.
 *
 * Not in it, each decided: a coding CLI's sign-ins, the snapshots, logs kept as files, installed tools and caches, a
 * chat app's own session, and the files this machine is known by (its control token, its key).
 */

import { ensureDir, join, listDir, removePath, renamePath, resolve, sealKeyFromPassphrase, sealToKey, statFile, writeTarGz, type TarEntry } from "@nouride/runtime";
import { sharedWorkspace } from "@nouride/persona";
import type { GlobalConfig } from "@nouride/shared";
import { keptFolders } from "@/boot/kept-folders.ts";
import { verify } from "@/db/backup.ts";
import { knowledgeDirOf } from "@/modules/memory/index.ts";
import { peopleDirOf } from "@/modules/people/files.ts";

/** What an export needs of the database: a snapshot of it written to a path, and its schema's version. */
export interface SnapshotSource {
  backupTo(path: string): void;
  userVersion(): number;
}

/** The archive's own version: what a reader checks before anything else. */
export const EXPORT_FORMAT = 1;

/** The names an archive's parts go by, in it and in its manifest. */
const PARTS = ["config", "agents", "memory", "knowledge", "uploads", "notes", "attachments", "workspace"] as const;
export type PartName = (typeof PARTS)[number];

export interface ExportManifest {
  format: number;
  product: "nouride";
  /** The release that made it, and its database's schema: a reader older than either refuses it. */
  version: string;
  schema: number;
  madeAt: number;
  /** Whether `secrets.sealed` is in it, and how many secrets that holds. */
  secrets: number | null;
  /** Whether the agents' own folders are in it. */
  folders: boolean;
  agents: string[];
  database: { bytes: number };
  parts: Partial<Record<PartName, { files: number; bytes: number }>>;
  /** What was passed over inside the parts that are in it: links, and files that hold a sign-in or a key. */
  passed: { links: number; credentials: number };
}

/** Where one part is on this machine. A file for the config; folders for the rest. */
export interface Place {
  part: PartName;
  /** Its path inside the archive, and under an install's folders. */
  name: string;
  path: string;
  kind: "file" | "folder";
}

/**
 * Whether a file of an agent's folder, by its path under the install's folder, holds a sign-in or a key and stays out
 * of an export. The rule is the one Files lists by (`web/control/system-files.ts` `leftOut`), handed in by whoever asks
 * for the export.
 */
export type HoldsCredential = (path: string) => boolean;

/** What tools install for themselves, made again by installing them: never a person's or an agent's own work. */
const INSTALLED = new Set(["node_modules", "__pycache__", ".venv", ".cache"]);

/**
 * Every place an export reads and an import writes, by this machine's config. The agents' folders last, and only where
 * asked for: they are the part that can be large.
 */
export function placesOf(config: GlobalConfig, configPath: string, folders: boolean): Place[] {
  const data = config.daemon.dataDir;
  return [
    { part: "config", name: "config/config.toml", path: configPath, kind: "file" },
    { part: "config", name: "config/people", path: peopleDirOf(configPath), kind: "folder" },
    { part: "agents", name: "agents", path: config.daemon.agentsDir, kind: "folder" },
    { part: "memory", name: "memory", path: config.memory.dir, kind: "folder" },
    { part: "knowledge", name: "knowledge", path: knowledgeDirOf(data), kind: "folder" },
    { part: "uploads", name: "uploads", path: join(data, "uploads"), kind: "folder" },
    { part: "notes", name: "notes", path: join(data, "notes"), kind: "folder" },
    { part: "attachments", name: "attachments", path: keptFolders(config).attachments, kind: "folder" },
    ...(folders
      ? ([
          { part: "workspace", name: "workspace/private", path: join(config.daemon.workspaceDir, "private"), kind: "folder" },
          { part: "workspace", name: "workspace/shared", path: sharedWorkspace(config.daemon.workspaceDir), kind: "folder" },
        ] satisfies Place[])
      : []),
  ];
}

/** The credentials folder as the walk meets it: one whole path, whatever the config's spelling of it. */
const credentialsOf = (config: GlobalConfig): string => resolve(keptFolders(config).credentials);

interface Found {
  entries: TarEntry[];
  files: number;
  bytes: number;
  links: number;
  credentials: number;
}

/**
 * The files under one place as archive entries, with what was passed over. A backup beside a file (`.bak.N`), a write
 * in flight and what tools installed are no part of an install; in the agents' folders, neither is a coding CLI's own
 * folder nor any file Files would not show.
 *
 * `never`: the credentials folder, wherever the config puts it. It is no place of its own here, and an install that
 * keeps it inside its agents' folder (`agents/shared/.credentials`, as the live box does) had its key files and tokens
 * in the export with the packs, readable by whoever held the file.
 */
function gather(place: Place, leftOut: HoldsCredential, never: string): Found {
  const found: Found = { entries: [], files: 0, bytes: 0, links: 0, credentials: 0 };
  const take = (abs: string, name: string): void => {
    const stat = statFile(abs);
    if (!stat || stat.isDirectory) return;
    found.entries.push({ name, from: abs, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs });
    found.files += 1;
    found.bytes += stat.size;
  };
  if (place.kind === "file") {
    take(place.path, place.name);
    return found;
  }
  const agentsOwn = place.part === "workspace";
  const walk = (dir: string, rel: string): void => {
    const entries = listDir(dir);
    // A folder with nothing in it is kept: an agent's empty folder is still its folder.
    if (entries.length === 0 && rel) found.entries.push({ name: `${place.name}/${rel}`, directory: true });
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (INSTALLED.has(entry.name) || (agentsOwn && entry.name === ".cli")) continue;
        if (resolve(join(dir, entry.name)) === never) found.credentials += 1;
        else if (agentsOwn && leftOut(`${place.name}/${path}`)) found.credentials += 1;
        else walk(join(dir, entry.name), path);
      } else if (!entry.isFile) found.links += 1;
      else if (entry.name.endsWith(".tmp") || /\.bak\.\d+$/.test(entry.name)) continue;
      else if (agentsOwn && leftOut(`${place.name}/${path}`)) found.credentials += 1;
      else take(join(dir, entry.name), `${place.name}/${path}`);
    }
  };
  walk(place.path, "");
  return found;
}

/** What an export would hold and how large, before it is made: the page's and the command's first words. */
export function exportPlan(input: { config: GlobalConfig; configPath: string; dbPath: string; folders: boolean; credential: HoldsCredential }): { parts: ExportManifest["parts"]; database: number; folders: { files: number; bytes: number }; bytes: number } {
  const parts: ExportManifest["parts"] = {};
  for (const place of placesOf(input.config, input.configPath, true)) {
    const found = gather(place, input.credential, credentialsOf(input.config));
    const was = parts[place.part] ?? { files: 0, bytes: 0 };
    parts[place.part] = { files: was.files + found.files, bytes: was.bytes + found.bytes };
  }
  const folders = parts.workspace ?? { files: 0, bytes: 0 };
  if (!input.folders) delete parts.workspace;
  const database = ["", "-wal"].reduce((sum, suffix) => sum + (statFile(`${input.dbPath}${suffix}`)?.size ?? 0), 0);
  return { parts, database, folders, bytes: database + Object.values(parts).reduce((sum, part) => sum + part.bytes, 0) };
}

export type Exported = { ok: true; path: string; bytes: number; manifest: ExportManifest } | { ok: false; error: string };

/**
 * The export written to `out`, through a name of its own until it is whole. `work` is a folder for the database's
 * snapshot while it is archived, emptied after. `secrets`: the store as the daemon holds it, and the passphrase it is
 * sealed to; without both no secret is in the file.
 */
export async function writeExport(input: {
  config: GlobalConfig;
  configPath: string;
  db: SnapshotSource;
  version: string;
  agents: readonly string[];
  out: string;
  work: string;
  folders: boolean;
  credential: HoldsCredential;
  secrets?: { passphrase: string; store: string; count: number } | undefined;
  now?: () => number;
  onProgress?: (done: { files: number; bytes: number }) => void;
}): Promise<Exported> {
  const snapshot = join(input.work, "nouride.db");
  const partial = `${input.out}.partial`;
  try {
    ensureDir(input.work, 0o700);
    removePath(snapshot);
    input.db.backupTo(snapshot);
    const verdict = verify(snapshot);
    if (!verdict.ok) return { ok: false, error: `the database's snapshot did not check out: ${verdict.detail}` };
    const size = statFile(snapshot)?.size ?? 0;

    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      product: "nouride",
      version: input.version,
      schema: input.db.userVersion(),
      madeAt: (input.now ?? Date.now)(),
      secrets: input.secrets ? input.secrets.count : null,
      folders: input.folders,
      agents: [...input.agents].sort(),
      database: { bytes: size },
      parts: {},
      passed: { links: 0, credentials: 0 },
    };
    const entries: TarEntry[] = [{ name: "data/nouride.db", from: snapshot, size, mode: 0o600 }];
    for (const place of placesOf(input.config, input.configPath, input.folders)) {
      const found = gather(place, input.credential, credentialsOf(input.config));
      entries.push(...found.entries);
      const was = manifest.parts[place.part] ?? { files: 0, bytes: 0 };
      manifest.parts[place.part] = { files: was.files + found.files, bytes: was.bytes + found.bytes };
      manifest.passed.links += found.links;
      manifest.passed.credentials += found.credentials;
    }
    if (input.secrets) {
      entries.push({ name: "secrets.sealed", bytes: sealToKey(sealKeyFromPassphrase(input.secrets.passphrase), new TextEncoder().encode(input.secrets.store)), mode: 0o600 });
    }
    // The manifest first, so the first thing a reader meets says what the rest is.
    entries.unshift({ name: "manifest.json", bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 });

    const done = { files: 0, bytes: 0 };
    removePath(partial);
    await writeTarGz(partial, entries, (entry) => {
      done.files += 1;
      done.bytes += "from" in entry ? entry.size : "bytes" in entry ? entry.bytes.length : 0;
      input.onProgress?.(done);
    });
    renamePath(partial, input.out);
    return { ok: true, path: input.out, bytes: statFile(input.out)?.size ?? 0, manifest };
  } catch (err) {
    removePath(partial);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) removePath(`${snapshot}${suffix}`);
  }
}
