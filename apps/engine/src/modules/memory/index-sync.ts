/**
 * Keeping the index true to the vault — `docs/SPEC.md` §12.3.
 *
 * The files are the truth. A file is re-read when its mtime or size moved since it was indexed, and a
 * row whose file is gone is dropped, so an edit in Obsidian or a sync tool is found on the next sync.
 * A full sync runs at boot and before each nightly pass; everything memory writes itself is indexed
 * the moment it is written (`indexEpisode`, `indexProfile`), so search never waits on a scan.
 */

import { join, listDir, readTextFileIfExists, relative, statFile } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { isoWeek } from "@/commons/clock.ts";
import { parseEpisode, type Episode } from "./episode.ts";
import { episodeFiles } from "./episodes.ts";
import { frontList, frontText, parseFront, unlink } from "./frontmatter.ts";
import type { FileState, IndexedEpisode, MemoryIndexPort } from "./memory-index.store.ts";
import { factsOf, readProfile } from "./profile.ts";
import { normalizeTag } from "./tags.ts";
import { ftsDoc, type FtsDoc } from "./terms.ts";
import { SHARED, subjectFile, type Vault } from "./vault.ts";

const log = createLogger("memory.index");

/**
 * FNV-1a — a fact's id from its text, so a vector follows the fact and not its line number; and the
 * text a vector was made from, so a changed summary is embedded again.
 */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function factId(subject: string, text: string): string {
  return `fact:${subject}:${textHash(text.toLowerCase())}`;
}

function stateOf(file: string): FileState | null {
  const stat = statFile(file);
  return stat && !stat.isDirectory ? { mtimeMs: Math.round(stat.mtimeMs), size: stat.size } : null;
}

function same(known: FileState | undefined, state: FileState): boolean {
  return known !== undefined && known.mtimeMs === state.mtimeMs && known.size === state.size;
}

/** What an episode is searched by: its summary (weighted double — it is what the episode is about), tags, and the transcript while kept. */
function episodeDoc(episode: Episode): FtsDoc {
  return ftsDoc({ summary: episode.summary ?? "", tags: episode.tags.join(" "), body: episode.transcript });
}

/** Characters of the first message a preview keeps. */
const PREVIEW_CHARS = 160;

/**
 * The first thing a person said: the first block of the transcript (`HH:MM · Name`, then the text)
 * whose speaker is not one of the episode's agents, flattened to one line.
 */
