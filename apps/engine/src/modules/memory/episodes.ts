/**
 * Episode files on disk: read back, listed, and a new one's id chosen. Written through `write.ts`.
 *
 * An episode is written by the system (a cut, the nightly pass, compaction), never edited as prose,
 * so there is no history kept for it the way a profile has one.
 */

import { join, listDir, readTextFileIfExists } from "@nouride/runtime";
import { withFileLock } from "@/commons/file-lock.ts";
import { parseEpisode, type Episode } from "./episode.ts";
import { EPISODE_ID, type Vault } from "./vault.ts";

/**
 * One writer of new episodes at a time, per vault — a cut, or a conversation saved over MCP.
 *
 * An id is chosen by looking for a file and taken by writing one, so two writers between those steps
 * choose the same id and the second file replaces the first: `/new` in one chat while the nightly pass
 * cuts another, both starting at the same minute with the same agent. Held around the choosing and the
 * writing; a cut is a few files, so whoever waits waits briefly. Keyed by the episodes folder, which no
 * other lock names.
 */
export async function creatingEpisodes<T>(vault: Vault, fn: () => Promise<T>): Promise<T> {
  return await withFileLock(vault.episodesDir, fn);
}

export async function readEpisode(vault: Vault, id: string): Promise<Episode | null> {
  if (!EPISODE_ID.test(id)) return null;
  const text = await readTextFileIfExists(vault.episode(id));
  if (text === null) return null;
  const parsed = parseEpisode(text, id);
  return "problem" in parsed ? null : parsed;
}

/** Every episode file there is, by id, as `episodes/YYYY/MM/<id>.md`. */
export function episodeFiles(vault: Vault): { id: string; file: string }[] {
  const out: { id: string; file: string }[] = [];
  for (const year of listDir(vault.episodesDir).filter((entry) => entry.isDirectory && /^\d{4}$/.test(entry.name))) {
    for (const month of listDir(join(vault.episodesDir, year.name)).filter((entry) => entry.isDirectory && /^\d{2}$/.test(entry.name))) {
      for (const entry of listDir(join(vault.episodesDir, year.name, month.name))) {
        const id = entry.name.replace(/\.md$/, "");
        if (!entry.isDirectory && entry.name.endsWith(".md") && EPISODE_ID.test(id)) {
          out.push({ id, file: join(vault.episodesDir, year.name, month.name, entry.name) });
        }
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
