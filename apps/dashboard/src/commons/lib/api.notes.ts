/**
 * A conversation's work notes (0.7.26): the markdown file the agent keeps with its `notes` tool, a `## Title` section
 * per task, and the plan `plan` keeps with one of them. The agent reads them at every step, so the chat page shows them
 * beside the conversation and an operator can correct them. Spread into `api`, like the chat's own calls.
 */

import { control, request } from "./api.client";

/** One task: its `## ` heading, and what the agent wrote under it. */
export interface NotesTask {
  title: string;
  body: string;
}

/** One step of a kept plan (`PlanStep` in the engine's `modules/notes/store.ts`). */
export interface NotesPlanStep {
  text: string;
  state: "pending" | "active" | "done" | "skipped";
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

export const notesApi = {
  /** 501 when the daemon keeps no notes; 404 for a conversation it does not know — and from a daemon before 0.7.26. */
  notes: (sessionId: string) => request<WorkNotes>(`${control}/sessions/${encodeURIComponent(sessionId)}/notes`),
  /**
   * Replace the whole file. Operators and up. A refusal — over 8 KB, or it holds a credential's value — is a 400 whose
   * `error` is a sentence for the person who typed it.
   */
  saveNotes: (sessionId: string, text: string) =>
    request<Pick<WorkNotes, "text" | "tasks">>(`${control}/sessions/${encodeURIComponent(sessionId)}/notes`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
};
