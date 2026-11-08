/**
 * `/notes` — what the agent has written down about the work in this chat, and `/notes clear` to empty it (0.7.26).
 *
 * The notes are sent to the model at every step, so the people in the chat should be able to see what it is working
 * from — and throw it away, the way `/reset` does, without throwing the conversation away too.
 */

import { plural } from "@nouride/shared";
import { renderNotes } from "@/modules/notes/format.ts";
import type { Hook } from "../types.ts";
import { sessionKey } from "../format.ts";

export const notesHooks: Hook[] = [
  {
    command: "/notes",
    description: "Show this chat's work notes, or clear them: /notes clear",
    handler: async (ctx) => {
      const notes = ctx.deps.notes;
      if (!notes) return { handled: true, reply: "Work notes are not kept in this process." };
      const key = sessionKey(ctx);
      if (ctx.args[0]?.toLowerCase() === "clear") {
        const cleared = await notes.clear(key);
        return { handled: true, reply: cleared === 0 ? "No work notes here, nothing to clear." : `Cleared ${cleared} task(s) from the work notes.` };
      }
      const tasks = notes.tasks(key);
      const plan = notes.plan(key);
      if (tasks.length === 0) return { handled: true, reply: "No work notes in this chat yet." };
      const steps = plan ? `\nPlan for "${plan.task}": ${plan.steps.filter((step) => step.state === "done" || step.state === "skipped").length} of ${plan.steps.length} steps done.` : "";
      return { handled: true, reply: `Work notes (${tasks.length} ${plural(tasks.length, "task")}):\n\n${renderNotes(tasks).trim()}${steps}` };
    },
  },
];
