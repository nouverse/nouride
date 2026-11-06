/**
 * Keeping the vault in shape after a pass — `docs/SPEC.md` §12.2.
 *
 * - **Compaction**: a filed episode past `[memory] transcript_days` loses its transcript; its summary
 *   and metadata stay forever. With `archive` on, the whole file is first kept as `.md.gz` under
 *   `archive/`, where no agent and no MCP client can read it — it exists to file again with a better
 *   model, not to be recalled.
 * - **Day hubs**, rewritten for the days that changed and their neighbours.
 * - **Deleting an episode** takes its archive copy, its vectors, and every fact it sourced with it: a
 *   fact must never outlive the conversation that justified who may read it.
 */

import { fileExists, gunzipText, gzipText, join, listDir, readFileBytes, statFile, writeFileAtomic } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { parseEpisode } from "./episode.ts";
import { recordDeleted } from "./deleted.ts";
import { renderDay } from "./graph.ts";
import { filesWithVersions } from "./history.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryStatePort } from "./memory-state.store.ts";
import type { MemoryVectorPort } from "./memory-vectors.store.ts";
import { readProfile, withoutSources, writeProfile } from "./profile.ts";
import { EPISODE_ID, type Vault } from "./vault.ts";
import { changeEpisode, removeEpisode, rewriteProfile, scrubVersions, writeSide } from "./write.ts";

const log = createLogger("memory");

/**
 * Compact every filed episode that ended before `before`. With `archive`, the file as it was is kept
 * compressed first, and an episode whose archive could not be written keeps its transcript — a
 * failed write must not be how a conversation is lost. The copy is made under the episode's lock: made
 * before it, a conversation deleted in between left its transcript in the archive. Returns the days touched.
 */
export async function compactEpisodes(input: { vault: Vault; index: MemoryIndexPort; before: number; archive: boolean }): Promise<{ compacted: number; days: Set<string> }> {
  const days = new Set<string>();
  let compacted = 0;
  for (const candidate of input.index.withStatus("summarized")) {
    if (candidate.endedAt >= input.before) continue;
    const archive = input.vault.archive(candidate.id);
    const done = await changeEpisode(input, candidate.id, async (episode, text) => {
      if (episode.status !== "summarized") return null;
      if (input.archive && !(await fileExists(archive))) await writeFileAtomic(archive, gzipText(text));
      return { ...episode, status: "compacted", transcript: "" };
    });
    if (!done || done.status !== "compacted") continue;
    compacted += 1;
    days.add(done.day);
  }
  return { compacted, days };
}

/**
 * Give compacted episodes their transcript back from the archive — what keeping transcripts forever
 * means for the ones already compacted. The episode keeps its summary, tags and everything else as it
 * is now (edited since, perhaps); only the transcript comes from the archived copy, and the archive stays.
 * An archive that cannot be read leaves its episode as it was. Returns the days touched.
 */
export async function restoreArchived(input: { vault: Vault; index: MemoryIndexPort }): Promise<{ restored: number; days: Set<string> }> {
  const days = new Set<string>();
  let restored = 0;
  for (const candidate of input.index.withStatus("compacted")) {
    const file = input.vault.archive(candidate.id);
    if (!(await fileExists(file))) continue;
    let archived;
    try {
      archived = parseEpisode(gunzipText(await readFileBytes(file)), candidate.id);
    } catch {
      continue;
    }
    if ("problem" in archived || !archived.transcript) continue;
    const transcript = archived.transcript;
    const done = await changeEpisode(input, candidate.id, (episode) => (episode.status === "compacted" ? { ...episode, status: "summarized", transcript } : null));
    if (!done || done.status !== "summarized") continue;
    restored += 1;
    days.add(done.day);
  }
  return { restored, days };
}

/**
 * Rewrite the hubs of these days, and of the days next to them, whose previous/next may have moved.
 * Returns the days whose hub could not be written, and why: one is logged and left, and the rest are
 * drawn — a hub is generated, so a later run draws it again.
 */
