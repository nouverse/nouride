/**
 * What the reflection loop passes around: a finished turn, a reason to look at it, and a draft.
 *
 * Separate from the engine so the detector, the store and the synthesis pass can each depend on the
 * shape without importing the class that drives them — the same reason `executor/types.ts` exists.
 */

import type { ChatMessage } from "@nouride/shared";

/**
 * One tool call as the loop saw it.
 *
 * Two fields, on purpose. The detector asks "did this fail, and did something succeed after it",
 * and nothing else about a call answers that. Carrying arguments here would put every path, every
 * URL and every command line of every turn into memory for the sake of a boolean.
 */
export interface ToolStep {
  name: string;
  ok: boolean;
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

export interface Trigger {
  kind: TriggerKind;
  /** One line an operator reads in the drafts list: "two tool failures, then it worked". */
  reason: string;
}

/** A finished turn, handed to the loop after the reply has already gone out. */
export interface ObservedTurn {
  agentId: string;
  gatewayId: string;
  chatId: string;
  sessionId: string;
  /** The turn's record, when it has one: what a pass on it is metered under. */
  turnId?: string;
  /** What the person actually asked, before the harness wrapped it. */
  userText: string;
  /** Only what this turn added. What the synthesis pass reads for a single-turn trigger. */
  messages: ChatMessage[];
  /**
   * The conversation this turn belongs to, this turn included.
   *
   * What the pass reads when `sustained_effort` fired, and it has to be this rather than `messages`:
   * that trigger exists precisely because the work was spread over several turns, and synthesising a
   * three-turn debugging session from its last turn would write down the step that finally worked
   * and none of the reasoning that found it.
   */
  chain: ChatMessage[];
  steps: ToolStep[];
  /**
   * Model round-trips this turn took — `TurnResult.iterations`.
   *
   * The unit the effort counter accumulates. One for a turn that answered outright, more for every
   * round of tool use, so a hard turn is worth more than an easy one without anybody weighting it.
   */
  iterations: number;
}

export type DraftStatus = "pending" | "approved" | "denied";

/**
 * A file that ships beside `SKILL.md`.
 *
 * Three kinds, and the split is Hermes': `references/` for detail worth keeping out of the body,
 * `scripts/` for something re-runnable, `templates/` for a starter file to copy. It matters because
 * a skill's *description* is in every prompt on every turn while its body is read on demand — so
 * pushing detail down is what keeps a thorough skill affordable.
 */
export interface SkillFile {
  /** `references/foo.md`, `templates/config.toml`, a `check.py` in `scripts/`. One level, validated. */
  path: string;
  content: string;
}

/** A proposed skill, in the pieces `SKILL.md` is assembled from. */
export interface SkillDraft {
  id: string;
  createdAt: number;
  agentId: string;
  gatewayId: string | null;
  chatId: string | null;
  sessionId: string | null;
  triggerKind: TriggerKind;
  triggerReason: string;
  name: string;
  description: string;
  /** Host software the procedure needs, comma-separated. Empty means none. */
  requires: string;
  /** Nouride tools the procedure calls, comma-separated. The other axis — see `Skill.needsTools`. */
  needsTools: string;
  body: string;
  /**
   * The skill this draft improves, or null when it proposes a new one.
   *
   * The verb the loop was missing. Approving an update overwrites that skill's `SKILL.md`; approving
   * a create writes a new directory. Everything else about a draft means the same thing either way,
   * which is why this is one nullable column and not a second table.
   */
  target: string | null;
  /** Support files proposed alongside the body. Empty for most drafts. */
  files: SkillFile[];
  /**
   * The `why` lines of the drafts this one absorbed, oldest first.
   *
   * Empty on a first draft, and it is the honest measure of how big the decision is. A second
   * improvement to the same skill is built on the first draft's body rather than on the file — four
   * competing rewrites of `infrastructure-ops` in the live queue would otherwise have kept one and
   * dropped three on approval. The cost of that fix is that the surviving draft's reason describes
   * only the pass that wrote it, so a reason reading "lxc-attach needs chmod +x" could equally be
   * carrying Headlamp and a macOS cleanup: three changes approved on one sentence read.
   */
  carries: string[];
  /**
   * Support files to delete when this is approved.
   *
   * The counterpart to `files`, and the only way a stray reference gets removed short of deleting
   * the whole skill. Paths are validated the same way, so this cannot reach outside the directory.
   */
  removeFiles: string[];
  /**
   * Skills archived when this is approved (`skills/.archive/`): the others of a merge, or the skill itself for a
   * proposal to archive one nobody reads. Only the weekly review proposes any (`curator.ts`).
   */
  retire: string[];
  /** The scrubbed excerpt the synthesis pass read. Null once a build stops storing them. */
  transcript: string | null;
  model: string | null;
  status: DraftStatus;
  decidedAt: number | null;
  decidedBy: string | null;
  publishedPath: string | null;
}

/** Fields a human may correct before approving. Anything absent keeps what the model wrote. */
export interface DraftEdits {
  name?: string;
  description?: string;
  requires?: string;
  needsTools?: string;
  body?: string;
}
