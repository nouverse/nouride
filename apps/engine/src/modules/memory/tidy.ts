/**
 * Tidying the tags already written — one mechanism with three doors: the dashboard's card, Merge into…
 * on a tag in the graph, and `nouride memory tags`.
 *
 * The gate (`tags.ts`) keeps new tags clean; this repairs what came before it. A plan is computed from
 * the index and never stored: merges by the gate's own rules, the gate's new-tag limit applied to old
 * episodes (trim), and its cap. A person ticks what to apply. Applying rewrites the `tags:` line of each
 * episode it touches and nothing else, the stubs gain the merged names as aliases — so a model writing
 * one tomorrow is folded by the lookup — and one record is written into the vault, which is what undo
 * reads. The files are the truth; the index follows them.
 */

import { join, listDir, readTextFileIfExists, renamePath } from "@nouride/runtime";
import type { EpisodeKind } from "./episode.ts";
import { readEpisode } from "./episodes.ts";
import { frontList, parseFront, renderFront } from "./frontmatter.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import { MAX_TAGS, foldTag, type FoldRule } from "./tags.ts";
import { EPISODE_ID, isSegment, type Vault } from "./vault.ts";
import { changeEpisode, writeSide } from "./write.ts";

/** Why a change is offered: a fold rule, the new-tag limit, the cap, the model when asked, or a person's merge. */
export type TidyWhy = FoldRule | "limit" | "cap" | "model" | "hand";

export interface TidyChange {
  /** Stable across plans of the same vault, so a tick in a preview names the same change when applied. */
  id: string;
  kind: "merge" | "trim" | "cap";
  /** Merged away, or removed. */
  from: string[];
  into?: string;
  /** Episodes it touches. */
  episodes: number;
  why: TidyWhy;
  reason?: string;
}

export interface TidyPlan {
  changes: TidyChange[];
  /** Tags in the vault, and how many of them one episode has. */
  tags: number;
  once: number;
}

export interface Tagged {
  id: string;
  kind: EpisodeKind;
  tags: readonly string[];
}

const count = (episodes: readonly Tagged[]) => {
  const counts = new Map<string, number>();
  for (const episode of episodes) for (const tag of episode.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return counts;
};

/** One round of merges over these counts — the certain rules, or R5 alone — each into a more used tag, chains followed to their end. */
function foldRound(counts: ReadonlyMap<string, number>, qualifiedAt: number, qualified: boolean): Map<string, { into: string; rule: FoldRule }> {
  const n = (tag: string) => counts.get(tag) ?? 0;
  const out = new Map<string, { into: string; rule: FoldRule }>();
  for (const tag of [...counts.keys()].sort((a, b) => n(a) - n(b) || a.localeCompare(b))) {
    // Only into a tag more used than this one: a merge that grows the smaller of two is backwards.
    const more = (known: string) => n(known) > n(tag) || (n(known) === n(tag) && known < tag);
    const fold = foldTag(tag, { inUse: counts, qualifiedAt }, { qualified, accept: more, rules: qualified ? ["R5"] : ["R1", "R2", "R3"] });
    if (fold) out.set(tag, { into: fold.into, rule: fold.rule });
  }
  for (const [tag, merge] of out) {
    let into = merge.into;
    const seen = new Set([tag]);
    while (out.has(into) && !seen.has(into)) {
      seen.add(into);
      into = out.get(into)!.into;
    }
    out.set(tag, { into, rule: merge.rule });
  }
  return out;
}

/**
 * Every merge the rules make, as `from → into`. In two rounds: the certain rules, then R5 over what they
 * leave — so `cron-jobs → cron-job` does not hide that `cron-job` is a narrower `cron`, and an unticked
 * R5 leaves the certain merges pointing where they would on their own. Applied together, a tag follows
 * both (`resolver`).
 */
function merges(episodes: readonly Tagged[], qualifiedAt: number): Map<string, { into: string; rule: FoldRule }> {
  const certain = foldRound(count(episodes), qualifiedAt, false);
  const resolve = resolver(new Map([...certain].map(([tag, merge]) => [tag, merge.into])));
  const after = count(episodes.map((episode) => ({ ...episode, tags: [...new Set(episode.tags.map(resolve))] })));
  return new Map([...certain, ...foldRound(after, qualifiedAt, true)]);
}

/** Where a tag ends up under these merges, following a chain — a plural into its singular, that into a broad tag. */
function resolver(merge: ReadonlyMap<string, string>): (tag: string) => string {
  return (tag) => {
    let into = tag;
    const seen = new Set<string>();
    while (merge.has(into) && !seen.has(into)) {
      seen.add(into);
      into = merge.get(into)!;
    }
    return into;
  };
}

interface Chosen {
  merge: ReadonlyMap<string, string>;
  trim: ReadonlySet<"conversation" | "archive">;
  cap: boolean;
}

/** How many episodes each tag is on once the chosen merges are made — what the trim and the cap judge by. */
function mergedCounts(episodes: readonly Tagged[], merge: ReadonlyMap<string, string>): Map<string, number> {
  const resolve = resolver(merge);
  return count(episodes.map((episode) => ({ ...episode, tags: [...new Set(episode.tags.map(resolve))] })));
}

/**
 * One episode's tags after the chosen changes: merged, then trimmed to the new-tag limit, then capped.
 *
 * In the order given, and the order decides what stays: the one-off a conversation keeps is the first
 * its writer listed, and a tie at the cap goes the same way. The index keeps tags sorted, so a plan
 * reads that order, and apply passes each file's own — which tags change can differ from the preview,
 * how many conversations change cannot.
 */
function retagOne(tags: readonly string[], kind: EpisodeKind, counts: ReadonlyMap<string, number>, chosen: Chosen): string[] {
  let out = [...new Set(tags.map(resolver(chosen.merge)))];
  const which = kind === "archive" ? "archive" : "conversation";
  if (chosen.trim.has(which)) {
    // The gate's limit on an old episode: a conversation keeps one tag nothing else has, an import none.
    const allowed = which === "archive" ? 0 : 1;
    let once = 0;
    const kept = out.filter((tag) => (counts.get(tag) ?? 0) >= 2 || once++ < allowed);
    out = kept.length ? kept : out.slice(0, 1);
  }
  if (chosen.cap && out.length > MAX_TAGS) {
    const keep = new Set([...out].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)).slice(0, MAX_TAGS));
    out = out.filter((tag) => keep.has(tag));
  }
  return out;
}

