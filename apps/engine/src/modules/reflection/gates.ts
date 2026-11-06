/**
 * The two checks between the pass's answer and a draft: whether a new skill is written yet, and whether what was
 * written may be kept.
 *
 * Both are code because both were already in the prompts and did not hold — see `draft-lint.ts` and
 * `candidates.store.ts` for what each was measured against.
 */

import { createLogger } from "@nouride/shared";
import { parseFrontmatter, type SkillState } from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { CandidateStore } from "./candidates.store.ts";
import { draftRefusal } from "./draft-lint.ts";
import type { DraftsPort } from "./drafts.store.ts";
import { readSkill } from "./pool.ts";
import type { Triage } from "./synthesis.ts";
import type { Trigger } from "./types.ts";

const log = createLogger("reflection");

/**
 * Whether a create is written now: when a person asked for the skill, or when another conversation already showed this
 * kind of work. Otherwise it is held as a candidate — named, with its "Use when" line — and nothing more is written.
 */
export function writeNow(
  candidates: CandidateStore | undefined,
  create: Extract<Triage, { decision: "create" }>,
  context: { trigger: Trigger; agentId: string; sessionId: string; audit?: AuditPort | undefined },
): boolean {
  if (!candidates || context.trigger.kind === "user_request") return true;
  const seen = candidates.recurring(create, context.sessionId);
  if (seen) {
    candidates.take(seen.name);
    log.info("reflection is writing a skill for work seen again", { skill: create.name, candidate: seen.name, agent_id: context.agentId });
    return true;
  }
  candidates.hold({ name: create.name, description: create.description, why: create.why, agentId: context.agentId, sessionId: context.sessionId });
  log.info("reflection held a new kind of work until it recurs", { skill: create.name, agent_id: context.agentId });
  context.audit?.record({ action: "skill_candidate_held", agentId: context.agentId, details: { skill: create.name, description: create.description } });
  return false;
}

/** Why a draft may not be kept, against the skill it revises — or null. */
export async function refusalOf(
  draft: { name: string; description: string; body: string; target?: string },
  pool: SkillState[],
  drafts: DraftsPort,
): Promise<string | null> {
  if (!draft.target) return draftRefusal({ description: draft.description, body: draft.body, descriptionChanged: true });
  const before = await readSkill(pool, draft.target, drafts);
  const previous = pool.find((skill) => skill.name === draft.target);
  return draftRefusal({
    description: draft.description,
    body: draft.body,
    ...(before !== null ? { previousBody: before.startsWith("---") ? parseFrontmatter(before).body.trim() : before.trim() } : {}),
    descriptionChanged: previous?.description.trim() !== draft.description.trim(),
  });
}
