/**
 * The work notes as the model reads them: at the very end of every request in the conversation (`ChatParams.tail`),
 * read fresh at every step, so a note written in step three is there in step four.
 */

import type { Task } from "./format.ts";
import { sameTitle } from "./format.ts";
import type { KeptPlan, NotesKey, NotesPort, PlanStep } from "./store.ts";

const MARK: Record<PlanStep["state"], string> = { pending: "[ ]", active: "[~]", done: "[x]", skipped: "[-]" };

/** A plan's lines, the way `plan` renders it back. */
export function planLines(steps: readonly PlanStep[]): string[] {
  const done = steps.filter((step) => step.state === "done" || step.state === "skipped").length;
  return [
    `Plan (${done}/${steps.length} done):`,
    ...steps.map(
      (step, index) =>
        `${index + 1}. ${MARK[step.state]} ${step.text}${step.state === "skipped" && step.reason ? ` (skipped: ${step.reason})` : ""}${step.note ? `: ${step.note}` : ""}`,
    ),
  ];
}

/**
 * The block, or nothing when there are no notes, no plan and nothing set aside: an empty block at every step is tokens
 * that say nothing.
 */
export function notesTail(input: {
  tasks: readonly Task[];
  plan?: KeptPlan | undefined;
  setAside?: { titles: string[]; at: number } | undefined;
  archive: string;
}): string | undefined {
  const { tasks, plan, setAside } = input;
  if (tasks.length === 0 && !plan && !setAside) return undefined;
  const lines = [
    "WORK NOTES (yours, for this conversation, kept outside its history): compaction, the daily rollover, /new and a restart " +
      "never touch them. Keep them current with `notes` as the work moves; remove a task when it is done.",
  ];
  for (const task of tasks) {
    lines.push("", `## ${task.title}`);
    if (task.body) lines.push(task.body);
    if (plan && sameTitle(plan.task, task.title)) lines.push(...planLines(plan.steps));
  }
  if (setAside) {
    const day = new Date(setAside.at).toISOString().slice(0, 10);
    lines.push("", `Set aside on ${day} after two weeks untouched: ${setAside.titles.map((title) => `"${title}"`).join(", ")}. They are kept in ${input.archive}, which \`read\` opens.`);
  }
  return lines.join("\n");
}

/** The block for one conversation, read now from the store — what a turn hands the executor as `notes`. */
export function tailFor(store: NotesPort, key: NotesKey): string | undefined {
  return notesTail({ tasks: store.tasks(key), plan: store.plan(key), setAside: store.setAside(key), archive: store.pathOf(key).archive });
}

/** `TurnRequest.notes` for a conversation, when the daemon keeps notes. */
export function notesOf(store: NotesPort | undefined, key: NotesKey): { notes?: () => string | undefined } {
  return store ? { notes: () => tailFor(store, key) } : {};
}

/**
 * What a helper or a peer is handed of the notes (0.7.26): the task the work is part of — the one the plan is kept with,
 * else the one written last — as a read-only copy. Not the whole file: a group's other tasks are not theirs to see.
 */
export function workNotesCopy(store: NotesPort | undefined, key: NotesKey): string | undefined {
  if (!store) return undefined;
  const plan = store.plan(key);
  const task = (plan ? store.task(key, plan.task) : undefined) ?? store.latest(key);
  if (!task) return undefined;
  return [
    "WORK NOTES (a read-only copy of the task this is part of, from the agent that asked). It keeps them: put what is worth keeping in your answer.",
    "",
    `## ${task.title}`,
    ...(task.body ? [task.body] : []),
    ...(plan && sameTitle(plan.task, task.title) ? planLines(plan.steps) : []),
  ].join("\n");
}
