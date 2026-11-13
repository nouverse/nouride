/**
 * One agent's own settings: its endpoint, which skills it carries, its MCP servers, and its
 * lifecycle. The pool-wide view of skills is `routes/skills.ts`.
 *
 * `POST /agents/:id/:action` is registered last on purpose. Hono matches in order, so it would
 * otherwise claim `/agents/:id/model`, `/agents/:id/skills` and `/agents/:id/mcp` before they are
 * reached — and the same rule is why `files.ts` is registered before this module.
 */

import type { AgentSkill } from "@nouride/wire";
import { join, readTextFileIfExists, writeTextFileAtomic } from "@nouride/runtime";
import { cleanHeadline, HEADLINE_MAX, withHeadline } from "@/modules/setup/identity-headline.ts";
import { agentSkillPool, skillsDirFor } from "@nouride/persona";
import { missingFor } from "@nouride/persona";
import { approvalLevelRefusal, isAgentApprovalLevel, type FallbackPair } from "@nouride/shared";
import { EFFORT_CHOICES, isEffortChoice } from "@/modules/setup/agent-effort.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NOT_A_NUMBER, NOT_RUNNING, NOT_SAVED, NO_SETTINGS, notSaved } from "../plain.ts";

/** The two fields an agent's model can be refused for, as its Model tab names them. */
const MODEL_FIELDS = { provider: "the provider", model: "the model" } as const;

