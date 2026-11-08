/**
 * A conversation's work notes (`routes/notes.ts`): the task the agent keeps with its `notes` tool, and the plan kept with
 * it.
 */

/** One task: its `## ` heading, and what the agent wrote under it. */
export interface NotesTask {
  title: string;
  body: string;
}

/** Where a step of a kept plan stands. */
export type StepState = "pending" | "active" | "done" | "skipped";

/** One step of a kept plan (`PlanStep` in the engine's `modules/notes/store.ts`). */
export interface NotesPlanStep {
  text: string;
  state: StepState;
  /** Why a step was skipped. */
  reason?: string;
  /** What a finished step did and left — files, ids, a count (0.8.0). Absent from a daemon before it. */
  note?: string;
}

/** The plan kept with a task, across turns. */
export interface NotesPlan {
  /** The title of the task it belongs to. */
  task: string;
  steps: NotesPlanStep[];
  updatedAt: number;
}

/** What `GET /sessions/:id/notes` answers. */
export interface WorkNotes {
  /** The whole file, as an edit starts from it. */
  text: string;
  tasks: NotesTask[];
  /** Absent when no plan is kept. */
  plan?: NotesPlan;
  /** Tasks untouched for two weeks, moved to the archive — until the agent has been told. */
  setAside: { titles: string[]; at: number } | null;
}
