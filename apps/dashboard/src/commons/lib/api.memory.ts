/**
 * The Memory menu's calls (what memory does: `docs/SPEC.md` §12).
 *
 * Split out of `api.ts`, which is over its line budget, and spread into `api` like the others. The
 * types are the engine's, duplicated rather than imported: the dashboard is its own build.
 */

import { control, post, request } from "./api.client";

/** What the nightly pass may do to a profile. */
export type FactsMode = "auto" | "ask" | "off";

export interface MemorySettings {
  pass: boolean;
  passAt: string;
  passPerNight: number;
  /** Tokens the pass may use in one night, every agent's together; 0 sets no limit of its own. */
  passMaxTokens: number;
  passProvider: string;
  passModel: string;
  maxAttempts: number;
  facts: FactsMode;
  /** Whether the nightly pass proposes shared knowledge. Each proposal still waits for a person. */
  proposeShared: boolean;
  promptRecent: number;
  /** Whether what is remembered goes into each prompt. A person's own `recall` wins. */
  recall: boolean;
  transcriptDays: number;
  archive: boolean;
  semantic: { enabled: boolean; provider: string; model: string; dimensions: number };
  /**
   * `[llm.context] summary_model`, read-only: a config value, never saved from here. Set, long conversations are
   * summarized with it rather than the pass's model; empty when unset. Absent from a daemon before 0.7.26.
   */
  summaryModel?: string;
}

/**
 * One kind of trouble with the helper model's work, from `/status` (`helpers`): the newest line of it, and how many in
 * the last 24 h. The same list `nouride doctor` reads (`modules/llm/helper-trouble.ts` on the daemon).
 */
export interface HelperTrouble {
  /** `compaction` and `memory pass` failed; `fallback` is a helper model each agent's own model stood in for. */
  job: "compaction" | "memory pass" | "fallback";
  /** Times in the last 24 h — for a fallback, hours: it is said once an hour. */
  count: number;
  /** The model the last one was asked of, `profile/model` where the line names the profile. */
  model: string;
  /** The last one's error, shortened: the provider's own words. */
  last: string;
  at: number;
}

export type SettingsPatch = Partial<Omit<MemorySettings, "semantic" | "summaryModel">> & { semantic?: Partial<MemorySettings["semantic"]> };

export interface PersonSummary {
  key: string;
  name: string;
  facts: number;
  /** Their own setting, when it overrides `facts` in the memory settings. */
  factsMode?: FactsMode;
  /** Their own setting, when it overrides `recall` in the memory settings. */
  recall?: boolean;
  updatedAt: number | null;
}

/** A profile, or `shared.md` when `subject` is `shared`. */
export interface MemoryDocument {
  subject: string;
  path: string;
  exists: boolean;
  content: string;
  /** Earlier versions, newest first. */
  versions: string[];
}

export type EpisodeStatus = "raw" | "summarized" | "compacted";

export interface EpisodeSummary {
  id: string;
  status: EpisodeStatus;
  kind: "dm" | "group" | "archive";
  chat: string;
  day: string;
  startedAt: number;
  endedAt: number;
  importance?: number;
  summary?: string;
  /** The first thing a person said, a line long; shown until there is a summary. */
  preview?: string;
  agents: string[];
  participants: string[];
  mentions: string[];
  tags: string[];
  related: string[];
}

export interface Episode {
  id: string;
  status: EpisodeStatus;
  kind: "dm" | "group" | "archive";
  chat: string;
  started: string;
  ended: string;
  day: string;
  agents: string[];
  people: string[];
  mentions: string[];
  group?: string;
  tags: string[];
  importance?: number;
  related: string[];
  summary?: string;
  transcript: string;
}

export interface EpisodeFilter {
  q?: string;
  agent?: string;
  person?: string;
  tag?: string;
  since?: string;
  until?: string;
  status?: EpisodeStatus;
  limit?: number;
}

