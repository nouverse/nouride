/**
 * The operator's hands on memory — what the dashboard and `nouride memory` read and change.
 *
 * Unfiltered by audience, because the operator's terminal and the dashboard are not a chat: an admin
 * reads every conversation and every profile, and what an agent reads inside a chat still goes
 * through `access.ts`. The routes decide who counts as an operator.
 *
 * A document is named by its subject — a person key, or `shared` — never by a path a browser sent,
 * so nothing typed can reach a file outside the vault. Every edit goes through `write.ts`, with
 * the previous version kept, and names the text it started from: a tab left open overnight cannot
 * silently undo what the nightly pass filed.
 */

import { gunzipText, readFileBytes, readTextFileIfExists, relative, statFile } from "@nouride/runtime";
import type { FactsMode, MemorySection, Person } from "@nouride/shared";
import type { Episode } from "./episode.ts";
import { readEpisode } from "./episodes.ts";
import { forgetPerson, type ForgetMode, type ForgetReport } from "./forget.ts";
import { createGraphView, type GraphFilter, type MemoryFacets, type MemoryGraph } from "./graph-view.ts";
import { memoryFileVersions, readMemoryFileVersion } from "./history.ts";
import { syncIndex, type SyncReport } from "./index-sync.ts";
import { deleteEpisodes, refreshDays } from "./maintain.ts";
import type { MemoryAnalyticsPort } from "./memory-analytics.store.ts";
import type { EpisodeFilter } from "./episode-filter.ts";
import type { IndexedEpisode, MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryStatePort } from "./memory-state.store.ts";
import type { MemoryVectorPort } from "./memory-vectors.store.ts";
import { readProfile } from "./profile.ts";
import { approveProposal, denyProposal, listProposals, type Decision, type Proposal } from "./proposals.ts";
import { ftsQuery } from "./terms.ts";
import { isSegment, SHARED, subjectFile, type Vault } from "./vault.ts";
import { rewriteProfile, undoProfile } from "./write.ts";

export interface PersonSummary {
  /** Who they are in `[[people]]`, and the name of their profile. Everyone has one since 0.7.0. */
  key: string;
  name: string;
  facts: number;
  /** Their own `[[people]] facts`, when set; absent follows `[memory] facts`. */
  factsMode?: FactsMode;
  /** Their own `[[people]] recall`, when set; absent follows `[memory] recall`. */
  recall?: boolean;
  updatedAt: number | null;
}

export interface MemoryDocument {
  subject: string;
  path: string;
  exists: boolean;
  content: string;
  versions: string[];
}

export type WriteOutcome = { status: "written" | "unchanged"; document: MemoryDocument } | { refused: string };

export interface ManageDeps {
  vault: Vault;
  index: MemoryIndexPort;
  analytics: Pick<MemoryAnalyticsPort, "tagCounts">;
  state: MemoryStatePort;
  vectors?: MemoryVectorPort;
  config: { memory: MemorySection; people: Person[] };
  now: () => number;
  /** Cut every chat active since its last cut, as the nightly pass does first — `run.ts:cutActive`. */
  cutAll: () => Promise<unknown>;
}

function known(config: ManageDeps["config"], subject: string): boolean {
  return subject === SHARED || config.people.some((person) => person.key === subject);
}

