/**
 * Skills (`routes/skills.ts`, `routes/drafts.ts`, `routes/skills-hub.ts`): the pool, an agent's switches on it, the
 * self-improvement queue, and the hub.
 */

import type { SkillLearningMode } from "@nouride/shared";

/** One skill in the pool, with every agent's switch on it — the Skills Workshop's row. */
export interface CatalogSkill {
  name: string;
  description: string;
  /** `project`: from a folder an agent was given as a skill root, its own and no other agent's. */
  scope: "shared" | "project" | "builtin";
  path: string;
  requires: string[];
  missing: string[];
  /** Nouride tools the procedure calls — a different axis from `requires`, which is host software. */
  needsTools: string[];
  /** `[skills] off` names it: no agent loads it, whatever its own `skills.toml` says. */
  offGlobally: boolean;
  agents: {
    id: string;
    displayName: string;
    enabled: boolean;
    decided: boolean;
    /** Tools this skill needs that this agent does not hold. */
    missingTools: string[];
    /** A coding CLI's agent: tools no coding CLI is ever given, so the skill is not its (0.8.13). */
    notForCli?: string[];
  }[];
  lastUsedAt: number | null;
}

/** Why a turn was worth reflecting on. Recorded on the draft, and shown to whoever decides. */
export type TriggerKind =
  | "error_recovery"
  | "user_request"
  | "sustained_effort"
  /** An agent said so while using the skill — `skill_improve`, not the after-the-turn pass. */
  | "in_use"
  | "first_integration"
  /** Fetched from a skill hub — GitHub, skills.sh, ClawHub, a well-known index — by a person or an agent. */
  | "external_install"
  /** The weekly review of the library: tighten, merge or archive (`curator.ts`). Waits for a person in every mode. */
  | "curation";

/**
 * A skill an agent proposed and nobody has decided on yet — the RSI queue.
 *
 * Not a `CatalogSkill`: a draft is not in the pool, no agent has it, and the fields that matter are
 * the ones that say where it came from. Rendering the two through one type would put "who has this
 * on" on a row where the answer is nobody, by construction.
 */
export interface SkillDraft {
  id: string;
  createdAt: number;
  agentId: string;
  gatewayId: string | null;
  chatId: string | null;
  triggerKind: TriggerKind;
  triggerReason: string;
  name: string;
  description: string;
  requires: string;
  /** Nouride tools the procedure calls, comma-separated. */
  needsTools: string;
  body: string;
  /** The skill this improves, or null when it proposes a new one. */
  target: string | null;
  /** Files to ship beside SKILL.md — `references/…`, `scripts/…`, `templates/…`. */
  files: { path: string; content: string }[];
  /** Files of the skill it improves that approving it deletes: the counterpart to `files`. */
  removeFiles: string[];
  /** Earlier lessons this draft absorbed, oldest first — see the note on the card that renders it. */
  carries: string[];
  /** Skills archived when this is approved: a merge's others, or the skill itself for an archive. Absent before 0.7.27. */
  retire?: string[];
  model: string | null;
  status: "pending" | "approved" | "denied";
  decidedAt: number | null;
  decidedBy: string | null;
  publishedPath: string | null;
}

export type LearningMode = SkillLearningMode;

/** `[skills.learning]`, live on the daemon: a save takes effect on the next message rather than the next restart. */
export interface LearningSettings {
  mode: LearningMode;
  model: string;
  notifyChat: boolean;
  /** The last weekly review and what it proposed; null before the first. */
  lastReview: { ranAt: number; report: { tighten: string[]; merge: { into: string; retire: string[] }[]; archive: string[]; declined: { skill: string; reason: string }[] } } | null;
  editable: boolean;
  /** Drafts waiting right now, so the form can say what the current setting has produced. */
  pending: number;
}

export interface SoftwareCheck {
  name: string;
  present: boolean;
  path?: string;
}

export interface SkillHubHit {
  /** What `skillHubInstall` takes: `skills.sh:owner/repo/skill`, `clawhub:slug`… */
  ref: string;
  source: "github" | "skills.sh" | "clawhub" | "well-known";
  name: string;
  description: string;
  url: string;
  installs?: number;
  stars?: number;
}

export interface SkillHubSearch {
  hits: SkillHubHit[];
  /** Every hub a search can ask, by id. */
  sources: readonly string[];
  /** A hub that did not answer, said beside the results rather than instead of them. */
  errors: { source: string; error: string }[];
}

export interface SkillHubInstall {
  ok: boolean;
  error?: string;
  /** `flagged`: its source's scan found something, or could not be read. */
  drafts?: { id: string; name: string; description: string; source: string; notes: string[]; warnings: string[]; flagged?: boolean }[];
  refused?: { name: string; reason: string }[];
  notes?: string[];
  /** What it came to in the page's words (0.8.23); `refused`, `notes` and each draft's `warnings` are the hub's, under Details. */
  plain?: string;
}

export interface AgentSkill {
  name: string;
  description: string;
  scope: "shared" | "project" | "builtin";
  path: string;
  /** Host software the skill's procedure names, and the subset this host does not have. */
  requires: string[];
  missing: string[];
  /** Whether this agent carries it. Everything is on until somebody switches it off. */
  enabled: boolean;
  /** Whether the agent's `skills.toml` mentions it at all — "on by default" vs "on by choice". */
  decided: boolean;
  /** `[skills] off` names it: off for every agent, whatever `enabled` says. Absent from a daemon before 0.7.10. */
  offGlobally?: boolean;
  /** False for a project skill: it is switched off by removing the root, not from here. */
  toggleable: boolean;
}
