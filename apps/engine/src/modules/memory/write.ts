/**
 * Every write to the vault — `docs/SPEC.md` §12.
 *
 * The files are the truth and the index follows them, so a write is never only a write. It is made under the file's
 * lock (`commons/file-lock.ts`), so no two writers lose each other's change between a read and a rename; atomically,
 * so a crash leaves the file before or after and never half; with the text it replaces kept where Undo finds it, for
 * the files a person edits (`history.ts`); with the index told at once (`index-sync.ts`), so a search after it finds
 * what it wrote; and, for a fact, with what changed recorded (`changes.ts`), because facts change without asking.
 *
 * Done by hand at each call site, each kept a different part of that. So every writer comes through here:
 *
 * - **an episode** — `writeEpisode` a new one, `changeEpisode` one there is (its archive copy too), `removeEpisode`;
 * - **a profile or `shared.md`** — `editProfile` with fact operations, `rewriteProfile` with anything else (a tidy-up,
 *   a delete's sweep, the dashboard's editor), `undoProfile`, `removeProfile`, `scrubVersions`;
 * - **a file beside them** — `writeSide`: a stub, a day hub, a tag tidy's record, a proposal, the format marker, a
 *   rename's rewrite. Nothing kept and nothing indexed: a sync reads the stubs, and the rest is not searched.
 *
 * Where a new episode's id is chosen is `episodes.ts:creatingEpisodes`; one maintenance job at a time is `index.ts`.
 */

import { readTextFileIfExists, relative, removePath, writeTextFileAtomic } from "@nouride/runtime";
import { withFileLock } from "@/commons/file-lock.ts";
import { changesOf, type ChangeCause, type MemoryChange } from "./changes.ts";
import { parseEpisode, renderEpisode, type Episode } from "./episode.ts";
import { dropVersions, keepVersion, newestVersion, scrubVersions as scrubEach } from "./history.ts";
import { indexEpisode, indexProfile } from "./index-sync.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryStatePort } from "./memory-state.store.ts";
import { applyFacts, factsOf, readProfile, writeProfile, type Fact, type FactOperation, type Provenance } from "./profile.ts";
import { SHARED, subjectFile, type Vault } from "./vault.ts";

/** What writing an episode needs: the vault, and the index it keeps true. */
export interface EpisodeWrites {
  vault: Vault;
  index: MemoryIndexPort;
}

/** What writing a profile needs besides: where a change to a fact is recorded, and the time it is recorded at. */
export interface ProfileWrites extends EpisodeWrites {
  state: Pick<MemoryStatePort, "recordChanges">;
  now: () => number;
}

// ─── episodes ───

/** A new episode, written whole and indexed. Its id is chosen under `creatingEpisodes`, which this does not take. */
export async function writeEpisode(deps: EpisodeWrites, episode: Episode): Promise<void> {
  const file = deps.vault.episode(episode.id);
  await withFileLock(file, async () => {
    await writeTextFileAtomic(file, renderEpisode(episode));
    indexEpisode(deps.vault, deps.index, episode);
  });
}

/**
 * Change an episode under its lock, and index what it then says.
 *
 * `change` gets the episode and its text, and returns the episode as it should be — or the text, for a change to one
 * line that leaves everything else as a person wrote it (a tag tidy) — or null to leave it. Back comes the episode as
 * it now is, or null when there is no such episode. What `change` awaits happens with the file held: the nightly pass
 * writes a conversation's facts inside it, and compaction its archive copy, so a delete either comes first and is seen
 * there, or comes after and takes those with it.
 */
export async function changeEpisode(
  deps: EpisodeWrites,
  id: string,
  change: (episode: Episode, text: string) => Episode | string | null | Promise<Episode | string | null>,
): Promise<Episode | null> {
  const file = deps.vault.episode(id);
  return await withFileLock(file, async () => {
    const text = await readTextFileIfExists(file);
    if (text === null) return null;
    const current = parseEpisode(text, id);
    if ("problem" in current) return null;
    const next = await change(current, text);
    if (next === null) return current;
    // A changed line that no longer reads as an episode is not written: the file stays as it was, and readable.
    const written = typeof next === "string" ? parseEpisode(next, id) : next;
    if ("problem" in written) return current;
    await writeTextFileAtomic(file, typeof next === "string" ? next : renderEpisode(next));
    indexEpisode(deps.vault, deps.index, written);
    return written;
  });
}

/** An episode gone — its file, its archived transcript and its rows — under the lock its writers take. */
export async function removeEpisode(deps: EpisodeWrites, id: string): Promise<void> {
  const file = deps.vault.episode(id);
  await withFileLock(file, async () => {
    removePath(file);
    removePath(deps.vault.archive(id));
    deps.index.dropEpisode(id, relative(deps.vault.root, file));
  });
}

// ─── profiles and shared.md ───

export type ProfileWrite = { status: "written" | "unchanged"; changes: MemoryChange[] } | { status: "refused"; reason: string };

/**
 * A profile or `shared.md`, changed under its lock: `rewrite` gets its text (`""` when there is none yet) and returns
 * the new text with what it changed about the facts, or `{ refused }` to write nothing. The text before is kept as a
 * version, then the file is indexed and the changes recorded. A rewrite that changes nothing writes nothing — no
 * empty version, no mtime moved for the index to read again.
 *
 * `keepVersion: false` is for a change that must not be undone: taking out what a deleted conversation taught. Kept,
 * the text before it was one Undo away from putting those facts back.
 */
