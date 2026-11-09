/**
 * A snapshot of a set of files: `<root>/<stamp>/<relative path>`, each file that did not change since the previous
 * snapshot hard-linked to it rather than copied, the oldest past `keep` swept. The memory vault's way (`memory/backup.ts`),
 * shared since 0.8.18 with the snapshots of what a person or the skill-learning loop makes and the vault and the packs
 * did not hold: the daemon's config and its people, the skill pool.
 */

import { copyFileAtomic, join, linkFile, listDir, removePath, renamePath, statFile } from "@nouride/runtime";
import { snapshotStamp, snapshotTakenAt } from "@nouride/shared";

export interface SnapshotResult {
  /** The snapshot written, or null when there was nothing to copy. */
  path: string | null;
  files: number;
  /** Files shared with the previous snapshot instead of copied. */
  linked: number;
  /** Older snapshots dropped by the retention rule. */
  removed: number;
  /** Nothing was written because nothing changed since the previous snapshot — see `skipUnchanged`. */
  unchanged?: true;
}

/** One file of a snapshot: where it is, and its path inside the snapshot. */
export interface SnapshotFile {
  rel: string;
  abs: string;
}

/**
 * A snapshot taken before something rewrites the files (`-before-<what>`), kept apart from the scheduled rotation: only
 * the newest of each kind is kept, however many scheduled ones come after it.
 */
const BEFORE = "-before-";

/** How recent a change has to be for its file's size and time not to be believed. */
const RACY_MS = 2_000;

/**
 * Every file under `dir`, as paths relative to it, but for folders named in `skip`. Regular files only: a link points
 * out of what is snapshotted, and a socket or a pipe cannot be copied (a skill's `node_modules` held links to a global
 * install, and the copy of the pool stopped on them, 2026-11-05). A write in flight (`*.tmp`) is not a file yet.
 */
export function filesUnder(dir: string, prefix = "", skip: ReadonlySet<string> = new Set()): string[] {
  return listDir(join(dir, prefix)).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) return skip.has(entry.name) ? [] : filesUnder(dir, path, skip);
    return entry.isFile && !entry.name.endsWith(".tmp") ? [path] : [];
  });
}

/** Whether a file is the same as its copy in a snapshot, by size and time — the copy kept its source's time. */
function sameFile(file: string, copy: string): boolean {
  const a = statFile(file);
  const b = statFile(copy);
  // Not trusted while it is new. A file's time moves in the kernel's coarse ticks — a few milliseconds — so one
  // rewritten to the same length straight after it was copied keeps the time it had, and would be linked to a copy of
  // what it no longer says. Git calls this racy clean; a file older than this is past any tick.
  if (a === null || a.mtimeMs > Date.now() - RACY_MS) return false;
  // Within a millisecond: the time is set through seconds as a float, which keeps microseconds, not nanoseconds.
  return b !== null && !b.isDirectory && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;
}

/** The snapshots under `root`, oldest first: not one still being written, whose name starts with a dot. */
function snapshotNames(root: string): string[] {
  return listDir(root)
    .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** When the newest snapshot under any of `roots` was taken, from its name; null when there is none. */
export function newestSnapshotAt(roots: readonly string[]): number | null {
  const stamps = roots.flatMap((root) => snapshotNames(root).map((name) => snapshotTakenAt(name))).filter((at): at is number => at !== null);
  return stamps.length > 0 ? Math.max(...stamps) : null;
}

/**
 * `files` as one snapshot under `root`, named by `now` (and `before`, for one taken before a rewrite). With
 * `skipUnchanged`, nothing is written when every file is as the previous snapshot has it and it holds no other.
 * Throws what the copy throws: the caller says what could not be snapshotted.
 */
export function snapshotFiles(input: { root: string; files: readonly SnapshotFile[]; keep: number; now: number; before?: string; skipUnchanged?: boolean }): SnapshotResult {
  const empty: SnapshotResult = { path: null, files: 0, linked: 0, removed: 0 };
  if (input.files.length === 0) return empty;
  const name = `${snapshotStamp(input.now)}${input.before ? `${BEFORE}${input.before}` : ""}`;
  const previous = snapshotNames(input.root).filter((snapshot) => snapshot < name).at(-1);
  const same = (file: SnapshotFile) => previous !== undefined && sameFile(file.abs, join(input.root, previous, file.rel));
  if (
    input.skipUnchanged &&
    !input.before &&
    previous !== undefined &&
    input.files.every(same) &&
    filesUnder(join(input.root, previous)).length === input.files.length
  ) {
    return { ...empty, unchanged: true };
  }
  const target = join(input.root, name);
  // Written under a name no reader takes for a snapshot, and given its own only once whole: a copy that stopped half-way
  // left a snapshot of half the files, which the next one was compared with and a restore would have trusted.
  const building = join(input.root, `.${name}.building`);
  removePath(building);
  let linked = 0;
  try {
    for (const file of input.files) {
      if (same(file) && linkFile(join(input.root, previous!, file.rel), join(building, file.rel))) {
        linked += 1;
        continue;
      }
      copyFileAtomic(file.abs, join(building, file.rel));
    }
    renamePath(building, target);
  } catch (err) {
    removePath(building);
    throw err;
  }
  return { path: target, files: input.files.length, linked, removed: sweep(input.root, input.keep) };
}

/**
 * Keep the newest `keep`, by name, and of the snapshots taken before a rewrite only the newest of each
 * kind. A linked file survives its older name being removed.
 */
function sweep(root: string, keep: number): number {
  // A snapshot a killed process was writing, under its unfinished name: the one just finished is not one of them.
  for (const entry of listDir(root)) if (entry.isDirectory && entry.name.startsWith(".") && entry.name.endsWith(".building")) removePath(join(root, entry.name));
  if (keep <= 0) return 0;
  const all = snapshotNames(root);
  const rotation = all.filter((name) => !name.includes(BEFORE));
  const doomed = rotation.slice(0, Math.max(0, rotation.length - keep));
  const kinds = new Map<string, string[]>();
  for (const name of all.filter((n) => n.includes(BEFORE))) {
    const kind = name.slice(name.indexOf(BEFORE));
    kinds.set(kind, [...(kinds.get(kind) ?? []), name]);
  }
  for (const names of kinds.values()) doomed.push(...names.slice(0, -1));
  for (const name of doomed) removePath(join(root, name));
  return doomed.length;
}
