/**
 * What approving a draft moves, in words — one source for `nouride skills` and the chat's `/drafts`.
 *
 * The first live weekly review was approved from the CLI, which said an archived skill was "in the pool — on for every
 * agent", and the chat said every approval put the skill in every agent's prompt. A move of something several agents
 * rely on must not read as one more improvement, before it is approved or after.
 */

import type { SkillDraft } from "./types.ts";

type Moved = Pick<SkillDraft, "name" | "target" | "retire" | "agentId" | "triggerKind">;

/** Before approving: "archives", "merges a, b into", "improves", or nothing for a new skill. */
export function draftVerb(draft: Moved): string {
  if (draft.retire.includes(draft.name)) return "archives";
  if (draft.retire.length > 0) return `merges ${draft.retire.join(", ")} into`;
  return draft.target ? "improves" : "";
}

/** After approving, following the skill's name. A new skill is on for the agent that learned it (`agents:`), unless installed. */
export function approvedSentence(draft: Moved): string {
  if (draft.retire.includes(draft.name)) {
    return `archived, and out of every prompt from the next message (skills/.archive/${draft.name}/; move it back to undo)`;
  }
  const others = draft.retire.length > 0 ? `; ${draft.retire.join(", ")} archived` : "";
  if (draft.target) return `updated: whoever has it reads the new version from the next message${others}`;
  if (draft.triggerKind === "external_install") return "is in the pool, on for every agent from the next message";
  return `is in the pool, on for ${draft.agentId} from the next message (\`nouride skills on ${draft.name} <agent>\` gives it to another)`;
}