export async function refreshDays(vault: Vault, index: MemoryIndexPort, days: Iterable<string>): Promise<{ day: string; problem: string }[]> {
  const all = new Set<string>();
  for (const day of days) {
    all.add(day);
    const { previous, next } = index.adjacentDays(day);
    if (previous) all.add(previous);
    if (next) all.add(next);
  }
  const problems: { day: string; problem: string }[] = [];
  for (const day of all) {
    try {
      const episodes = index.allEpisodes({ since: day, until: day }, 1_000);
      await writeSide(vault.day(day), () => (episodes.length ? renderDay(day, episodes, index.adjacentDays(day)) : null));
    } catch (err) {
      problems.push({ day, problem: err instanceof Error ? err.message : String(err) });
    }
  }
  if (problems.length) log.warn("day hubs that could not be drawn", { days: problems.slice(0, 10) });
  return problems;
}

/**
 * Delete episodes and everything that depends on them. Returns how many facts went with them. A value
 * that is not an episode id names no episode, and is passed over rather than built into a path.
 *
 * Final, as the dashboard says: what they taught leaves every place it was kept. The profiles change
 * without a version kept, and the versions kept before lose those facts too — one Undo on a profile put
 * them back, sourced to a conversation that no longer existed. Their vectors go, and so do the changes
 * they made and the pass's failed attempts at them (`state`), which Recent changes and Gave up showed on.
 */
export async function deleteEpisodes(
  input: { vault: Vault; index: MemoryIndexPort; vectors?: MemoryVectorPort; state: Pick<MemoryStatePort, "forget" | "recordChanges">; now: () => number },
  requested: readonly string[],
): Promise<{ episodes: number; facts: number }> {
  const ids = requested.filter((id) => EPISODE_ID.test(id));
  if (ids.length === 0) return { episodes: 0, facts: 0 };
  const sources = new Set(ids);
  const days = new Set<string>();
  const found = input.index.episodesById(ids);
  for (const episode of found) days.add(episode.day);
  const episodes = found.length;
  // Before a file goes: where each one ended stays in the vault, so a cut — which starts where a chat's latest episode
  // ends — does not file it again from the turn log (`deleted.ts`). A crash after this and before the removal leaves a
  // mark and the episode, which the next cut would have skipped anyway.
  await recordDeleted(input.vault, found);
  // Under each episode's lock: the nightly pass files a conversation's facts while it holds it, so they
  // are either written before this, and swept below, or not written at all.
  for (const id of ids) await removeEpisode(input, id);

  let facts = 0;
  const subjects = input.index.subjects();
  // Their vectors, by the ids the index gives the facts — read before the sweep below drops them.
  const gone = input.index.facts(subjects).filter((fact) => fact.source !== undefined && sources.has(fact.source)).map((fact) => fact.id);
  for (const subject of subjects) {
    await rewriteProfile(input, subject, (existing) => {
      const profile = readProfile(existing);
      const result = withoutSources(profile.body, sources);
      facts += result.removed;
      return { text: result.removed ? writeProfile({ front: profile.front, body: result.body }) : existing };
    }, { keepVersion: false });
  }
  for (const file of filesWithVersions(input.vault)) await scrubVersions(input.vault, file, (text) => withoutSourcesIn(text, sources));
  input.vectors?.remove([...ids, ...gone]);
  input.state.forget({ episodes: ids });
  await refreshDays(input.vault, input.index, days);
  return { episodes, facts };
}

/** A profile's text without the facts sourced from these episodes — or as it was, when it had none. */
function withoutSourcesIn(text: string, sources: ReadonlySet<string>): string {
  const profile = readProfile(text);
  const result = withoutSources(profile.body, sources);
  return result.removed ? writeProfile({ front: profile.front, body: result.body }) : text;
}

/**
 * How much the transcript archive holds — §4.3, shown beside the archive switch. Nothing reads the
 * archive but a person re-filing, so without this it only ever grew out of sight.
 */
export function archiveSize(vault: Pick<Vault, "archiveDir">): { files: number; bytes: number } {
  const total = { files: 0, bytes: 0 };
  const walk = (dir: string): void => {
    for (const entry of listDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) walk(path);
      else if (entry.name.endsWith(".md.gz")) {
        total.files += 1;
        total.bytes += statFile(path)?.size ?? 0;
      }
    }
  };
  walk(vault.archiveDir);
  return total;
}