/** `collection` and `document` are the knowledge layer's (0.8.20), there when it was asked for. */
export type GraphNodeKind = "episode" | "person" | "tag" | "agent" | "collection" | "document";

/**
 * One node of the memory graph — ids are prefixed by kind: `e:`, `p:`, `t:`, `a:`, and the knowledge layer's `c:` and
 * `d:<collection>/<path>`, a collection's id holding no `/`.
 */
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  degree: number;
  day?: string;
  importance?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  /**
   * The knowledge layer's: a document in its `collection`, a `link` between two, one `about` a person, two `similar` in
   * meaning, a conversation that `opened` a document, and a document's `tag` (0.8.23).
   */
  kind: "agent" | "participant" | "mention" | "tag" | "related" | "collection" | "link" | "about" | "similar" | "opened";
}

export interface MemoryGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Conversations shown, and how many the filter matched. */
  episodes: number;
  total: number;
  /** With the knowledge layer: documents shown, how many could be, and whether lines by meaning could be drawn. */
  knowledge?: { documents: number; total: number; byMeaning: boolean };
}

/** Several of one kind match any of them; different kinds must all match. */
export interface GraphFilter {
  agents?: string[];
  people?: string[];
  tags?: string[];
  since?: string;
  limit?: number;
  /** The knowledge base's collections and documents laid over the conversations (0.8.20). */
  knowledge?: boolean;
}

export interface Facet {
  value: string;
  count: number;
}

/** What the graph can be filtered by, across the whole vault, with how many conversations have each. */
export interface MemoryFacets {
  agents: Facet[];
  people: (Facet & { label: string })[];
  tags: Facet[];
}

export type FactOperation = { op: "add"; section: string; text: string } | { op: "update"; n: number; text: string } | { op: "remove"; n: number };

export interface Proposal {
  id: string;
  createdAt: number;
  /** When a later conversation revised it; `episode` is then that conversation. */
  revisedAt?: number;
  episode: string;
  subject: string;
  operation: FactOperation;
  current?: string;
  why: "shared" | "review";
}

export interface PassReport {
  cut: number;
  filed: number;
  failed: { episode: string; reason: string }[];
  /** What the run passed over and went on without: a file it could not read, a chat or a day hub it could not write. Absent in runs from before 0.7.9. */
  problems?: { what: string; problem: string }[];
  applied: number;
  proposed: number;
  dropped: number;
  /** Profiles tidied because they outgrew what is shown of them. */
  tidied: number;
  compacted: number;
  /** Transcripts given back from the archive while they are kept forever. Absent in runs from before. */
  restored?: number;
  waiting: number;
  stopped?: string;
  /** What the pass's own calls used, in tokens; `estimated` when a provider reported none. Absent before 0.7.12. */
  spent?: { tokens: number; estimated: boolean };
  /** What the tag gate did that night. Absent in runs from before 0.7. */
  tags?: { reused: number; folded: number; created: number; dropped: number; stubsRemoved: number };
  /** Each tag the night coined, with the known tag the model judged nearest — the morning review. */
  newTags?: { tag: string; episode: string; closest?: string }[];
}

/** One change a tag tidy can make — `modules/memory/tidy.ts` on the daemon. */
export interface TagTidyChange {
  id: string;
  kind: "merge" | "trim" | "cap";
  from: string[];
  into?: string;
  episodes: number;
  why: string;
  reason?: string;
}

export interface TagTidyPlan {
  changes: TagTidyChange[];
  tags: number;
  once: number;
  last: { at: string; changes: number; episodes: number } | null;
}

/**
 * Whether the nightly pass keeps up — `modules/memory/backlog.ts` on the daemon. `perDay` is each agent's conversations a
 * day, averaged over `days`; `enough` the conversations per night that would file what waits within a week, or null when
 * the count set already does.
 */
export interface PassBacklog {
  waiting: number;
  oldest: string | null;
  perNight: number;
  days: number;
  agents: { agent: string; waiting: number; perDay: number }[];
  behind: string[];
  enough: number | null;
}

