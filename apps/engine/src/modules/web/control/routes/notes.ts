/**
 * A conversation's work notes, beside it on the chat page (0.7.26, `modules/notes/`).
 *
 * The agent reads them at every step of every turn, so the people running it should see what it is working from — and
 * correct it: a wrong fact in the notes is repeated until somebody takes it out. An edit is the whole file, checked the
 * way the agent's own writes are (size, credentials), and recorded in the audit log.
 */

import { NotesRefused } from "@/modules/notes/store.ts";
import { renderNotes } from "@/modules/notes/format.ts";
import { atLeast } from "@/modules/users/auth.ts";
import { conversationNamed } from "../conversation.ts";
import { jsonBody } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

/** Longest text an edit may send — well over the notes' own cap, so the cap's refusal is the one said. */
const MAX_EDIT_CHARS = 64 * 1024;

export function registerNotesRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The session row, or the turn record of a first turn still running: a new conversation has no row until that turn
   * ends. Found live in 0.8.0 — the plan beside a new chat answered 404 for its whole first turn, so it never showed.
   */
  const keyOf = (id: string) => {
    const named = conversationNamed(deps, id);
    return named ? { agentId: named.agentId, gatewayId: named.gatewayId, chatId: named.chatId } : null;
  };

  control.get("/sessions/:id/notes", (c) => {
    if (!deps.notes || !deps.sessions) return c.json({ error: "not available" }, 501);
    const key = keyOf(c.req.param("id"));
    if (!key) return c.json({ error: "no such session" }, 404);
    const tasks = deps.notes.tasks(key);
    const plan = deps.notes.plan(key);
    return c.json({ text: renderNotes(tasks), tasks, ...(plan ? { plan } : {}), setAside: deps.notes.setAside(key) ?? null });
  });

  control.put("/sessions/:id/notes", async (c) => {
    if (!deps.notes || !deps.sessions) return c.json({ error: "not available" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const key = keyOf(c.req.param("id"));
    if (!key) return c.json({ error: "no such session" }, 404);
    const body = await jsonBody(c);
    if (!body || typeof body.text !== "string") return c.json({ error: "send { text }" }, 400);
    if (body.text.length > MAX_EDIT_CHARS) return c.json({ error: "too long" }, 400);
    try {
      const tasks = await deps.notes.replace(key, body.text);
      deps.audit.record({ action: "notes_edited", actor: principal.actor, agentId: key.agentId, chatId: key.chatId, details: { tasks: tasks.length } });
      return c.json({ text: renderNotes(tasks), tasks });
    } catch (err) {
      if (err instanceof NotesRefused) return c.json({ error: err.message, plain: "The notes were not saved: they are too long, hold a password or a key, or a task has no title. Change that, and save again." }, 400);
      throw err;
    }
  });
}
