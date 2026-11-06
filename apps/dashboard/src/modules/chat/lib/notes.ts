/**
 * What the Notes panel decides about work notes, apart from drawing them: which task a kept plan goes under, and how
 * far along it is. Pure, so the rules are tested without a page.
 */

import type { NotesPlan, NotesPlanStep, NotesTask } from "@/commons/lib/api.notes";

/** A title as the daemon matches it (`sameTitle` in the engine's `modules/notes/format.ts`): case and spacing aside. */
const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The tasks, each with the plan when it is the one the plan was kept with. A plan whose task is not in the notes — an
 * edit that renamed it, read before the daemon dropped the plan — is put under a task of its own name rather than lost.
 */
export function withPlans(tasks: readonly NotesTask[], plan: NotesPlan | undefined): { task: NotesTask; plan?: NotesPlan }[] {
  const shown = tasks.map((task) => (plan && titleKey(task.title) === titleKey(plan.task) ? { task, plan } : { task }));
  if (plan && !shown.some((entry) => entry.plan)) shown.push({ task: { title: plan.task, body: "" }, plan });
  return shown;
}

/** Steps finished, the way the engine's progress line counts them: a skipped step is settled too. */
export function stepsDone(steps: readonly NotesPlanStep[]): number {
  return steps.filter((step) => step.state === "done" || step.state === "skipped").length;
}