function previewOf(episode: Episode): string | undefined {
  const agents = new Set(episode.agents.map((agent) => agent.toLowerCase()));
  const blocks = episode.transcript.split(/\n{2,}/).map((block) => {
    const [header = "", ...lines] = block.split("\n");
    return { speaker: header.split(" · ")[1]?.trim().toLowerCase() ?? "", text: lines.join(" ").replace(/\s+/g, " ").trim() };
  });
  const first = blocks.find((block) => block.text && !agents.has(block.speaker)) ?? blocks.find((block) => block.text);
  if (!first) return undefined;
  return first.text.length > PREVIEW_CHARS ? `${first.text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : first.text;
}

export function indexedEpisode(episode: Episode): IndexedEpisode {
  const startedAt = Date.parse(episode.started);
  const endedAt = Date.parse(episode.ended);
  const preview = previewOf(episode);
  return {
    id: episode.id,
    status: episode.status,
    kind: episode.kind,
    chat: episode.chat,
    day: episode.day,
    week: isoWeek(episode.day),
    month: episode.day.slice(0, 7),
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.parse(`${episode.day}T00:00:00Z`),
    endedAt: Number.isFinite(endedAt) ? endedAt : Number.isFinite(startedAt) ? startedAt : Date.parse(`${episode.day}T00:00:00Z`),
    ...(episode.importance !== undefined ? { importance: episode.importance } : {}),
    ...(episode.summary ? { summary: episode.summary } : {}),
    ...(preview ? { preview } : {}),
    agents: episode.agents,
    participants: episode.people,
    mentions: episode.mentions,
    tags: episode.tags,
    related: episode.related,
    ...(episode.documents?.length ? { documents: episode.documents } : {}),
  };
}

/** Index one episode as it is on disk now. */
export function indexEpisode(vault: Vault, index: MemoryIndexPort, episode: Episode): void {
  const file = vault.episode(episode.id);
  const state = stateOf(file);
  if (!state) return;
  index.putEpisode(indexedEpisode(episode), episodeDoc(episode), { path: relative(vault.root, file), state });
}

/** Index one profile, or `shared.md` when `subject` is `SHARED`, as it is on disk now. */
export async function indexProfile(vault: Vault, index: MemoryIndexPort, subject: string): Promise<void> {
  const file = subjectFile(vault, subject);
  const path = relative(vault.root, file);
  const state = stateOf(file);
  if (!state) {
    index.dropFacts(subject, path);
    return;
  }
  const text = (await readTextFileIfExists(file)) ?? "";
  const facts = factsOf(readProfile(text).body).map((fact) => ({
    id: factId(subject, fact.text),
    subject,
    section: fact.section,
    text: fact.text,
    ...(fact.source ? { source: fact.source } : {}),
    ...(fact.readers ? { readers: fact.readers } : {}),
    doc: ftsDoc({ body: `${fact.section} ${fact.text}` }),
  }));
  index.putFacts(subject, facts, { path, state });
}

export interface SyncReport {
  episodes: number;
  profiles: number;
  dropped: number;
  /** Files that exist and could not be read as what they claim to be. */
  problems: { file: string; problem: string }[];
}

/** Re-read every changed file, drop rows of files that are gone, and refresh the tag and group stubs. */
export async function syncIndex(vault: Vault, index: MemoryIndexPort): Promise<SyncReport> {
  const report: SyncReport = { episodes: 0, profiles: 0, dropped: 0, problems: [] };

  // What each file was indexed at, in one read: a statement per file was a query for every file in the
  // vault on every sync — at boot, before each pass, after each tidy (M10).
  const known = index.indexedFiles("episodes/");
  const present = new Set<string>();
  for (const { id, file } of episodeFiles(vault)) {
    const path = relative(vault.root, file);
    present.add(path);
    const state = stateOf(file);
    if (!state || same(known.get(path), state)) continue;
    const parsed = parseEpisode((await readTextFileIfExists(file)) ?? "", id);
    if ("problem" in parsed) {
      report.problems.push({ file: path, problem: parsed.problem });
      // What the file said before it broke is not what it says now: the row goes, and with no file state
      // kept the next sync reads it again — and says so again, until it is fixed.
      if (known.has(path)) index.dropEpisode(id, path);
      continue;
    }
    indexEpisode(vault, index, parsed);
    report.episodes += 1;
  }
  for (const path of known.keys()) {
    if (present.has(path)) continue;
    index.dropEpisode(path.slice(path.lastIndexOf("/") + 1, -3), path);
    report.dropped += 1;
  }

  const subjects = new Map<string, string>([[SHARED, relative(vault.root, vault.shared)]]);
  for (const entry of listDir(vault.peopleDir)) {
    const key = entry.name.replace(/\.md$/, "");
    if (!entry.isDirectory && entry.name.endsWith(".md") && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) subjects.set(key, `people/${entry.name}`);
  }
  const profiles = new Map([...index.indexedFiles("people/"), ...index.indexedFiles(relative(vault.root, vault.shared))]);
  for (const [subject, path] of subjects) {
    const state = stateOf(join(vault.root, path));
    if (state && same(profiles.get(path), state)) continue;
    if (!state && !profiles.has(path)) continue;
    await indexProfile(vault, index, subject);
    report.profiles += 1;
  }
  for (const subject of index.subjects()) {
    if (subjects.has(subject)) continue;
    index.dropFacts(subject, `people/${subject}.md`);
    report.dropped += 1;
  }

  await syncStubs(vault, index);
  if (report.problems.length) log.warn("memory files that could not be read", { files: report.problems.slice(0, 10) });
  return report;
}

/** A stub folder's files as they are now, by their path in the vault. */
function stubStates(vault: Vault, dir: string): Map<string, FileState> {
  const states = new Map<string, FileState>();
  for (const entry of listDir(dir)) {
    if (entry.isDirectory || !entry.name.endsWith(".md")) continue;
    const state = stateOf(join(dir, entry.name));
    if (state) states.set(relative(vault.root, join(dir, entry.name)), state);
  }
  return states;
}

/** Whether a folder's files are the ones recorded, each as it was. */
function unchangedFolder(now: ReadonlyMap<string, FileState>, recorded: ReadonlyMap<string, FileState>): boolean {
  return now.size === recorded.size && [...now].every(([path, state]) => same(recorded.get(path), state));
}

/**
 * Tag aliases and which chat each group stub names. A folder is read again only when a stub in it was
 * added, removed or changed since the last read; it was read whole on every sync (M10).
 */
async function syncStubs(vault: Vault, index: MemoryIndexPort): Promise<void> {
  const tagFiles = stubStates(vault, vault.tagsDir);
  if (!unchangedFolder(tagFiles, index.indexedFiles("tags/"))) {
    const aliases = new Map<string, string>();
    for (const path of tagFiles.keys()) {
      const tag = path.slice(path.lastIndexOf("/") + 1, -3);
      const front = parseFront((await readTextFileIfExists(join(vault.root, path))) ?? "")?.front ?? {};
      for (const alias of frontList(front, "aliases")) {
        const normal = normalizeTag(unlink(alias), new Map());
        if (normal && normal !== tag) aliases.set(normal, tag);
      }
    }
    index.replaceAliases(aliases, tagFiles);
  }

  const groupFiles = stubStates(vault, vault.groupsDir);
  if (!unchangedFolder(groupFiles, index.indexedFiles("groups/"))) {
    const groups = new Map<string, string>();
    for (const path of groupFiles.keys()) {
      const chat = frontText(parseFront((await readTextFileIfExists(join(vault.root, path))) ?? "")?.front ?? {}, "chat");
      if (chat) groups.set(chat, path.slice(path.lastIndexOf("/") + 1, -3));
    }
    index.replaceGroups(groups, groupFiles);
  }
}
