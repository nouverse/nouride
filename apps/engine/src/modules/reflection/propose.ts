/**
 * `skill_improve` — an agent correcting a skill it is using, mid-turn.
 *
 * Split out of `index.ts` when that file went over its line budget, and the seam is the one that was
 * already there: the loop answers "the daemon looked back at a finished turn", this answers "an
 * agent just read a file and found it wrong". Different trigger, different author, and — since the
 * body arrives from the agent rather than from a model handed the pending draft — a different rule
 * for what happens when a draft is already waiting.
 *
 * The gate is the same one everything else goes through. The pool is read-only to every agent on
 * purpose: one of them rewriting a file silently changes how the other five behave.
 */

import { createLogger } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import { readPool, shippedSkillRefusal } from "./pool.ts";
import { announceDraft, type NotifyDeps } from "./notify.ts";
import { redact } from "@nouride/secrets";
import { cutAtWord } from "@/commons/cut-at-word.ts";
import { REASON_SEPARATOR, lessonOf, type DraftsPort } from "./drafts.store.ts";
import type { SkillDraft, SkillFile } from "./types.ts";

const log = createLogger("reflection");

export interface ProposeDeps {
  agentsDir: string;
  /** Where the daemon's own skills live, so this can say why one of them is off-limits. */
  builtinSkillsDir?: string;
  drafts: DraftsPort;
  maxPending: number;
  notify: NotifyDeps;
  audit?: AuditPort;
}

/**
 * An agent noticed, mid-turn, that a skill it was using is wrong — and says so.
 *
 * Hermes gets this from one line in its system prompt ("patch it immediately with
 * `skill_manage(action='patch')`") because its agent may write to the library directly. Ours may
 * not: the pool is read-only to every agent on purpose, since one of them rewriting a file
 * silently changes how the other five behave. So the same instinct arrives through the same gate
 * as everything else — the agent proposes, a person decides.
 *
 * Cheaper than the reflection pass and complementary to it. The loop looks *after* a turn and has
 * to infer what was learned; this fires *during* one, from an agent that just read the file and
 * knows exactly what it was missing.
 */
