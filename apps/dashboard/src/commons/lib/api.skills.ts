/**
 * The skills surface: the pool, one skill's files, and the self-improvement queue.
 *
 * Split out of `api.ts` when that file went back over its line budget, following `api.setup.ts` —
 * spread into `api` rather than imported separately, so `api.skillFiles()` reads the same at every
 * call site and the split is about where the lines live.
 *
 * A coherent group rather than a convenient one: every call here addresses `/skills`, and they are
 * the only ones that do.
 */

import { control, post, request } from "./api.client";
import type { CatalogSkill, LearningSettings, SkillDraft, SkillHubHit, SkillHubInstall, SkillHubSearch, SoftwareCheck } from "@nouride/wire";

export const skillsApi = {
  skillCatalog: () =>
    request<{
      skills: CatalogSkill[];
      software: SoftwareCheck[];
      poolDir: string;
      editable: boolean;
    }>(`${control}/skills/catalog`),
  skillSource: (name: string) =>
    request<{
      name: string;
      description: string;
      scope: string;
      path: string;
      requires: string[];
      missing: string[];
      needsTools: string[];
      source: string;
    }>(`${control}/skills/${encodeURIComponent(name)}/source`),
  /** What a skill ships beside its body — see the note on the panel that renders it. */
  skillFiles: (name: string) =>
    request<{
      name: string;
      scope: string;
      editable: boolean;
      files: {
        path: string;
        bytes: number;
        kind: "markdown" | "script" | "text" | "binary";
        editable: boolean;
        referenced: boolean;
      }[];
    }>(`${control}/skills/${encodeURIComponent(name)}/files`),
  skillFile: (name: string, path: string) =>
    request<{ name: string; path: string; kind: string; source: string }>(
      `${control}/skills/${encodeURIComponent(name)}/files/read?path=${encodeURIComponent(path)}`,
    ),
  saveSkillFile: (name: string, path: string, source: string) =>
    post<{ ok: true; skill: string; path: string }>(`${control}/skills/${encodeURIComponent(name)}/files/write`, { path, source }),
  deleteSkillFile: (name: string, path: string) =>
    request<{ ok: true; skill: string; path: string; wasReferenced: boolean }>(
      `${control}/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),

  /**
   * Off for every agent at once — `[skills] off`.
   *
   * The other axis from `saveAgentSkills`, which writes one pack's answers. A built-in has no other
   * removal: it ships inside the executable, so deleting it is refused.
   */
  setSkillOffGlobally: (name: string, off: boolean) =>
    post<{ ok: true; skill: string; off: boolean }>(`${control}/skills/${encodeURIComponent(name)}/global`, { off }),

  /**
   * Rewrite one pool skill's `SKILL.md`, whole.
   *
   * The same shape `skillSource` returns, so the editor is a text box over the real file. Built-in
   * skills are refused by the daemon with a 400 — they ship inside the executable, so an edit would
   * look permanent and be undone by the next upgrade.
   */
  saveSkillSource: (name: string, source: string) =>
    post<{ ok: true; skill: string; path: string }>(`${control}/skills/${encodeURIComponent(name)}/source`, { source }),
  // The whole directory, and every agent reloads. Refused for built-in skills by the daemon, which
  // is also the only thing that knows which those are.
  deleteSkill: (name: string) =>
    request<{ ok: true; skill: string; path: string }>(
      `${control}/skills/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  // One cell of the matrix, because that is what the operator clicks. The daemon merges it into the
  // agent's whole map before writing, so this cannot drop a decision made in another tab.
  setSkillForAgent: (name: string, agent: string, enabled: boolean) =>
    post<{ ok: true; skill: string; agentId: string; enabled: boolean }>(
      `${control}/skills/${encodeURIComponent(name)}/agents/${encodeURIComponent(agent)}`,
      { enabled },
    ),

  // The RSI queue. `enabled: false` is a normal answer, not an error — the Workshop renders "the
  // loop is off" rather than a red box, which is the difference between a setting and a fault.
  skillDrafts: () =>
    request<{ enabled: boolean; pending: SkillDraft[]; recent: SkillDraft[] }>(`${control}/skills/drafts`),
  // Fetched only when a draft is opened: the transcript is the biggest thing on the page and the
  // list view has no use for it.
  skillDraft: (id: string) =>
    request<SkillDraft & { transcript: string | null }>(`${control}/skills/drafts/${encodeURIComponent(id)}`),
  // Edits ride along with the approval, so "fix this and keep it" is one click and not two requests
  // that can half-succeed.
  approveSkillDraft: (
    id: string,
    edits?: { name?: string; description?: string; requires?: string; body?: string },
  ) => post<{ ok: true; skill: string; path: string }>(`${control}/skills/drafts/${encodeURIComponent(id)}/approve`, edits ?? {}),
  denySkillDraft: (id: string) =>
    post<{ ok: true }>(`${control}/skills/drafts/${encodeURIComponent(id)}/deny`, {}),

  // Skills from hubs. Search reads public indexes; install raises drafts — nothing reaches the pool
  // until one is approved on the Pending tab.
  skillHubSearch: (query: string, source?: string) =>
    request<SkillHubSearch>(
      `${control}/skills/hub/search?${new URLSearchParams({ q: query, ...(source ? { source } : {}) })}`,
    ),
  /** The most used skills, shown on Explore before anything is typed; `plain`, why they are not, in the page's words (0.8.20). */
  skillHubPopular: () => request<{ hits: SkillHubHit[]; error?: string; plain?: string }>(`${control}/skills/hub/popular`),
  skillHubInstall: (ref: string) => post<SkillHubInstall>(`${control}/skills/hub/install`, { ref }),

  learningSettings: () => request<LearningSettings>(`${control}/skills/learning`),
  reviewSkills: () => post<NonNullable<LearningSettings["lastReview"]>["report"]>(`${control}/skills/review`, {}),
  // A patch, not the whole object: the form sends what changed, and the daemon validates the lot
  // before writing any of it.
  saveLearningSettings: (patch: Partial<Omit<LearningSettings, "editable" | "pending">>) =>
    post<{ ok: true }>(`${control}/skills/learning`, patch),
};