export interface MemoryStatus {
  pass: {
    enabled: boolean;
    at: string;
    timeZone: string;
    running: boolean;
    /** When the run going on now started. Absent from daemons before 0.7.27. */
    runningSince?: number;
    lastDay: string | null;
    /** `startedAt` and `scheduled` (the night's, not one run by hand) are absent from daemons before 0.7.27. */
    lastRun: (Omit<PassReport, "failed"> & { failed: number; finishedAt: number; startedAt?: number; scheduled?: boolean }) | null;
    /** The next scheduled run; `due` once its time has passed and it waits for running turns. Absent before 0.7.27. */
    next?: { at: number; due: boolean } | null;
  } | null;
  waiting: number;
  /** Absent from daemons before 0.7.12. */
  backlog?: PassBacklog;
  failed: number;
  /**
   * `ranking`, while another model's vectors rank searches: the model before a change, until the one in use has as
   * many. Absent from daemons before 0.7.12.
   */
  semantic: { enabled: boolean; model: string | null; items: number; running: boolean; reachable: boolean | null; ranking?: { model: string; items: number } };
  /** Transcripts kept compressed under `archive/`. */
  archive: { files: number; bytes: number };
  /** FTS5's own check of the keyword index. Absent from daemons before 0.7. */
  index?: { ok: boolean; detail: string };
}

export type ChangeKind = "added" | "updated" | "removed" | "merged";
export type ChangeCause = "pass" | "consolidation" | "agent" | "approval";

/** One thing memory changed, and why. */
export interface MemoryChange {
  at: number;
  /** A person key, or `shared`. */
  subject: string;
  change: ChangeKind;
  text: string;
  /** An update's old text; a merge's facts, one per line. */
  previous?: string;
  source?: string;
  cause: ChangeCause;
  /** Kept from a conversation its subject was not in: what someone else said about them. */
  secondhand?: true;
}

export interface FailedEpisode {
  episodeId: string;
  attempts: number;
  lastError: string | null;
}

export interface ForgetReport {
  episodesDeleted: number;
  factsRemoved: number;
  summariesRewritten: number;
  summariesAnonymized: number;
  flagged: string[];
  /** Conversations whose archived transcript could not be read, and so still names them. Absent before 0.7.9. */
  unreadable?: string[];
  proposals: number;
}

export interface AgentNotes {
  id: string;
  name: string;
  bytes: number;
  updatedAt: number | null;
}

const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const q = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();

const subject = (key: string) => `${control}/memory/documents/${encodeURIComponent(key)}`;