export function createManagement(deps: ManageDeps) {
  const { vault, index, config } = deps;

  async function document(subject: string): Promise<MemoryDocument> {
    const file = subjectFile(vault, subject);
    const content = await readTextFileIfExists(file);
    return { subject, path: relative(vault.root, file), exists: content !== null, content: content ?? "", versions: memoryFileVersions(vault, file) };
  }

  const refuse = (subject: string) => ({ refused: `"${subject}" is not a person with a key, nor "${SHARED}"` });
  const graphView = createGraphView({ index, people: () => config.people });

  /**
   * What memory still keeps under a key — said when somebody new would be given it (`people/entry.ts`).
   * Null when nothing is: no profile, and no conversation with or about them.
   */
  function keyHeld(key: string): string | null {
    if (!isSegment(key)) return null;
    const profile = statFile(vault.person(key)) ? [`a profile, people/${key}.md`] : [];
    const conversations = index.countEpisodes({ people: [key] });
    const held = [...profile, ...(conversations ? [`${conversations} conversation(s) with or about them`] : [])];
    return held.length ? `memory keeps ${held.join(" and ")}` : null;
  }

  /** How the profile of someone no longer in People names them, or their key when it does not. */
  async function removedName(key: string): Promise<string> {
    const name = readProfile((await readTextFileIfExists(vault.person(key))) ?? "").front.name;
    return typeof name === "string" && name.trim() ? name.trim() : key;
  }

  return {
    people(): PersonSummary[] {
      const facts = index.facts(config.people.map((person) => person.key));
      return config.people.map((person) => {
        const stat = statFile(vault.person(person.key));
        return {
          key: person.key,
          name: person.name,
          facts: facts.filter((fact) => fact.subject === person.key).length,
          ...(person.facts ? { factsMode: person.facts } : {}),
          ...(person.recall !== undefined ? { recall: person.recall } : {}),
          updatedAt: stat ? Math.round(stat.mtimeMs) : null,
        };
      });
    },

    async readDocument(subject: string): Promise<MemoryDocument | { refused: string }> {
      return known(config, subject) ? await document(subject) : refuse(subject);
    },

    async readDocumentVersion(subject: string, version: string): Promise<{ content: string } | { refused: string }> {
      if (!known(config, subject)) return refuse(subject);
      const content = await readMemoryFileVersion(vault, subjectFile(vault, subject), version);
      return content === null ? { refused: `no version "${version}"` } : { content };
    },

    /** Write what the operator edited, refused if the file is no longer what the editor opened. */
    async writeDocument(subject: string, content: string, expected: string): Promise<WriteOutcome> {
      if (!known(config, subject)) return refuse(subject);
      const text = content.trim() ? `${content.replace(/\s+$/, "")}\n` : "";
      const result = await rewriteProfile(deps, subject, (existing) =>
        existing === expected ? { text } : { refused: "this changed since it was opened: reload it and edit again" },
      );
      if (result.status === "refused") return { refused: result.reason };
      return { status: result.status, document: await document(subject) };
    },

    async undoDocument(subject: string): Promise<{ restored: boolean } | { refused: string }> {
      if (!known(config, subject)) return refuse(subject);
      return { restored: await undoProfile(deps, subject) };
    },

    /** Episodes for the operator, newest first — by agent, person, tag, day, status, and words. */
    episodes(filter: Omit<EpisodeFilter, "scope" | "ids"> & { query?: string }, limit: number): IndexedEpisode[] {
      const { query, ...rest } = filter;
      const match = ftsQuery(query ?? "");
      if (!match) return index.allEpisodes(rest, limit);
      const ids = index.matching(match).filter((item) => !item.startsWith("fact:"));
      return index.allEpisodes({ ...rest, ids }, limit);
    },

    /** Conversations and what they link to, for the dashboard's graph — `graph-view.ts`. */
    graph(filter: GraphFilter, limit: number): MemoryGraph {
      return graphView.graph(filter, limit);
    },

    /** Every agent, person and tag the graph can be filtered by, with counts. */
    graphFacets(): MemoryFacets {
      return graphView.facets();
    },

    /** One episode as its file says, and its archived transcript when it has been compacted. */
    async episode(id: string): Promise<{ episode: Episode; archived?: string } | null> {
      const episode = await readEpisode(vault, id);
      if (!episode) return null;
      if (episode.status !== "compacted") return { episode };
      try {
        return { episode, archived: gunzipText(await readFileBytes(vault.archive(id))) };
      } catch {
        return { episode };
      }
    },

    async deleteEpisode(id: string): Promise<{ episodes: number; facts: number }> {
      return await deleteEpisodes(deps, [id]);
    },

    proposals: (): Promise<Proposal[]> => listProposals(vault),

    approve: (id: string): Promise<Decision> => approveProposal(deps, id, "approval"),

    deny: (id: string): Promise<Decision> => denyProposal(vault, id),

    /** What changed in memory, newest first — `changes.ts`. */
    changes(filter: { subject?: string; limit: number }) {
      return deps.state.changes(filter);
    },

    /** Episodes the pass has given up on, for a person to read, retry or delete. */
    failed() {
      return deps.state.failed(config.memory.maxAttempts);
    },

    /** Forget the failures, so the next pass tries again. */
    retry(id?: string): void {
      deps.state.clearAttempts(id);
    },

    keyHeld,

    /**
     * Every chat is cut first — deterministic, no model — so what they said since a chat was last cut is an
     * episode the same rules then delete or anonymize. Uncut, it was out of reach here, and that night's
     * pass filed it as a new conversation with them in it, recreating their profile with facts on.
     *
     * Someone already removed from People is forgotten by the key their memory is under, named as their
     * profile names them: removing a person kept their memory, and this was then refused for them.
     */
    async forget(key: string, mode: ForgetMode, rewrite?: (prompt: { system: string; user: string }) => Promise<string | null>): Promise<ForgetReport | { refused: string }> {
      const listed = config.people.find((candidate) => candidate.key === key);
      const name = listed?.name ?? (keyHeld(key) ? await removedName(key) : null);
      if (name === null) return { refused: `no person with key "${key}"` };
      await deps.cutAll();
      return await forgetPerson({ ...deps, ...(rewrite ? { rewrite } : {}) }, { key, name }, mode);
    },

    /**
     * Empty the index and read every file again, then redraw every day hub: a hub lists its episodes'
     * summaries, so a summary edited in its file would otherwise read one way in the hub and another
     * everywhere else.
     */
    async reindex(): Promise<SyncReport> {
      index.clear();
      const report = await syncIndex(vault, index);
      await refreshDays(vault, index, new Set([...index.pages({})].flatMap((page) => page.map((episode) => episode.day))));
      return report;
    },
  };
}

export type Management = ReturnType<typeof createManagement>;
