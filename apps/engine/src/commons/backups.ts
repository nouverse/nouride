/**
 * The previous versions kept beside a file a save replaces — `<file>.bak.1` (newest) to `<file>.bak.5` — and the
 * older ones in `history/<file name>/` beside it.
 *
 * One rotation for every writer that keeps them: the config writes (`modules/config/config-file.ts`), a person's file,
 * the dashboard's file editor, and `memory_write`. They are kilobytes, and recoverable states cost nothing against the
 * one where an operator pastes over a soul they spent a month tuning, or a save undoes a hand edit nobody committed.
 */

import { basename, dirname, fileExists, fileMode, join, listDir, readTextFileIfExists, removePath, setModifiedTime, statFile, writeTextFileAtomic } from "@nouride/runtime";

const MAX_BACKUPS = 5;
/** The older slots move along at most this often. */
const SHIFT_EVERY_MS = 60 * 60_000;
/** Versions kept in `history/` per file, past `.bak.5`, as the vault keeps its own. */
const HISTORY_VERSIONS = 20;

/**
 * Keep `previousContent`, the text a save is about to replace, as `<path>.bak.1`, with the file's permissions (a
 * `config.toml` at 0640 had copies at 0644 beside it).
 *
 * `.bak.1` is always the version just before this save: `persona_edit` tells the model so. The older slots move along
 * at most once an hour (0.8.18, REVIEW B2): a save within the hour of `.bak.1` replaces it and leaves `.bak.2` to
 * `.bak.5` as they were, so a burst of saves (People writes, the Memory page's selects, one save per change) no longer
 * pushes out what a file said yesterday. On the live box all five of `config.toml`'s were from one minute
 * (2026-11-01), and a setting changed a week before had none left. What falls off `.bak.5` goes to `history/`, twenty
 * versions deep. The same text as `.bak.1` is no new version.
 */
export async function rotateBackups(path: string, previousContent: string, now: number = Date.now()): Promise<void> {
  const mode = fileMode(path) ?? undefined;
  const options = mode === undefined ? {} : { mode };
  const newest = `${path}.bak.1`;
  const held = await readTextFileIfExists(newest);
  if (held === previousContent) return;
  const age = held === null ? 0 : now - (statFile(newest)?.mtimeMs ?? 0);
  if (held !== null && age >= SHIFT_EVERY_MS) {
    const oldest = await readTextFileIfExists(`${path}.bak.${MAX_BACKUPS}`);
    if (oldest !== null) await keepInHistory(path, oldest, now, options);
    for (let index = MAX_BACKUPS - 1; index >= 1; index -= 1) {
      const from = `${path}.bak.${index}`;
      if (await fileExists(from)) {
        const content = await readTextFileIfExists(from);
        if (content !== null) await writeTextFileAtomic(`${path}.bak.${index + 1}`, content, options);
      }
    }
  }
  await writeTextFileAtomic(newest, previousContent, options);
  // Its age is when this save kept it, on the clock this was given: a disk's own sub-millisecond time ran ahead of it.
  setModifiedTime(newest, now);
}

/** `history/<file name>/<stamp>` beside `path`, the oldest past `HISTORY_VERSIONS` let go. */
async function keepInHistory(path: string, content: string, now: number, options: { mode?: number }): Promise<void> {
  const dir = join(dirname(path), "history", basename(path));
  await writeTextFileAtomic(join(dir, new Date(now).toISOString().replace(/[:.]/g, "-")), content, options);
  const versions = listDir(dir)
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name)
    .sort();
  for (const old of versions.slice(0, Math.max(0, versions.length - HISTORY_VERSIONS))) removePath(join(dir, old));
}

/**
 * The file as it was before this version's first start rewrote it: `<path>.before-<version>`, written once (REVIEW
 * B2). A boot that rewrites a file (the people's move, the keys it writes) is the change nobody asked for, and the
 * way back to the previous version wants it as that version left it, whatever the five slots have seen since.
 */
export async function keepBefore(path: string, version: string): Promise<void> {
  const copy = `${path}.before-${version}`;
  if (await fileExists(copy)) return;
  const content = await readTextFileIfExists(path);
  if (content === null) return;
  const mode = fileMode(path) ?? undefined;
  await writeTextFileAtomic(copy, content, mode === undefined ? {} : { mode });
}
