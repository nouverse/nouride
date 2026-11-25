/**
 * What a new agent may start as, and changing an existing one's tools or making it the default.
 *
 * Registered before `routes/agents.ts`, whose `POST /agents/:id/:action` would otherwise take
 * `/agents/:id/tools` and `/agents/:id/default` as actions.
 *
 * **Admin only for the writes.** A tool switched on is a capability granted — `exec` is a shell — and
 * the orchestrator is who answers everyone nothing else claims.
 */

import type { AgentPresets } from "@nouride/wire";
import { AGENT_ACCESS, isAgentAccess, LOOK_PARTS, type AgentLook } from "@nouride/shared";
import { PRESETS, TOOL_GROUPS, toolsFor } from "@/modules/setup/presets.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_CHANGED, NOT_RUNNING, NOT_SAVED, notSaved } from "../plain.ts";

/** Each part of an agent's cat a save can be refused for, as its Look tab names it. */
const LOOK_FIELDS: Record<keyof AgentLook, string> = {
  fur: "the fur",
  pattern: "the pattern",
  outfit: "the outfit",
  outfitColor: "the outfit colour",
  hat: "the hat",
  accessory: "the accessory",
  eyes: "the eyes",
};

export function registerAgentToolRoutes(control: ControlApp, deps: ControlDeps): void {
  /** The presets with the tools each would give on this daemon, and every tool grouped for the switches. */
  control.get("/setup/presets", (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const available = deps.setup.availableTools();
    const grouped = new Set(TOOL_GROUPS.flatMap((group) => group.tools));
    const groups = [
      ...TOOL_GROUPS.map((group) => ({ label: group.label, tools: group.tools.filter((name) => available.includes(name)) })),
      { label: "Other", tools: available.filter((name) => !grouped.has(name)) },
    ].filter((group) => group.tools.length > 0);
    return c.json({
      presets: PRESETS.map((preset) => ({ id: preset.id, label: preset.label, summary: preset.summary, headline: preset.headline, soul: preset.soul, tools: toolsFor(preset.id, available) })),
      groups,
    } satisfies AgentPresets);
  });

  control.post("/agents/:id/tools", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { tools?: unknown };
    if (!Array.isArray(body.tools) || !body.tools.every((name) => typeof name === "string")) return c.json({ error: "tools must be a list of tool names" }, 400);
    const result = await deps.setup.setAgentTools({ agentId: c.req.param("id"), tools: body.tools, actor: principal.actor });
    return result.ok ? c.json({ ok: true } satisfies { ok: true }) : c.json({ error: result.error, plain: NOT_SAVED }, 400);
  });

  /** Whether this agent's connections take new senders. Admin only, like the daemon-wide switch. */
  control.post("/agents/:id/access", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { access?: unknown };
    if (!isAgentAccess(body.access)) return c.json({ error: `access must be one of ${AGENT_ACCESS.join(", ")}` }, 400);
    // Not a word among the others: an agent is opened to everyone with the limits on what strangers may cost, or not at all.
    if (body.access === "open") return c.json({ error: "an agent is opened to everyone with its daily limits, not by this setting", plain: NOT_SAVED }, 400);
    const result = await deps.setup.setAgentAccess({ agentId: c.req.param("id"), access: body.access, actor: principal.actor });
    return result.ok ? c.json({ ok: true } satisfies { ok: true }) : c.json({ error: result.error, plain: NOT_SAVED }, 400);
  });

  /** Its cat in Nouride Office, part by part (0.8.1). Operator and up: a look, not a capability. */
  control.post("/agents/:id/look", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const look: Record<string, string> = {};
    for (const part of Object.keys(LOOK_PARTS)) {
      if (body[part] === undefined) continue;
      if (typeof body[part] !== "string") return c.json({ error: `${part} must be text: a word of the part, or empty for its own` }, 400);
      look[part] = body[part] as string;
    }
    const result = await deps.setup.setLook({ agentId: c.req.param("id"), look, actor: principal.actor });
    return result.ok ? c.json({ ok: true } satisfies { ok: true }) : c.json({ error: result.error, plain: notSaved(result.field && LOOK_FIELDS[result.field]) }, 400);
  });

  /**
   * Open an agent to everyone, with the two limits on what strangers may cost it. Admin only: a protection turned
   * off, and one that spends its owner's tokens for anyone who finds the agent. A chat's sender is not a signed-in
   * person, so no tool of an agent's reaches this.
   */
  control.post("/agents/:id/open", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { maxDailyTokens?: unknown; maxDailyMessagesPerPerson?: unknown; closedReply?: unknown; knowsItsNotes?: unknown };
    const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
    if (!whole(body.maxDailyTokens) || !whole(body.maxDailyMessagesPerPerson)) {
      return c.json({ error: "maxDailyTokens and maxDailyMessagesPerPerson must each be a whole number of 1 or more", plain: notSaved("the two daily limits: each is a whole number, 1 or more") }, 400);
    }
    if (body.closedReply !== undefined && typeof body.closedReply !== "string") return c.json({ error: "closedReply must be text", plain: notSaved("the closing sentence") }, 400);
    const result = await deps.setup.openAgent({
      agentId: c.req.param("id"),
      limits: { maxDailyTokens: body.maxDailyTokens, maxDailyMessagesPerPerson: body.maxDailyMessagesPerPerson, ...(body.closedReply?.trim() ? { closedReply: body.closedReply } : {}) },
      knowsItsNotes: body.knowsItsNotes === true,
      actor: principal.actor,
    });
    if (result.ok) return c.json({ ok: true } satisfies { ok: true });
    if (result.notes) return c.json({ error: result.error, notes: true, plain: "This agent has notes of its own, and it may say what they hold to anyone. Read them first, then tick that you have." }, 409);
    return c.json({ error: result.error, plain: "This agent was not opened. Nothing was changed." }, deps.registry.get(c.req.param("id")) ? 409 : 404);
  });

  /** Close an agent that is open to everyone. Operator and up: turning a protection back on is anyone's who may change the agent. */
  control.post("/agents/:id/close", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const result = await deps.setup.closeAgent({ agentId: c.req.param("id"), actor: principal.actor });
    return result.ok ? c.json({ ok: true } satisfies { ok: true }) : c.json({ error: result.error, plain: NOT_CHANGED }, deps.registry.get(c.req.param("id")) ? 400 : 404);
  });

  control.post("/agents/:id/orchestrator", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const result = await deps.setup.setOrchestrator({ agentId: c.req.param("id"), actor: principal.actor });
    if (result.ok) return c.json({ ok: true } satisfies { ok: true });
    // Not found only when there is no such agent: an external one refused, or a config that would not save, was a 404
    // too (0.8.10, the live box) — said for an agent that is there.
    return c.json({ error: result.error, plain: "This agent cannot be the main agent. Nothing was changed." }, deps.registry.get(c.req.param("id")) ? 409 : 404);
  });
}