export async function proposeImprovement(
deps: ProposeDeps,
input: {
  agentId: string;
  gatewayId?: string;
  chatId?: string;
  sessionId?: string;
  target: string;
  why: string;
  description?: string;
  requires?: string;
  needsTools?: string;
  body: string;
  files?: SkillFile[];
  removeFiles?: string[];
  /**
   * The pending draft this body already contains, by id.
   *
   * An assertion the agent has to make, not something inferred. Without it a second improvement to
   * the same skill overwrites a lesson nobody has decided on, silently — see the refusal below.
   */
  replaces?: string;
},
): Promise<{ ok: true; draft: SkillDraft } | { ok: false; error: string }> {
  const pool = await readPool(deps.agentsDir, deps.builtinSkillsDir);
  // Before the two below, because a built-in is neither missing nor a person's: it is listed to the
  // agent by name, so "there is no skill called that" would be a lie, and it has no `author`, so the
  // hand-written refusal would name somebody who does not exist.
  const shipped = shippedSkillRefusal(pool, input.target);
  if (shipped) return { ok: false, error: shipped };
  const target = pool.find((skill) => skill.name === input.target);
  if (!target) return { ok: false, error: `There is no skill called "${input.target}".` };
  if (!target.author) {
    return {
      ok: false,
      error: `"${input.target}" was written by a person, not by an agent, so improvements to it are theirs to make. Say what is wrong in your reply instead.`,
    };
  }

  /**
   * A draft is already waiting for this skill, and this body was not written on top of it.
   *
   * The reflection pass solves this by *reading* the pending draft and revising from it. Nothing
   * can do that for `skill_improve`: the body arrives from an agent that wrote it against whatever
   * it happened to read, so accepting it would overwrite a lesson nobody has decided on yet — and
   * `updateExistingSkill` overwrites the body whole, so approving both keeps the last one only.
   * That is the loss that put four competing rewrites of `infrastructure-ops` in the live queue.
   *
   * So the agent is handed the pending draft and asked to resubmit with `replaces`. That argument
   * is an assertion — "I have read that draft and my body contains it" — and it is the only way
   * past this point. It cannot be inferred: same session or not, an agent that proposed a body an
   * hour ago and a body now has no obligation to have carried the first into the second, and
   * guessing that it did is what the old rule did.
   */
  const waiting = deps.drafts.pendingByName(input.target);
  if (waiting && input.replaces !== waiting.id) {
    return {
      ok: false,
      error:
        `A draft for "${input.target}" is already waiting (${waiting.id}), and it has not been decided yet. ` +
        `Anything you send replaces its body wholesale, so send one that contains both lessons.

` +
        `It was raised for: ${lessonOf(waiting.triggerReason)}
` +
        (waiting.files.length > 0
          ? `It also ships: ${waiting.files.map((f) => f.path).join(", ")} (these carry over on their own)
`
          : "") +
        `
Here is its body in full. Merge your change into it and call this again with ` +
        `replaces: "${waiting.id}".

${waiting.body}`,
    };
  }
  if (waiting) deps.drafts.deny(waiting.id);
  if (deps.drafts.pendingCount() >= deps.maxPending) {
    return { ok: false, error: "The drafts queue is full: nothing new can be raised until some are decided." };
  }

  // Scrubbed like anything else that reaches a file every agent reads. The agent wrote this by
  // hand rather than a model summarising a transcript, which makes it *more* likely to quote
  // something it just saw, not less.
  const body = redact(input.body);
  const description = redact(input.description?.trim() || target.description);
  const masked = [...new Set([...body.hits, ...description.hits])];

  const draft = deps.drafts.create({
    agentId: input.agentId,
    ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    triggerKind: "in_use",
    triggerReason: [cutAtWord(input.why.replace(/\s+/g, " ").trim(), 200), ...(masked.length > 0 ? [`masked: ${masked.join(", ")}`] : [])].join(REASON_SEPARATOR),
    // Same bookkeeping the reflection path keeps: what this absorbed, so the reviewer sees the
    // size of the decision rather than only the newest sentence.
    ...(waiting ? { carries: [...waiting.carries, lessonOf(waiting.triggerReason)] } : {}),
    name: target.name,
    target: target.name,
    description: description.text,
    requires: input.requires?.trim() ?? (target.requires ?? []).join(", "),
    needsTools: input.needsTools?.trim() ?? (target.needsTools ?? []).join(", "),
    body: body.text,
    /**
     * The superseded draft's files come along, unless this one replaces them by name.
     *
     * The same rule as the reflection path, and the same reason: the body says "see
     * references/foo.md" and that file was only ever attached to the draft being retired, so
     * without this the pointer survives and the file never exists. `remove_files` still wins — an
     * agent that explicitly retires a path meant it.
     */
    ...(() => {
      const carried = new Map<string, string>();
      for (const file of waiting?.files ?? []) carried.set(file.path, file.content);
      for (const file of input.files ?? []) carried.set(file.path, redact(file.content).text);
      for (const path of input.removeFiles ?? []) carried.delete(path);
      return carried.size > 0
        ? { files: [...carried].map(([path, content]) => ({ path, content })) }
        : {};
    })(),
    ...(input.removeFiles && input.removeFiles.length > 0 ? { removeFiles: input.removeFiles } : {}),
  });

  deps.audit?.record({
    action: "skill_draft_created",
    agentId: input.agentId,
    actor: input.agentId,
    details: { draft: draft.id, skill: draft.name, trigger: "in_use" },
  });
  log.info("skill improvement raised by the agent using it", {
    agent_id: input.agentId,
    draft: draft.id,
    skill: draft.name,
  });

  await announceDraft(deps.notify, draft, Boolean(waiting && waiting.sessionId === input.sessionId));
  return { ok: true, draft };
}