export const memoryApi = {
  memorySettings: () => request<MemorySettings>(`${control}/memory/settings`),
  setMemorySettings: (patch: SettingsPatch) => put<MemorySettings>(`${control}/memory/settings`, patch),
  memoryStatus: () => request<MemoryStatus>(`${control}/memory/status`),

  memoryPeople: () => request<{ people: PersonSummary[] }>(`${control}/memory/people`),
  /** `null` follows the memory settings again. */
  setPersonFacts: (key: string, facts: FactsMode | null) => put<{ ok: true }>(`${control}/memory/people/${encodeURIComponent(key)}/facts`, { facts }),
  setPersonRecall: (key: string, recall: boolean | null) => put<{ ok: true }>(`${control}/memory/people/${encodeURIComponent(key)}/recall`, { recall }),
  memoryDocument: (key: string) => request<MemoryDocument>(subject(key)),
  memoryDocumentVersion: (key: string, version: string) => request<{ content: string }>(`${subject(key)}/versions/${encodeURIComponent(version)}`),
  writeMemoryDocument: (key: string, content: string, expected: string) =>
    put<{ status: "written" | "unchanged"; document: MemoryDocument }>(subject(key), { content, expected }),
  undoMemoryDocument: (key: string) => post<{ restored: boolean }>(`${subject(key)}/undo`, {}),
  /** One model call per summary that names them, in `forget` mode — well past the client's usual 15 s. */
  forgetPerson: (person: string, mode: "forget" | "anonymize") => post<ForgetReport>(`${control}/memory/forget`, { person, mode }, { timeoutMs: 10 * 60_000 }),

  memoryEpisodes: (filter: EpisodeFilter) =>
    request<{ episodes: EpisodeSummary[] }>(
      `${control}/memory/episodes?${q({ q: filter.q, agent: filter.agent, person: filter.person, tag: filter.tag, since: filter.since, until: filter.until, status: filter.status, limit: String(filter.limit ?? 200) })}`,
    ),
  memoryGraph: (filter: GraphFilter) => {
    // Repeated, not joined: `?agent=nouva&agent=nix`, so no value needs a separator it cannot contain.
    const params = new URLSearchParams(q({ since: filter.since, limit: filter.limit ? String(filter.limit) : undefined, knowledge: filter.knowledge ? "1" : undefined }));
    for (const [name, values] of [["agent", filter.agents], ["person", filter.people], ["tag", filter.tags]] as const) {
      for (const value of values ?? []) params.append(name, value);
    }
    return request<MemoryGraph>(`${control}/memory/graph?${params.toString()}`);
  },
  memoryFacets: () => request<MemoryFacets>(`${control}/memory/facets`),
  memoryEpisode: (id: string) => request<{ episode: Episode; archived?: string }>(`${control}/memory/episodes/${encodeURIComponent(id)}`),
  deleteEpisode: (id: string) => request<{ episodes: number; facts: number }>(`${control}/memory/episodes/${encodeURIComponent(id)}`, { method: "DELETE" }),

  agentNotes: () => request<{ agents: AgentNotes[] }>(`${control}/memory/agents`),
  agentNote: (id: string) => request<{ id: string; name: string; content: string; exists: boolean }>(`${control}/memory/agents/${encodeURIComponent(id)}`),

  memoryProposals: () => request<{ proposals: Proposal[] }>(`${control}/memory/proposals`),
  decideProposal: (id: string, verb: "approve" | "deny") => post<{ id: string; status: string }>(`${control}/memory/proposals/${id}/${verb}`, {}),

  memoryChanges: (subject?: string) => request<{ changes: MemoryChange[] }>(`${control}/memory/changes${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`),
  memoryFailed: () => request<{ failed: FailedEpisode[] }>(`${control}/memory/failed`),
  retryEpisode: (episode?: string) => post<{ episode: string | null }>(`${control}/memory/retry`, episode ? { episode } : {}),
  /** One model call per conversation, so well past the client's usual 15 s. */
  runPass: () => post<PassReport>(`${control}/memory/pass`, {}, { timeoutMs: 10 * 60_000 }),
  /** Every filed conversation and fact without a vector gets one, in the background. */
  embedMemory: () => post<{ started: boolean; items: number }>(`${control}/memory/embed`, {}),

  memoryTagPlan: () => request<TagTidyPlan>(`${control}/memory/tags/tidy`),
  /** One model call over the whole vocabulary. */
  suggestTagMerges: () =>
    post<{ changes: TagTidyChange[]; dropped?: { from: string[]; into: string; why: string }[]; readable?: boolean }>(`${control}/memory/tags/tidy/model`, {}, { timeoutMs: 3 * 60_000 }),
  /** Rewrites every episode it touches, after a vault backup. */
  applyTagTidy: (ids: string[], model: TagTidyChange[]) => post<{ at: string; changes: number; episodes: number }>(`${control}/memory/tags/tidy`, { ids, model }, { timeoutMs: 5 * 60_000 }),
  mergeTags: (from: string[], into: string) => post<{ at: string; episodes: number }>(`${control}/memory/tags/merge`, { from, into }, { timeoutMs: 5 * 60_000 }),
  undoTagTidy: () => post<{ restored: number; skipped: string[] }>(`${control}/memory/tags/tidy/undo`, {}, { timeoutMs: 5 * 60_000 }),

};