/** Every episode's tags after one pass of the chosen changes, by id. */
function retagged(episodes: readonly Tagged[], chosen: Chosen): Map<string, string[]> {
  const counts = mergedCounts(episodes, chosen.merge);
  return new Map(episodes.map((episode) => [episode.id, retagOne(episode.tags, episode.kind, counts, chosen)]));
}

const sameTags = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((tag, i) => tag === b[i]);

/**
 * Every episode's tags once the chosen changes have nothing more to do. One pass is not always the end:
 * the cap can take a tag off one episode and leave it on just one other, where the trim then takes it.
 * So a tidy applied is a tidy finished — the card does not offer more straight after. Tags are only
 * ever removed, so it settles in a few passes.
 */
function settled(episodes: readonly Tagged[], chosen: Chosen): Map<string, string[]> {
  let current: readonly Tagged[] = episodes;
  for (let round = 0; round < 8; round += 1) {
    const next = retagged(current, chosen);
    const moved = current.some((episode) => !sameTags(next.get(episode.id)!, episode.tags));
    current = current.map((episode) => ({ ...episode, tags: next.get(episode.id)! }));
    if (!moved) break;
  }
  return new Map(current.map((episode) => [episode.id, [...episode.tags]]));
}

/** What can be tidied, by the rules, against the whole vault. */
export function planTidy(episodes: readonly Tagged[], qualifiedAt: number): TidyPlan {
  const counts = count(episodes);
  const byMerge = merges(episodes, qualifiedAt);
  const changes: TidyChange[] = [];
  const groups = new Map<string, { into: string; rule: FoldRule; from: string[] }>();
  for (const [tag, merge] of byMerge) {
    const key = `${merge.rule}:${merge.into}`;
    const group = groups.get(key) ?? { into: merge.into, rule: merge.rule, from: [] };
    group.from.push(tag);
    groups.set(key, group);
  }
  for (const [key, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const from = group.from.sort();
    changes.push({ id: `merge:${key}`, kind: "merge", from, into: group.into, episodes: episodes.filter((e) => e.tags.some((tag) => from.includes(tag))).length, why: group.rule });
  }

  // Each trim and the cap is offered for what it does on its own after the merges — and, where that is
  // nothing, for what the whole tidy needs it for: a tag the cap leaves on one episode is a trim's only
  // once the cap has run, and a tidy applied should be a tidy finished.
  const merge = new Map([...byMerge].map(([tag, m]) => [tag, m.into]));
  const none = new Set<"conversation" | "archive">();
  const both = new Set(["conversation", "archive"] as const);
  const merged = settled(episodes, { merge, trim: none, cap: false });
  const full = settled(episodes, { merge, trim: both, cap: true });
  const removedBy = (after: Map<string, string[]>, before: Map<string, string[]>) => {
    const removed = new Set<string>();
    let touched = 0;
    for (const [id, tags] of after) {
      const was = before.get(id)!;
      if (sameTags(tags, was)) continue;
      touched += 1;
      for (const tag of was) if (!tags.includes(tag)) removed.add(tag);
    }
    return { removed, touched };
  };
  const offer = (alone: ReturnType<typeof removedBy>, needed: ReturnType<typeof removedBy>, change: Omit<TidyChange, "from" | "episodes">) => {
    const shown = alone.touched ? alone : needed;
    if (shown.touched) changes.push({ ...change, from: [...shown.removed].sort(), episodes: shown.touched });
  };
  for (const kind of ["conversation", "archive"] as const) {
    const others = new Set([...both].filter((other) => other !== kind));
    offer(removedBy(settled(episodes, { merge, trim: new Set([kind]), cap: false }), merged), removedBy(full, settled(episodes, { merge, trim: others, cap: true })), { id: `trim:${kind}`, kind: "trim", why: "limit" });
  }
  offer(removedBy(settled(episodes, { merge, trim: none, cap: true }), merged), removedBy(full, settled(episodes, { merge, trim: both, cap: false })), { id: "cap", kind: "cap", why: "cap" });
  return { changes, tags: counts.size, once: [...counts.values()].filter((n) => n === 1).length };
}

/** The episode text with its one-line `tags:` saying these tags, nothing else touched — null when it has none. */
export function retag(text: string, tags: readonly string[]): string | null {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
  if (end === -1) return null;
  const front = text.slice(0, end);
  const line = /^tags:[ \t]*\[.*\][ \t]*$/m;
  if (!line.test(front)) return null;
  return `${front.replace(line, `tags: [${tags.map((tag) => JSON.stringify(`[[tags/${tag}]]`)).join(", ")}]`)}${text.slice(end)}`;
}

/** What one apply did — the record's body, and what undo needs. */
export interface TidyRecord {
  at: string;
  actor: string;
  changes: TidyChange[];
  episodes: Record<string, { before: string[]; after: string[] }>;
  /**
   * Each stub touched, by its tag, as it read before (null: it did not exist). By name, not path: the record is a
   * note in a vault that is synced, moved and restored, and undo writes what it names.
   */
  stubs: Record<string, string | null>;
}

export interface TidyDeps {
  vault: Vault;
  index: MemoryIndexPort;
  now: () => number;
}

const RECORDS = "_tidy";

function recordsDir(vault: Vault): string {
  return join(vault.tagsDir, RECORDS);
}

/** A stub with these names added as aliases, merged chains flattened into one list. */
function withAliases(stub: string | null, names: readonly string[]): string {
  const parsed = stub ? parseFront(stub) : null;
  const front = parsed?.front ?? { type: "tag" };
  const aliases = [...new Set([...frontList(front, "aliases"), ...names])].sort();
  return renderFront({ ...front, aliases }, parsed?.body ?? "Other spellings listed under `aliases` are read as this tag.\n");
}

/**
 * Apply the chosen changes, re-validated against the vault as it is now: rewrite each touched episode's
 * `tags:`, give the merge targets their aliases and remove the merged stubs — the record written before
 * any of it and finished after. Returns the record, or a refusal when nothing chosen still applies.
 */
export async function applyTidy(deps: TidyDeps, episodes: readonly Tagged[], chosen: readonly TidyChange[], actor: string): Promise<TidyRecord | { refused: string }> {
  const inUse = new Set(episodes.flatMap((episode) => episode.tags));
  const valid = chosen.filter((change) => change.from.length > 0 && (change.kind !== "merge" || (change.into && !change.from.includes(change.into) && change.from.some((tag) => inUse.has(tag)))));
  if (valid.length === 0) return { refused: "nothing chosen applies to the tags as they are now" };
  const seen = new Set<string>();
  for (const change of valid.filter((c) => c.kind === "merge")) {
    for (const tag of change.from) {
      if (seen.has(tag)) return { refused: `"${tag}" is in two merges` };
      seen.add(tag);
    }
  }

  const merge = new Map(valid.filter((c) => c.kind === "merge").flatMap((c) => c.from.map((tag) => [tag, c.into!] as const)));
  const trim = new Set(valid.filter((c) => c.kind === "trim").map((c) => (c.id === "trim:archive" ? "archive" : "conversation") as "archive" | "conversation"));
  const chosenNow: Chosen = { merge, trim, cap: valid.some((c) => c.kind === "cap") };
  // In each file's own order — the index keeps tags sorted — so what a person wrote first stays first,
  // and the one-off a trim keeps is the first its writer listed.
  const ordered: Tagged[] = [];
  for (const episode of episodes) ordered.push({ ...episode, tags: (await readEpisode(deps.vault, episode.id))?.tags ?? episode.tags });
  const next = settled(ordered, chosenNow);

  /**
   * The record first, saying what this tidy is about to do — each episode's tags before and after, each stub as
   * it read before anything here touched it — and marked `applying`; written again with what was done once it
   * is done. Written last, a tidy cut short (a restart, a full disk) left episodes retagged with no record of
   * it, and Undo put back the tidy before it instead. An episode the record names but the tidy never reached
   * still reads as it did, and undo leaves it, as it leaves any episode changed since.
   */
  const record: TidyRecord = { at: new Date(deps.now()).toISOString(), actor, changes: valid, episodes: {}, stubs: {} };
  const planned: TidyRecord["episodes"] = {};
  for (const episode of ordered) {
    const tags = next.get(episode.id)!;
    if (!sameTags(tags, episode.tags)) planned[episode.id] = { before: [...episode.tags], after: tags };
  }
  for (const change of valid.filter((c) => c.kind === "merge")) {
    for (const tag of [...change.from, change.into!]) {
      if (!(tag in record.stubs)) record.stubs[tag] = await readTextFileIfExists(deps.vault.tag(tag));
    }
  }
  // A merged-away tag that had no stub leaves undo nothing to put back. A target that had none is kept as
  // null, so undo removes the stub this tidy writes for it.
  for (const change of valid.filter((c) => c.kind === "merge")) for (const tag of change.from) if (record.stubs[tag] === null) delete record.stubs[tag];
  const recordFile = join(recordsDir(deps.vault), `${record.at.replace(/[:.]/g, "-")}.md`);
  await writeSide(recordFile, () => renderRecord({ ...record, episodes: planned }, "applying"));

  for (const episode of ordered) {
    const tags = next.get(episode.id)!;
    if (sameTags(tags, episode.tags)) continue;
    let written: { before: string[]; after: string[] } | null = null;
    // One line rewritten, the rest of the file as it is — or left alone, changed since it was read a moment ago.
    await changeEpisode(deps, episode.id, (current, text) => {
      const retold = sameTags(current.tags, episode.tags) ? retag(text, tags) : null;
      if (retold !== null) written = { before: current.tags, after: tags };
      return retold;
    });
    if (written) record.episodes[episode.id] = written;
  }

  for (const change of valid.filter((c) => c.kind === "merge")) {
    // A merged stub's own aliases come along, so a chain ends in one lookup.
    const inherited: string[] = [];
    for (const tag of change.from) {
      await writeSide(deps.vault.tag(tag), (stub) => {
        if (stub === null) return undefined;
        inherited.push(...frontList(parseFront(stub)?.front ?? {}, "aliases"));
        return null;
      });
    }
    await writeSide(deps.vault.tag(change.into!), (before) => withAliases(before, [...change.from, ...inherited]));
  }

  await writeSide(recordFile, () => renderRecord(record, "applied"));
  return record;
}

/** The record as a note anyone can read in Obsidian, with what undo needs in a block at the end. `applying` until the tidy is done. */
function renderRecord(record: TidyRecord, status: "applying" | "applied"): string {
  const lines = record.changes.map((change) =>
    change.kind === "merge"
      ? `- merge ${change.from.join(", ")} → ${change.into} (${change.why})`
      : `- ${change.kind} ${change.from.length} tag(s) on ${change.episodes} conversation(s) (${change.why})`,
  );
  const touched = Object.entries(record.episodes).map(([id, { before, after }]) => `- ${id}: [${before.join(", ")}] → [${after.join(", ")}]`);
  const body = `## Changes\n${lines.join("\n")}\n\n## Episodes\n${touched.join("\n")}\n\n## Undo\n\`\`\`json\n${JSON.stringify({ episodes: record.episodes, stubs: record.stubs })}\n\`\`\`\n`;
  return renderFront({ type: "tag-tidy", at: record.at, actor: record.actor, status, changes: record.changes.length, episodes: Object.keys(record.episodes).length }, body);
}

/** The newest tidy that has not been undone, if any. */
export async function lastTidy(vault: Vault): Promise<{ file: string; at: string; changes: number; episodes: number } | null> {
  const names = listDir(recordsDir(vault)).filter((entry) => !entry.isDirectory && entry.name.endsWith(".md") && !entry.name.endsWith(".undone.md")).map((entry) => entry.name).sort();
  const name = names.at(-1);
  if (!name) return null;
  const file = join(recordsDir(vault), name);
  const front = parseFront((await readTextFileIfExists(file)) ?? "")?.front ?? {};
  return { file, at: String(front.at ?? ""), changes: Number(front.changes ?? 0), episodes: Number(front.episodes ?? 0) };
}

/**
 * Put the newest tidy back: each episode's tags as they were — only where they still read as the tidy
 * left them; one changed since is left, and named — and each stub as it was. The record is kept,
 * renamed `.undone.md`, so the vault still shows it happened.
 */
export async function undoTidy(deps: TidyDeps): Promise<{ restored: number; skipped: string[] } | { refused: string }> {
  const last = await lastTidy(deps.vault);
  if (!last) return { refused: "no tidy to undo" };
  const data = undoBlock((await readTextFileIfExists(last.file)) ?? "");
  if (!data) return { refused: `the record ${last.file} cannot be read` };
  let restored = 0;
  const skipped: string[] = [];
  for (const [id, { before, after }] of Object.entries(data.episodes)) {
    let done = false;
    await changeEpisode(deps, id, (current, text) => {
      const retold = current.tags.join(" ") === after.join(" ") ? retag(text, before) : null;
      done = retold !== null;
      return retold;
    });
    if (done) restored += 1;
    else skipped.push(id);
  }
  for (const [tag, stub] of Object.entries(data.stubs)) await writeSide(deps.vault.tag(tag), () => stub);
  renamePath(last.file, last.file.replace(/\.md$/, ".undone.md"));
  return { restored, skipped };
}

/**
 * A record's undo block, checked whole before undo writes anything: each episode an id with its two tag lists, each
 * stub a tag — a name `tags/` can hold. Anything else is refused rather than followed — the record is a note in a vault
 * that is synced and edited by hand, and undo writes and removes what it names. A record from before 0.7.7 keyed its
 * stubs by absolute path; every 0.7.x rekeyed it by tag at boot, so one still keyed that way is not read.
 */
export function undoBlock(text: string): Pick<TidyRecord, "episodes" | "stubs"> | null {
  let data: unknown;
  try {
    data = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "");
  } catch {
    return null;
  }
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const tags = (value: unknown): value is string[] => Array.isArray(value) && value.every((tag) => typeof tag === "string");
  if (!object(data) || !object(data.episodes) || !object(data.stubs)) return null;
  const out: Pick<TidyRecord, "episodes" | "stubs"> = { episodes: {}, stubs: {} };
  for (const [id, change] of Object.entries(data.episodes)) {
    if (!EPISODE_ID.test(id) || !object(change) || !tags(change.before) || !tags(change.after)) return null;
    out.episodes[id] = { before: change.before, after: change.after };
  }
  for (const [tag, stub] of Object.entries(data.stubs)) {
    if (!isSegment(tag) || (stub !== null && typeof stub !== "string")) return null;
    out.stubs[tag] = stub;
  }
  return out;
}

