/**
 * An agent's skill roots from its Skills page and `nouride agent skill-root add|rm` (0.8.24): listed with the skills
 * each brings, added and removed by an admin. What a root brings is instructions in the agent's prompt, so whoever
 * decides its persona decides this; the agent's own request is an admin's yes in a chat (`skill_root`). Written as the
 * Files tab's save writes (`setup/skill-roots.ts`).
 *
 * Registered before `agents.ts`: `POST /agents/:id/:action` would otherwise take `POST /agents/:id/skill-roots`.
 */

import { atLeast } from "@/modules/users/auth.ts";
import type { SkillRootRefusal } from "@/modules/setup/skill-roots.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { CHANGED_MEANWHILE, NOT_RUNNING, notSaved } from "../plain.ts";

/** Each refusal as a person reads it, and its status: the domain's own sentence stays the reply's `error`. */
const REFUSED: Record<SkillRootRefusal, { plain: string; status: 400 | 404 | 409 }> = {
  agent: { plain: "There is no such agent on this server. Reload the page, and try again.", status: 404 },
  path: { plain: notSaved("the folder: give its full path, starting with /"), status: 400 },
  missing: { plain: "There is no folder there on this server. Nothing was saved.", status: 400 },
  file: { plain: "That is a file. Name the project's folder instead. Nothing was saved.", status: 400 },
  unreadable: { plain: "Nouride is not allowed to open that folder on this server. Nothing was saved.", status: 400 },
  credentials: { plain: "That folder holds the keys Nouride keeps, so no agent may take skills from it. Nothing was saved.", status: 400 },
  already: { plain: "This agent already takes skills from that folder.", status: 409 },
  unknown: { plain: "This agent does not take skills from that folder. Reload the page, and try again.", status: 404 },
  conflict: { plain: CHANGED_MEANWHILE, status: 409 },
  unsaved: { plain: notSaved("the folder"), status: 400 },
};

export function registerSkillRootRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/agents/:id/skill-roots", async (c) => {
    if (!deps.skillRoots) return c.json({ error: "skill roots are not available on this daemon", plain: NOT_RUNNING }, 501);
    const id = c.req.param("id");
    const roots = await deps.skillRoots.list(id);
    if (!roots) return c.json({ error: `no agent "${id}"` }, 404);
    return c.json({ roots, editable: atLeast(c.get("principal"), "admin") });
  });

  control.post("/agents/:id/skill-roots", async (c) => {
    if (!deps.skillRoots) return c.json({ error: "skill roots are not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.path !== "string" || !body.path.trim()) return c.json({ error: "path must be a folder's full path", plain: REFUSED.path.plain }, 400);
    const result = await deps.skillRoots.add({ agentId: c.req.param("id"), path: body.path, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: REFUSED[result.refused].plain }, REFUSED[result.refused].status);
    return c.json(result);
  });

  control.delete("/agents/:id/skill-roots", async (c) => {
    if (!deps.skillRoots) return c.json({ error: "skill roots are not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const path = c.req.query("path") ?? "";
    if (!path.trim()) return c.json({ error: "path must name one of the agent's skill roots", plain: REFUSED.unknown.plain }, 400);
    const result = await deps.skillRoots.remove({ agentId: c.req.param("id"), path, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: REFUSED[result.refused].plain }, REFUSED[result.refused].status);
    return c.json(result);
  });
}
