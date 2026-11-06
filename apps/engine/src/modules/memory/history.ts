/**
 * A profile's earlier versions, and `shared.md`'s: what Undo goes back to.
 *
 * `MEMORY.md` in a pack keeps rotating backups beside it. Here the earlier versions go to
 * `.history/<the file's path>/<time>.md` instead, hidden from the graph and from anything that lists a
 * folder, and deep enough (`MAX_VERSIONS`) that a bad night can be undone a step at a time.
 *
 * Nothing here takes a lock: each is called by `write.ts` holding the lock of the file the versions are of,
 * so a version is never kept, undone or scrubbed in the middle of a change to that file.
 */

import { escapes, join, listDir, readTextFileIfExists, relative, removePath, writeTextFileAtomic } from "@nouride/runtime";
import type { Vault } from "./vault.ts";

/** What history needs of the vault: where it is, and where earlier versions go. */
type VaultRoot = Pick<Vault, "root" | "history">;

/** Versions kept per file. Kilobytes each, so depth is cheap; a week of nightly changes fits. */
const MAX_VERSIONS = 20;

function historyDir(vault: VaultRoot, file: string): string {
  const inside = relative(vault.root, file);
  if (escapes(inside)) throw new Error(`${file} is not under the memory root`);
  return join(vault.history, inside);
}

/** Sortable and unique enough for one writer per file under a lock: `2026-09-25T14-05-00-123Z`. */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

function versionsOf(dir: string): string[] {
  return listDir(dir)
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

/** Keep `content` as the newest version of `file`, and let the oldest past `MAX_VERSIONS` go. */
export async function keepVersion(vault: VaultRoot, file: string, content: string, now: number): Promise<void> {
  const dir = historyDir(vault, file);
  await writeTextFileAtomic(join(dir, `${stamp(now)}.md`), content);
  const versions = versionsOf(dir);
  for (const old of versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS))) {
    removePath(join(dir, old));
  }
}

/**
 * The version before the last change: its text, and a way to let it go once it is put back. Null when there is none.
 * A stack: each undo goes one step further back, and the version it restores leaves the history — after the file is
 * written, so a crash between the two loses nothing.
 */
export async function newestVersion(vault: VaultRoot, file: string): Promise<{ text: string; drop: () => void } | null> {
  const dir = historyDir(vault, file);
  const newest = versionsOf(dir).pop();
  if (!newest) return null;
  return { text: (await readTextFileIfExists(join(dir, newest))) ?? "", drop: () => removePath(join(dir, newest)) };
}

/**
 * Every earlier version of `file` put through `scrub`. How many changed. For what no version may keep once it is gone
 * from the file: the facts a deleted conversation taught.
 */
export async function scrubVersions(vault: VaultRoot, file: string, scrub: (text: string) => string): Promise<number> {
  const dir = historyDir(vault, file);
  let changed = 0;
  for (const name of versionsOf(dir)) {
    const path = join(dir, name);
    const text = await readTextFileIfExists(path);
    if (text === null) continue;
    const scrubbed = scrub(text);
    if (scrubbed === text) continue;
    await writeTextFileAtomic(path, scrubbed);
    changed += 1;
  }
  return changed;
}

/** Every earlier version of `file`, gone — a forgotten person's own profile. */
export function dropVersions(vault: VaultRoot, file: string): void {
  removePath(historyDir(vault, file));
}

/**
 * The memory files that have earlier versions — profiles and `shared.md` — as their paths in the vault,
 * whether or not the file is still there.
 */
export function filesWithVersions(vault: Pick<Vault, "root" | "history" | "peopleDir" | "shared">): string[] {
  const people = listDir(join(vault.history, relative(vault.root, vault.peopleDir)))
    .filter((entry) => entry.isDirectory && entry.name.endsWith(".md"))
    .map((entry) => join(vault.peopleDir, entry.name));
  const shared = listDir(join(vault.history, relative(vault.root, vault.shared))).length > 0 ? [vault.shared] : [];
  return [...people, ...shared];
}

/** A file's earlier versions, newest first, by the stamp each is named with. */
export function memoryFileVersions(vault: VaultRoot, file: string): string[] {
  return versionsOf(historyDir(vault, file))
    .map((name) => name.slice(0, -3))
    .reverse();
}

/** One earlier version's text, or null when there is no such version. */
export async function readMemoryFileVersion(vault: VaultRoot, file: string, version: string): Promise<string | null> {
  if (!/^[0-9TZ-]+$/.test(version)) return null;
  return await readTextFileIfExists(join(historyDir(vault, file), `${version}.md`));
}