export async function rewriteProfile(
  deps: ProfileWrites,
  subject: string,
  rewrite: (existing: string) => { text: string; changes?: readonly MemoryChange[] } | { refused: string },
  options: { keepVersion?: boolean } = {},
): Promise<ProfileWrite> {
  const file = subjectFile(deps.vault, subject);
  return await withFileLock(file, async (): Promise<ProfileWrite> => {
    const existing = (await readTextFileIfExists(file)) ?? "";
    const next = rewrite(existing);
    if ("refused" in next) return { status: "refused", reason: next.refused };
    if (next.text === existing) return { status: "unchanged", changes: [] };
    if (existing && options.keepVersion !== false) await keepVersion(deps.vault, file, existing, deps.now());
    await writeTextFileAtomic(file, next.text);
    await indexProfile(deps.vault, deps.index, subject);
    const changes = [...(next.changes ?? [])];
    deps.state.recordChanges(changes);
    return { status: "written", changes };
  });
}

/** Fact operations, and what they are written as — `editProfile`. */
export interface FactEdit {
  /**
   * The operations, or how to find them in the facts as they are under the lock — a fact named by its words, whose
   * number is known only once the file is read. `{ refused }` writes nothing.
   */
  operations: readonly FactOperation[] | ((facts: readonly Fact[]) => readonly FactOperation[] | { refused: string });
  /** Stamped on every line written: the conversation, and who may read it. */
  provenance?: Provenance;
  cause: ChangeCause;
  /** Kept from a conversation the subject was not in: what someone else said about them. */
  secondhand?: boolean;
  /** How a profile written for the first time names its person. */
  name?: string;
  /** Refuse the lot when one operation does not fit — an approval is one decision. Otherwise it is dropped and counted. */
  whole?: boolean;
}

/**
 * Fact operations on a profile or `shared.md` — what the nightly pass, an agent in a chat and an approved proposal
 * write — through `rewriteProfile`. What each operation did is recorded against the facts as they read before it,
 * so the record is what happened to the file, not what a model said it would do.
 */
export async function editProfile(deps: ProfileWrites, subject: string, edit: FactEdit): Promise<ProfileWrite & { applied: number; rejected: number }> {
  const counted = { applied: 0, rejected: 0 };
  const written = await rewriteProfile(deps, subject, (existing) => {
    const profile = readProfile(existing);
    const facts = factsOf(profile.body);
    const operations = typeof edit.operations === "function" ? edit.operations(facts) : edit.operations;
    if ("refused" in operations) return operations;
    const done = applyFacts(profile.body, operations, edit.provenance);
    if (edit.whole && done.rejected.length) return { refused: done.rejected[0]!.reason };
    counted.applied = done.applied.length;
    counted.rejected = done.rejected.length;
    const front = Object.keys(profile.front).length ? profile.front : subject === SHARED ? { type: "shared" } : { type: "person", ...(edit.name ? { name: edit.name } : {}) };
    const meta = { subject, cause: edit.cause, at: deps.now(), ...(edit.provenance?.source ? { source: edit.provenance.source } : {}), ...(edit.secondhand ? { secondhand: true } : {}) };
    return { text: writeProfile({ front, body: done.body }), changes: changesOf(facts, done.applied, meta) };
  });
  return { ...written, ...counted };
}

/** Put back the version before the last change, and index it. False when there is nothing to go back to. */
export async function undoProfile(deps: EpisodeWrites, subject: string): Promise<boolean> {
  const file = subjectFile(deps.vault, subject);
  return await withFileLock(file, async () => {
    const version = await newestVersion(deps.vault, file);
    if (version) {
      await writeTextFileAtomic(file, version.text);
      version.drop();
    }
    await indexProfile(deps.vault, deps.index, subject);
    return version !== null;
  });
}

/** A profile gone with every earlier version of it, and its facts out of the index — a forgotten person's. */
export async function removeProfile(deps: EpisodeWrites, subject: string): Promise<void> {
  const file = subjectFile(deps.vault, subject);
  await withFileLock(file, async () => {
    removePath(file);
    dropVersions(deps.vault, file);
    deps.index.dropFacts(subject, relative(deps.vault.root, file));
  });
}

/**
 * Every earlier version of `file` — a profile or `shared.md`, there or not — put through `scrub`, under the file's lock.
 * How many changed. For what no version may keep once it is gone from the file: the facts a deleted conversation taught.
 */
export async function scrubVersions(vault: Vault, file: string, scrub: (text: string) => string): Promise<number> {
  return await withFileLock(file, () => scrubEach(vault, file, scrub));
}

// ─── beside them ───

/**
 * A file beside memory's own, changed under its lock: `change` gets its text — null when there is none — and returns
 * what it should say, null to remove it, or undefined to leave it as it is. Whether anything changed.
 */
export async function writeSide(file: string, change: (existing: string | null) => string | null | undefined): Promise<boolean> {
  return await withFileLock(file, async () => {
    const existing = await readTextFileIfExists(file);
    const next = change(existing);
    if (next === undefined || next === existing) return false;
    if (next === null) removePath(file);
    else await writeTextFileAtomic(file, next);
    return true;
  });
}
