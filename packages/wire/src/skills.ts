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
  /** Times it was read, counted from the release that began counting; and how many of them since learning last changed it. */
  reads: number;
  readsSinceChange: number;
}

/** A kind of work an agent did once, held until it comes back and a skill is written for it. */
export interface SeenWork {
  name: string;
  /** Its "Use when" line. */
  description: string;
  why: string;
  agentId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** How many times learning named it. */
  sightings: number;
  /** The conversation it was seen in is still kept, so its skill can be written now. */
  canWrite: boolean;
}

/** One thing skill learning did, or decided not to, as a person reads it. */
export interface LearningEvent {
  at: number;
  agentId: string | null;
  /** `nothing`: looked and wrote nothing. `held`: a new kind of work, seen once. `refused`: a draft the daemon would not keep. */
  kind: "nothing" | "held" | "refused" | "drafted" | "written" | "improved";
  /** The skill or the kind of work it was about, where there was one. */
  skill: string | null;
  why: string;
}

/** What learning holds and what it did lately: the answer to "why was nothing learned". */
export interface LearningSeen {
  seen: SeenWork[];
  recent: LearningEvent[];
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
  | "curation"
  /** A mission that ended done, looked at once from its goal and its report. */
  | "mission";

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
  /** From Nouverse's catalog alone: what it is called where that differs from its name, and who published it. */
  title?: string;
  owner?: string;
  /** One Nouverse put on its own list. */
  pick?: boolean;
}

/** Where a list of skills is from: Nouverse's catalog, or the hubs themselves (one named, the catalog off or not answering). */
export type SkillHubFrom = "catalog" | "hubs";

export interface SkillHubSearch {
  hits: SkillHubHit[];
  /** Every hub a search can ask, by id. */
  sources: readonly string[];
  /** A hub, or the catalog, that did not answer, said beside the results rather than instead of them. */
  errors: { source: string; error: string }[];
  from: SkillHubFrom;
  /** The catalog's alone: how many match in all, and when its copy was last brought up to date (ISO; null: not yet). */
  total?: number;
  syncedAt?: string | null;
}

/** What Explore shows before a search: Nouverse's own list, or ClawHub's most used; `plain`, why there is none, in the page's words. */
export interface SkillHubPopular {
  hits: SkillHubHit[];
  from: SkillHubFrom;
  total?: number;
  syncedAt?: string | null;
  error?: string;
  plain?: string;
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
