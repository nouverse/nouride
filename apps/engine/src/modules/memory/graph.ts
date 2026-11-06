/**
 * The nodes the graph needs besides conversations and profiles — `docs/SPEC.md` §12.2.
 *
 * - **Stubs** for agents, groups and tags: small files with a `type`, so each node has its name
 *   instead of a grey unresolved link. Written once, when first needed, and never overwritten — a
 *   group renamed by hand, a tag given aliases, stays as the person left it. A tag's stub only from
 *   its second use, and removed again when no two conversations share it any more.
 * - **Day hubs**: the day's episodes, and the days before and after, so days form a time line. Only
 *   episodes: people and tags reach a day through its episodes, which keeps the graph from becoming
 *   one knot. Generated whole each time; a hand edit of a hub is not kept.
 */

import { join, listDir } from "@nouride/runtime";
import { link, renderFront } from "./frontmatter.ts";
import type { IndexedEpisode } from "./memory-index.store.ts";
import { dayPath, type Vault } from "./vault.ts";
import { writeSide } from "./write.ts";

/** A stub written when there is none, and never over one a person may have changed. */
async function writeOnce(file: string, text: string): Promise<boolean> {
  return await writeSide(file, (existing) => (existing === null ? text : undefined));
}

/** A tag stub as written, before anybody edits it — what `pruneTagStubs` may remove without losing a word. */
export function tagStub(): string {
  return renderFront({ type: "tag", aliases: [] }, "Other spellings listed under `aliases` are read as this tag.\n");
}

/**
 * Stubs for the agents, group and tags an episode links to that have none yet. A tag's only when
 * `stubTag` says so — on its second use: a tag one conversation has links nothing, and a stub per
 * once-used tag is how the production box came to hold 668 files in one folder.
 */
export async function ensureStubs(vault: Vault, episode: { agents: readonly string[]; chat: string; group?: string; tags: readonly string[] }, stubTag: (tag: string) => boolean = () => false): Promise<void> {
  for (const agent of episode.agents) {
    const file = vault.agent(agent);
    if (file) await writeOnce(file, renderFront({ type: "agent", name: agent }, `Conversations ${agent} took part in link here. Its own notes are its persona's MEMORY.md.\n`));
  }
  if (episode.group) {
    await writeOnce(vault.group(episode.group), renderFront({ type: "group", chat: episode.chat }, "Where what is learned in this group is kept; `chat` ties it to the conversation. The file's name is not the group's: name a group on the dashboard's Groups page.\n"));
  }
  for (const tag of episode.tags.filter(stubTag)) await writeOnce(vault.tag(tag), tagStub());
}

/**
 * Remove the stubs of tags no two episodes share, where the stub is still exactly as it was written —
 * nobody listed an alias or wrote a word in it, so nothing is lost. The tag stays on its episode; its
 * stub comes back on the tag's second use. How many went.
 */
export async function pruneTagStubs(vault: Vault, counts: ReadonlyMap<string, number>): Promise<number> {
  const blank = tagStub();
  let removed = 0;
  for (const entry of listDir(vault.tagsDir)) {
    if (entry.isDirectory || !entry.name.endsWith(".md")) continue;
    if ((counts.get(entry.name.slice(0, -3)) ?? 0) >= 2) continue;
    // Read and removed under one lock: a stub a tidy gives its aliases meanwhile is not removed with them.
    if (await writeSide(join(vault.tagsDir, entry.name), (existing) => (existing === blank ? null : undefined))) removed += 1;
  }
  return removed;
}

/** A day's hub: its episodes in order, and the neighbouring days that have any. */
export function renderDay(day: string, episodes: readonly IndexedEpisode[], neighbours: { previous?: string; next?: string }): string {
  const lines = [...episodes]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((episode) => `- ${link(episode.id)} · ${episode.agents.join(", ")}${episode.summary ? ` · ${episode.summary}` : ""}`);
  return renderFront(
    {
      type: "day",
      ...(neighbours.previous ? { previous: link(dayPath(neighbours.previous)) } : {}),
      ...(neighbours.next ? { next: link(dayPath(neighbours.next)) } : {}),
    },
    `# ${day}\n\n${lines.join("\n")}\n`,
  );
}
