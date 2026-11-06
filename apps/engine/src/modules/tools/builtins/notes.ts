/**
 * `notes` — the agent's work notes for the conversation it is in (0.7.26, `modules/notes/`).
 *
 * The gap it closes: long work lived in the chat's history, which compaction summarizes, the in-turn trim cuts and the
 * daily rollover clears. On 2026-10-20 a WhatsApp group's four-hour audit lost which documents were done, the rules the
 * person had set and that Excel had to be closed first — the agent ran the same commands again and asked again. What
 * is written here is sent at the end of every request in the conversation (`ChatParams.tail`) and survives all of it.
 *
 * A section per task, written whole: `write` replaces one task, `remove` takes one out. No "replace everything", so one
 * bad call cannot wipe the file — the shape `MEMORY.md`'s `replace_section` already taught.
 *
 * Offered by the daemon, not the pack (`resolveToolset`): every pack here enumerates its tools, and a capability the
 * prompt relies on and the schema leaves out is the trap `ask_agent` fell into. It confers nothing: it writes only this
 * agent's notes for this conversation. A helper and a peer do not have it — the conversation's own agent is the one
 * writer, and a helper says what to keep in its answer.
 */

import { rootSessionOf, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import { NotesRefused, type NotesKey, type NotesPort } from "@/modules/notes/store.ts";
import { notesTail } from "@/modules/notes/tail.ts";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";

function keyOf(ctx: ToolContext): NotesKey {
  return { agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId };
}

/** Tasks in one conversation's notes past which a new one is questioned when it is written. */
const CROWDED_AT = 3;

/**
 * Said with a new task once there are several. Live (2026-10-21), one audit became six tasks — a plan, a focus, a night's
 * job and a task per status update ("STATUS 23:15 (terbaru)", "STATUS 00:30 (terbaru)") — until a write was refused at
 * the size cap; merged, the same work was 1.4 KB.
 */
function crowded(titles: readonly string[]): string {
  if (titles.length < CROWDED_AT) return "";
  return (
    ` ${titles.length} tasks in the notes now: ${titles.map((name) => `"${name}"`).join(", ")}. One piece of work is one ` +
    "task: its progress goes in its own section, under the same title; merge the ones that are one, and remove what is over."
  );
}

const fail = (content: string): ToolResult => ({ content, isError: true });
const ok = (content: string, metadata?: Record<string, unknown>): ToolResult => ({ content, isError: false, ...(metadata ? { metadata } : {}) });

export function createNotesTool(store: NotesPort): Tool {
  return {
    requiresApproval: false,
    definition: {
      name: "notes",
      description:
        "Your work notes for this conversation, shown to you at the end of every request and never lost to compaction, the " +
        "daily rollover, /new or a restart. One section per task: `write` {title, body} creates or replaces it, and a task's " +
        "progress goes in its own section under the same title, never in a new task per status, step or hour; `remove` " +
        "{title} when the task is done (`memory_write` first what will matter after it); `view` shows them. A task in a few " +
        "lines: Goal, Done (with the results you will need again), Next, Rules the person set, Facts found, Waiting on. Write it when work starts, as it " +
        "moves, and before you wait for a person. Never a credential's value: its name or $TMP_SECRET_ handle.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["view", "write", "remove"] },
          title: { type: "string", description: "The task, in a few words. Same title, same section." },
          body: { type: "string", description: "The task's whole section, for `write`." },
        },
        required: ["action"],
      },
    },

    async execute(args, ctx) {
      if (rootSessionOf(ctx.sessionId) !== ctx.sessionId) {
        return fail("Work notes are kept by the conversation's own agent. Say in your answer what is worth noting, and it keeps it.");
      }
      const key = keyOf(ctx);
      const action = typeof args.action === "string" ? args.action : "";
      const title = typeof args.title === "string" ? args.title.trim() : "";
      try {
        switch (action) {
          case "view": {
            const shown = notesTail({ tasks: store.tasks(key), plan: store.plan(key), setAside: store.setAside(key), archive: store.pathOf(key).archive });
            return ok(shown ?? "No work notes in this conversation yet.");
          }
          case "write": {
            if (!title) return fail("`write` needs a `title`: the task, in a few words.");
            if (typeof args.body !== "string" || !args.body.trim()) return fail("`write` needs a `body`: the task's whole section.");
            if (!workTextIsEnglish(`${title}\n${args.body}`)) return fail(writeWorkInEnglish(`The task "${title}"`));
            const { created } = await store.write(key, title, args.body);
            if (!created) return ok(`Updated "${title}".`, { task: title, created });
            return ok(`Noted "${title}".${crowded(store.tasks(key).map((task) => task.title))}`, { task: title, created });
          }
          case "remove": {
            if (!title) return fail("`remove` needs the `title` of the task to take out.");
            const removed = await store.remove(key, title);
            if (!removed) {
              const titles = store.tasks(key).map((task) => `"${task.title}"`);
              return fail(`No task "${title}" in the notes${titles.length ? `. There is ${titles.join(", ")}` : ""}.`);
            }
            return ok(`Removed "${removed.title}".`, { task: removed.title });
          }
          default:
            return fail('`action` is "view", "write" or "remove".');
        }
      } catch (err) {
        if (err instanceof NotesRefused) return fail(err.message);
        throw err;
      }
    },
  };
}
