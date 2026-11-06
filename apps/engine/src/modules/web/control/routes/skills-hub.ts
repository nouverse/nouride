/**
 * Skills from hubs: search across them, and install one into the pending queue.
 *
 * Install never writes the pool — it raises drafts, decided on the same Pending tab as everything
 * else. So the bar here is the one for raising a draft by hand (operator), not for publishing.
 * Registered before `registerSkillRoutes`, whose `/skills/:name` would otherwise take `hub`.
 */

import { atLeast } from "@/modules/users/auth.ts";
import { hubErrorMessage, SOURCE_IDS, type SourceId } from "@/modules/skills-hub/index.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";

export function registerSkillHubRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/skills/hub/search", async (c) => {
    if (!deps.skillHub) return c.json({ error: "the skills hub is not available" }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const query = (c.req.query("q") ?? "").trim();
    if (!query) return c.json({ error: "`q` is required" }, 400);
    const sources = (c.req.query("source") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is SourceId => (SOURCE_IDS as string[]).includes(s));
    const limit = Number(c.req.query("limit") ?? 8) || 8;
    const result = await deps.skillHub.search(query, { sources, limit });
    return c.json({ ...result, sources: SOURCE_IDS });
  });

  /** The most used skills, for Explore before anything is typed. A hub that does not answer is said, not an error page. */
  control.get("/skills/hub/popular", async (c) => {
    if (!deps.skillHub) return c.json({ error: "the skills hub is not available" }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    try {
      return c.json({ hits: await deps.skillHub.popular() });
    } catch (err) {
      return c.json({ hits: [], error: hubErrorMessage(err), plain: "The list of popular skills could not be reached. Try again in a moment." });
    }
  });

  control.post("/skills/hub/install", async (c) => {
    if (!deps.skillHub) return c.json({ error: "the skills hub is not available" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.ref !== "string" || !body.ref.trim()) return c.json({ error: "`ref` is required" }, 400);
    // An agent installing through its `nouride` tool names itself, and is then treated as the agent
    // it is: credited, capped, and answered in its own conversation. A name that is not an agent is
    // ignored rather than trusted.
    const asAgent = typeof body.agentId === "string" && deps.registry.get(body.agentId) ? body.agentId : undefined;
    const who = asAgent
      ? {
          agentId: asAgent,
          byAgent: true,
          ...(typeof body.gatewayId === "string" && body.gatewayId ? { gatewayId: body.gatewayId } : {}),
          ...(typeof body.chatId === "string" && body.chatId ? { chatId: body.chatId } : {}),
        }
      : { agentId: principal.actor ?? "operator", byAgent: false };
    try {
      const result = await deps.skillHub.install(body.ref, who);
      return c.json({ ok: result.drafts.length > 0, drafts: result.drafts, refused: result.refused, notes: result.notes });
    } catch (err) {
      return c.json({ ok: false, error: hubErrorMessage(err), plain: "The skill was not installed. Check where it is from, and try again." }, 400);
    }
  });
}
