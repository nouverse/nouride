/**
 * The two decisions a human makes about a draft: keep it, which writes the skill, or discard it.
 *
 * **Nothing else writes a skill.** `approveDraft` is reached from a person (a slash command, a dashboard button, the
 * CLI) or, where learning is automatic, from the pass itself through this same function: one writer, so the rule on a
 * skill a person wrote, the provenance, the reload and the audit row are one set and not two.
 */

import { createLogger } from "@nouride/shared";
import { VALID_SKILL_NAME, archivePoolSkill, updateExistingSkill, writeNewSkill, type AgentRegistry } from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import { applyEdits } from "./draft-fields.ts";
import type { DraftsPort } from "./drafts.store.ts";
import { installedFields } from "./install.ts";
import { writeRefusal } from "./pool.ts";
import type { DraftEdits, SkillDraft } from "./types.ts";

const log = createLogger("reflection");

export interface DecisionDeps {
  drafts: DraftsPort;
  agentsDir: string;
  builtinSkillsDir?: string;
  registry: Pick<AgentRegistry, "reloadAll">;
  audit?: AuditPort;
  /** A skill was changed by an approved draft: its reads are counted from here. */
  skillChanged?: (path: string) => void;
  now: () => number;
}

export type ApprovalOutcome =
  | { ok: true; draft: SkillDraft; path: string }
  | { ok: false; error: string };

/**
 * Approve: write the skill into the pool and reload every pack.
 *
 * Exactly what `skill_create` does, through the same writer. A new skill is on for the agent that learned it
 * (`agents:`), an update reaches whoever has it, and a merge or an archive moves the retired skills to `.archive/`.
 *
 * The row is marked approved only after the write succeeded and the reload did. A draft marked
 * approved beside a pool that does not have the skill is the one state nobody could diagnose from
 * either surface.
 */
export async function approveDraft(deps: DecisionDeps, id: string, by: string, edits?: DraftEdits): Promise<ApprovalOutcome> {
  const draft = deps.drafts.get(id);
  if (!draft) return { ok: false, error: `no draft "${id}"` };
  if (draft.status !== "pending") {
    return { ok: false, error: `draft "${draft.name}" was already ${draft.status}` };
  }

  const fields = applyEdits(draft, edits ?? {});
  if (!VALID_SKILL_NAME.test(fields.name)) {
    return { ok: false, error: `"${fields.name}" is not a valid skill name` };
  }

  /**
   * A skill a person wrote is not the loop's to rewrite, checked again here.
   *
   * The triage step already refuses to name one, so reaching this is either a draft raised before
   * somebody replaced an agent's skill with their own, or a client calling the route directly.
   * Both are exactly why the check is repeated at the write: the first gate is advice to a model
   * and this one is the rule.
   */
  // A create is checked too: a new skill under a built-in's name would shadow it. See `writeRefusal`.
  const refusal = await writeRefusal(deps.agentsDir, deps.builtinSkillsDir, draft.target ?? fields.name, !draft.target);
  if (refusal) return { ok: false, error: refusal };

  const today = new Date(deps.now()).toISOString().slice(0, 10);
  const document = {
    name: fields.name,
    description: fields.description,
    ...(fields.requires ? { requires: fields.requires } : {}),
    ...(fields.needsTools ? { needsTools: fields.needsTools } : {}),
    body: fields.body,
    author: draft.agentId,
    verifiedBy: by,
    ...installedFields(draft),
    ...(draft.files.length > 0 ? { files: draft.files } : {}),
    ...(draft.removeFiles.length > 0 ? { removeFiles: draft.removeFiles } : {}),
  };

  /**
   * Two verbs, one gate.
   *
   * `updateExistingSkill` overwrites and keeps the original `author` and `created`; `writeNewSkill`
   * refuses to overwrite. Which one runs is decided by the draft, not by whether a file happens to
   * be there — an update whose target was deleted while the draft waited must fail loudly rather
   * than quietly becoming a create.
   */
  // A proposal to archive a skill retires the skill it names, and writes nothing.
  const archiveOnly = draft.retire.includes(draft.name);
  const written = archiveOnly
    ? { ok: true as const, path: "" }
    : draft.target
    ? await updateExistingSkill(deps.agentsDir, { ...document, updated: today })
    : await writeNewSkill(deps.agentsDir, {
        ...document,
        created: today,
        // On for the agent whose work it came from; another turns it on in its `skills.toml`. An installed skill was
        // asked for by name, for whoever wants it.
        ...(draft.triggerKind !== "external_install" ? { agents: draft.agentId } : {}),
      });
  if (!written.ok) return { ok: false, error: written.error };
  // After the write: a merge's others are archived only once the skill that holds them is on disk.
  const archived: string[] = [];
  const archivedTo: string[] = [];
  for (const name of draft.retire) {
    const moved = await archivePoolSkill(deps.agentsDir, name);
    if (moved.ok) {
      archived.push(name);
      archivedTo.push(moved.path);
    } else log.warn("an approved draft could not archive a skill", { draft: id, skill: name, error: moved.error });
  }

  try {
    await deps.registry.reloadAll();
  } catch (err) {
    // Said plainly rather than reported as success. The file is on disk and the prompts are stale,
    // which is a state somebody has to know about to fix.
    return { ok: false, error: `wrote ${written.path} but reloading the agents failed: ${String(err)}` };
  }

  deps.drafts.markApproved(id, by, written.path || archivedTo[0] || "");
  if (draft.target && written.path) deps.skillChanged?.(written.path);
  deps.audit?.record({
    action: draft.target ? "skill_draft_updated" : "skill_draft_approved",
    agentId: draft.agentId,
    actor: by,
    details: {
      draft: id,
      skill: fields.name,
      path: written.path,
      ...(draft.target ? { updated: draft.target } : {}),
      ...(draft.files.length > 0 ? { files: draft.files.map((file) => file.path) } : {}),
      // What left the pool — the audit row of an archive otherwise names a skill and an empty path.
      ...(archived.length > 0 ? { archived } : {}),
    },
  });
  log.info(archiveOnly ? "skill archived" : draft.target ? "skill improved" : "skill draft approved", {
    draft: id,
    skill: fields.name,
    actor: by,
    ...(archived.length > 0 ? { archived } : {}),
  });

  return { ok: true, draft: deps.drafts.get(id)!, path: written.path };
}

/** Discard: the row goes, transcript and all. */
export function denyDraft(deps: Pick<DecisionDeps, "drafts" | "audit">, id: string, by: string): boolean {
  const draft = deps.drafts.get(id);
  if (!draft || draft.status !== "pending") return false;

  deps.drafts.deny(id);
  deps.audit?.record({
    action: "skill_draft_denied",
    agentId: draft.agentId,
    actor: by,
    details: { draft: id, skill: draft.name },
  });
  log.info("skill draft discarded", { draft: id, skill: draft.name, actor: by });
  return true;
}
