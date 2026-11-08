/**
 * A conversation's work notes (0.7.26): the markdown file the agent keeps with its `notes` tool, a `## Title` section
 * per task, and the plan `plan` keeps with one of them. The agent reads them at every step, so the chat page shows them
 * beside the conversation and an operator can correct them. Spread into `api`, like the chat's own calls.
 */

import { control, request } from "./api.client";
import type { WorkNotes } from "@nouride/wire";

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
