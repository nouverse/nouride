/**
 * The Memory menu's calls (what memory does: `docs/SPEC.md` §12).
 *
 * Split out of `api.ts`, which is over its line budget, and spread into `api` like the others. The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { AgentNotes, Episode, EpisodeFilter, EpisodeSummary, FactsMode, FailedEpisode, ForgetReport, GraphFilter, MemoryChange, MemoryDocument, MemoryFacets, MemoryGraph, MemorySettings, MemoryStatus, PassReport, PersonSummary, Proposal, SettingsPatch, TagTidyChange, TagTidyPlan } from "@nouride/wire";

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
  deleteEpisode: (id: string) => request<{ id: string; episodes: number; facts: number }>(`${control}/memory/episodes/${encodeURIComponent(id)}`, { method: "DELETE" }),

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
    post<{ changes: TagTidyChange[]; dropped?: { from: string[]; into: string; why: string }[]; readable?: boolean; plain?: string | null }>(`${control}/memory/tags/tidy/model`, {}, { timeoutMs: 3 * 60_000 }),
  /** Rewrites every episode it touches, after a vault backup. */
  applyTagTidy: (ids: string[], model: TagTidyChange[]) => post<{ at: string; changes: number; episodes: number }>(`${control}/memory/tags/tidy`, { ids, model }, { timeoutMs: 5 * 60_000 }),
  mergeTags: (from: string[], into: string) => post<{ at: string; episodes: number }>(`${control}/memory/tags/merge`, { from, into }, { timeoutMs: 5 * 60_000 }),
  undoTagTidy: () => post<{ restored: number; skipped: string[] }>(`${control}/memory/tags/tidy/undo`, {}, { timeoutMs: 5 * 60_000 }),

};