export function registerAgentRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * Which endpoint and model this agent runs on.
   *
   * A route of its own rather than a raw config edit, so the profile is checked before the file is
   * written and the pack is reloaded after. The alternative — telling people to edit `[llm]` in the
   * file editor — works, and is exactly the kind of thing a dashboard exists to not require.
   */
  control.post("/agents/:id/model", async (c) => {
    if (!deps.settings || !deps.files) {
      return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    }
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.settings.saveAgentModel({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      provider: String(body.provider ?? ""),
      model: String(body.model ?? ""),
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && MODEL_FIELDS[result.field]) }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });

  /**
   * How long its model thinks, `{ effort }` (0.8.17): a level, or `default` for the install's — `[llm] effort` in its pack,
   * written as the CLI tab and `agent_configure` write it (`setup/agent-effort.ts`). An operator's, as its model is.
   */
  control.post("/agents/:id/effort", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const id = c.req.param("id");
    if (!deps.registry.get(id)) return c.json({ error: `no agent "${id}"` }, 404);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (!isEffortChoice(body.effort)) return c.json({ error: `effort is one of ${EFFORT_CHOICES.join(", ")}` }, 400);
    const result = await deps.setup.setEffort({ agentId: id, effort: body.effort, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });

  /**
   * Who answers when an agent's model cannot — `{ fallbacks: [{ provider, model }] }`, in order; empty for none.
   */
  control.post("/agents/:id/fallbacks", async (c) => {
    if (!deps.settings || !deps.files) {
      return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    }
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const raw = body.fallbacks;
    const pairs = Array.isArray(raw) ? raw.filter((pair): pair is FallbackPair => typeof pair?.provider === "string" && typeof pair?.model === "string") : null;
    if (!pairs || pairs.length !== (raw as unknown[]).length) {
      return c.json({ error: "fallbacks must be a list of { provider, model }, or empty for none" }, 400);
    }

    const result = await deps.settings.saveAgentFallbacks({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      fallbacks: pairs.map((pair) => ({ provider: pair.provider, model: pair.model })),
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the fallbacks") }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });

  /**
   * The clock's half, and the same `null`-means-follow contract as the tool budget beside it.
   */
  control.post("/agents/:id/turn-seconds", async (c) => {
    if (!deps.settings || !deps.files) {
      return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    }
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const raw = body.turnSeconds;
    if (raw !== null && typeof raw !== "number") {
      return c.json({ error: "turnSeconds must be a whole number, or null to follow the daemon", plain: NOT_A_NUMBER }, 400);
    }

    const result = await deps.settings.saveAgentTurnSeconds({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      seconds: raw,
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the turn budget") }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });

  /**
   * This agent's own tool budget, or none to follow the daemon.
   *
   * `null` is a value here, not a missing field: it is how "follow the daemon" is said, and it has
   * to be distinguishable from "do not change anything". A number written to mean "the same as the
   * default" would silently stop tracking the default the next time somebody raises it.
   */
  control.post("/agents/:id/tool-iterations", async (c) => {
    if (!deps.settings || !deps.files) {
      return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    }
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const raw = body.maxToolIterations;
    if (raw !== null && typeof raw !== "number") {
      return c.json({ error: "maxToolIterations must be a whole number, or null to follow the daemon", plain: NOT_A_NUMBER }, 400);
    }

    const result = await deps.settings.saveAgentToolIterations({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      iterations: raw,
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the tool budget") }, 400);
    return c.json({
      ok: true,
      maxToolIterations: deps.registry.get(id)?.config.llm.maxToolIterations ?? null,
      daemonDefault: deps.ctx.config.llm.limits.maxToolIterations,
    } satisfies { ok: true; maxToolIterations: number | null; daemonDefault: number });
  });

  /**
   * What this agent carries, and what it could carry.
   *
   * Every skill in the pool is listed — the ones that are switched off included — because the page's
   * job is a set of switches and a switch you cannot see is one you cannot flip. `enabled` is this
   * agent's answer; `decided` says whether its `skills.toml` mentions the skill at all, so "on by
   * default" and "on because somebody chose it" are distinguishable.
   */
  control.get("/agents/:id/skills", async (c) => {
    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    // The prompt's own rules (`agentSkillPool`): a built-in a pool skill overrides is not listed, and `[skills] off` is
    // said per skill. This listing applied neither — a globally-off skill read as on, an overridden built-in twice.
    const listed = await agentSkillPool({
      poolDir: skillsDirFor(deps.ctx.config.daemon.agentsDir),
      builtinDir: deps.builtinSkillsDir,
      states: agent.config.skills,
      offGlobally: deps.ctx.config.skills.off,
      agent: id,
    });

    // Project skills are not switchable from here and are shown anyway: "why does it know this?" is
    // the question this page opens with, and a skill that came from a repository the operator pointed
    // at has a different answer and a different way to change it.
    const project = deps.projectSkills ? await deps.projectSkills.forAgent(agent) : [];
    const owned = new Set(listed.map((skill) => skill.name));

    return c.json({
      skills: [
        ...listed.map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          path: skill.path,
          requires: skill.requires ?? [],
          missing: missingFor(skill),
          enabled: skill.enabled,
          decided: skill.decided,
          offGlobally: skill.offGlobally,
          toggleable: true,
        })),
        ...project
          .filter((skill) => !owned.has(skill.name))
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            path: skill.path,
            requires: skill.requires ?? [],
            missing: missingFor(skill),
            enabled: true,
            decided: false,
            offGlobally: false,
            // Switched off by removing the root from `[workspace] skill_roots`, which is a different
            // act with different consequences — a toggle here would quietly rewrite the wrong file.
            toggleable: false,
          })),
      ],
      editable: Boolean(deps.settings),
    } satisfies { skills: AgentSkill[]; editable: boolean });
  });

  /**
   * Switch skills on and off for one agent.
   *
   * The body carries the agent's whole decision map — `{ states: { "skill-name": false, ... } }` —
   * rather than one name and a flag, because a list of switches is what the operator is looking at
   * and sending its whole state avoids the read-modify-write race two tabs would otherwise have.
   * Writes `agents/<id>/skills.toml`; `config.toml` is never touched.
   */
  control.post("/agents/:id/skills", async (c) => {
    if (!deps.settings) {
      return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    }
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    // What changed, merged into the file as it is when the write lands — see `saveAgentSkills`.
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const changes = body.changes;
    if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
      return c.json({ error: "changes must be an object of skill name → true|false" }, 400);
    }

    const result = await deps.settings.saveAgentSkills({
      packDir: agent.dir,
      reload: () => deps.registry.reload(id),
      agentId: id,
      changes: changes as Record<string, boolean>,
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });

  /**
   * What this agent is for, said to its peers and shown on the Agents pages: the `Headline:` line of its IDENTITY.md
   * (`setup/identity-headline.ts`). One line, written into the file as it is now, and the agent reloaded — the next turn of
   * every agent reads it.
   */
  control.post("/agents/:id/headline", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const headline = typeof body.headline === "string" ? cleanHeadline(body.headline) : null;
    if (!headline) return c.json({ error: `A headline is one short line, 1–${HEADLINE_MAX} characters.` }, 400);
    const path = join(agent.dir, "IDENTITY.md");
    await writeTextFileAtomic(path, withHeadline((await readTextFileIfExists(path)) ?? "# IDENTITY\n", headline));
    await deps.registry.reload(id);
    deps.audit.record({ action: "agent_headline_changed", actor: principal.actor, agentId: id, details: { headline } });
    return c.json({ ok: true, headline } satisfies { ok: true; headline: string });
  });

  control.post("/agents/:id/:action", async (c) => {
    const id = c.req.param("id");
    const action = c.req.param("action");
    // A pack that failed to load is one `reload` can bring back once it is fixed — `AgentRegistry.reload` loads it from
    // its files. Looked up among the loaded agents alone, it was "no agent", and only a restart loaded it.
    const failed = action === "reload" && deps.registry.loadFailures().some((failure) => failure.id === id);
    if (!deps.registry.get(id) && !failed) return c.json({ error: `no agent "${id}"` }, 404);

    switch (action) {
      // Asleep (0.8.0) is what Pause became: `pause` and `resume` stay as the old names for it.
      case "sleep":
      case "pause":
        return c.json({ ok: deps.registry.pause(id) } satisfies { ok: boolean });
      case "wake":
      case "resume":
        return c.json({ ok: deps.registry.resume(id) } satisfies { ok: boolean });
      case "reload":
        try {
          await deps.registry.reload(id);
          // Config and instructions both: a coding CLI's sessions keep what they read as they opened (0.8.8).
          deps.externalAgents?.renew(id);
          return c.json({ ok: true } satisfies { ok: boolean });
        } catch (err) {
          return c.json({ error: String(err), plain: "This agent could not be loaded again: its files have a mistake. Whoever looks after it can fix them." }, 400);
        }
      /**
       * The pack's own setting, unlike `pause`/`resume` above — a mark the registry keeps in the data
       * directory, which a restart keeps too, but which changes nothing in the pack. This edits the
       * file the next boot reads — the capability the `agent_enable` tool held until the CLI became a
       * tool of its own.
       */
      case "enable":
      case "disable": {
        if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
        const principal = c.get("principal");
        if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

        const agent = deps.registry.get(id);
        if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

        const result = await deps.settings.setAgentEnabled({
          agentConfigPath: join(agent.dir, "config.toml"),
          reload: () => deps.registry.reload(id),
          agentId: id,
          enabled: action === "enable",
          actor: principal.actor,
        });
        if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
        return c.json({ ok: true } satisfies { ok: boolean });
      }

      /**
       * How much this agent asks, for everyone who talks to it.
       *
       * **Admin only, and the dashboard is the only surface that reaches here.** `trusted` switches off
       * every gate including deletes and credential paths, so the write path has to be one that knows
       * who is asking — a chat message does not, and a CLI verb would be reachable by the agent itself
       * through its own `nouride` tool.
       */
      case "approvals": {
        if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
        const principal = c.get("principal");
        if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

        const agent = deps.registry.get(id);
        if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

        const json = await jsonBody(c);
        if (!json) return c.json({ error: "body must be a JSON object" }, 400);
        const body = json as { approvals?: unknown };
        if (!isAgentApprovalLevel(body.approvals)) {
          return c.json({ error: approvalLevelRefusal(body.approvals), plain: INCOMPLETE }, 400);
        }

        const result = await deps.settings.setAgentApprovals({
          agentConfigPath: join(agent.dir, "config.toml"),
          reload: () => deps.registry.reload(id),
          agentId: id,
          approvals: body.approvals,
          actor: principal.actor,
        });
        if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
        return c.json({ ok: true, approvals: body.approvals } satisfies { ok: true; approvals: string });
      }

      /**
       * This agent's second look (`[security] model_guard`, 0.8.0): `off`, a tier or a model id, or null to follow the
       * daemon's. Admin only, as the approval level is: it decides what work nobody watches is asked about.
       */
      case "model_guard": {
        if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
        const principal = c.get("principal");
        if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
        const agent = deps.registry.get(id);
        if (!agent) return c.json({ error: `no agent "${id}"` }, 404);
        const value = (((await jsonBody(c)) ?? {}) as { value?: unknown }).value;
        if (value !== null && typeof value !== "string") return c.json({ error: "`value` is off, a tier, a model id, or null" }, 400);
        const result = await deps.settings.setAgentModelGuard({
          agentConfigPath: join(agent.dir, "config.toml"),
          reload: () => deps.registry.reload(id),
          agentId: id,
          value,
          actor: principal.actor,
        });
        if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
        return c.json({ ok: true, value } satisfies { ok: true; value: string | null });
      }

      /**
       * Whether the orchestrator installs and updates the programs every agent runs (`[security] shared_tools`, 0.8.0).
       * Admin only; offered by the dashboard on the orchestrator's page alone, where it counts.
       */
      case "shared_tools": {
        if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
        const principal = c.get("principal");
        if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

        const agent = deps.registry.get(id);
        if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

        const json = await jsonBody(c);
        const on = (json as { on?: unknown } | null)?.on;
        if (typeof on !== "boolean") return c.json({ error: "`on` must be true or false" }, 400);

        const result = await deps.settings.setAgentSharedTools({
          agentConfigPath: join(agent.dir, "config.toml"),
          reload: () => deps.registry.reload(id),
          agentId: id,
          on,
          actor: principal.actor,
        });
        if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
        return c.json({ ok: true, on } satisfies { ok: true; on: boolean });
      }

      default:
        return c.json(
          { error: "action must be pause, resume, reload, enable, disable, approvals or shared_tools", plain: INCOMPLETE },
          400,
        );
    }
  });
}

