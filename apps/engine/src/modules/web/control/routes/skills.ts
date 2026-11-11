/**
 * The skill pool, from the pool's point of view — what the Skills Workshop and `nouride skills` read.
 *
 * The per-agent view lives in `agents.ts` (`/agents/:id/skills`) and answers "what does this agent
 * know". This module answers the other question, the one nothing could answer before: **who has this
 * skill, and does this host have what it needs?** With one shared pool and a switch per agent, that
 * is the view curation actually happens in — a skill written by one agent is now a decision for all
 * of them.
 *
 * Route order matters here, as everywhere in Hono: `/skills/catalog` is registered before
 * `/skills/:name/source`, and while the two shapes do not currently collide, the specific path first
 * is the rule this file keeps rather than an accident of position.
 */

import type { CatalogSkill, SoftwareCheck } from "@nouride/wire";
import { readTextFileIfExists } from "@nouride/runtime";
import { agentSkillPool, parseFrontmatter, skillEnabled, skillsDirFor, type PoolSkill } from "@nouride/persona";
import type { LoadedAgent, Skill } from "@nouride/shared";
import { checkSkillSoftware, missingFor, missingToolsFor } from "@nouride/persona";
import { neverForCli, toolsOfCli } from "@/modules/external-agents/skills.ts";
import { deletePoolSkill, updateExistingSkill } from "@nouride/persona";
import {
  deleteSupportFile,
  listSupportFiles,
  readSupportFile,
  writeSupportFile,
} from "@nouride/persona";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_CHANGED, NOT_SAVED, NO_SETTINGS } from "../plain.ts";

/** One skill, plus every agent's answer about it. */
interface CatalogEntry {
  name: string;
  description: string;
  scope: Skill["scope"];
  path: string;
  requires: string[];
  /** The subset of `requires` this host does not have on `PATH`. */
  missing: string[];
  needsTools: string[];
  /** `[skills] off` names it, so no agent loads it whatever its own `skills.toml` says. */
  offGlobally: boolean;
  agents: {
    id: string;
    displayName: string;
    enabled: boolean;
    decided: boolean;
    /** Tools this skill names that this agent does not hold. Empty is the normal case. */
    missingTools: string[];
    /** A coding CLI's agent: tools it is never given (`neverForCli`) — the skill is not its, whatever its switch says. */
    notForCli?: string[];
  }[];
  lastUsedAt: number | null;
}

export function registerSkillRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * Every skill an agent would be offered, across all scopes, and when each was last read.
   *
   * Project skills exist only for the duration of a turn — they are scanned against the filesystem
   * each time — so nothing else in the daemon can answer "what would this agent actually see".
   *
   * Last-used comes from `skill_reads`, which the audit log fills and its retention does not empty. It
   * answers the question that decides whether a skill earns its line in the prompt.
   */
  control.get("/skills", async (c) => {
    const requested = c.req.query("agent");
    const agents = requested
      ? [deps.registry.get(requested)].filter((a): a is LoadedAgent => Boolean(a))
      : deps.registry.all();
    if (requested && agents.length === 0) {
      return c.json({ error: "no such agent", id: requested }, 404);
    }

    const out = [];
    for (const agent of agents) {
      const project = deps.projectSkills ? await deps.projectSkills.forAgent(agent) : [];
      // A pool skill of the same name wins, exactly as the prompt renders it — otherwise this view
      // would show something the agent is not actually offered.
      const owned = new Set(agent.skills.map((s) => s.name));
      const skills = [...agent.skills, ...project.filter((s) => !owned.has(s.name))];
      const usage = deps.audit.skillReads(skills.map((s) => s.path));

      out.push({
        agentId: agent.config.id,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          path: skill.path,
          requires: skill.requires ?? [],
          missing: missingFor(skill),
          needsTools: skill.needsTools ?? [],
          // Per agent, unlike `missing`: two agents on one daemon can disagree about this while
          // agreeing about every binary on the box.
          ...toolsGap(agent, skill),
          lastUsedAt: usage.get(skill.path)?.readAt ?? null,
        })),
      });
    }
    return c.json({ agents: out });
  });

  /**
   * The Workshop's own view: one row per skill in the pool, with every agent's switch on it.
   *
   * Includes skills that are switched off everywhere, which is the half `/skills` cannot show —
   * `agent.skills` is what an agent is *offered*, so a skill nobody carries is invisible there. You
   * cannot switch on something you cannot see.
   */
  control.get("/skills/catalog", async (c) => {
    const agents = deps.registry.all();
    const entries = await catalog(deps, agents);
    const flat: Skill[] = entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      path: entry.path,
      scope: entry.scope,
      ...(entry.requires.length > 0 ? { requires: entry.requires } : {}),
      ...(entry.needsTools.length > 0 ? { needsTools: entry.needsTools } : {}),
    }));

    return c.json({
      skills: entries,
      /**
       * Every program any skill asks for, checked once.
       *
       * Reported alongside the per-skill `missing` rather than only inside it, so the Workshop can
       * show "graphviz is not installed" once instead of the same red badge on four rows.
       */
      software: checkSkillSoftware(flat),
      poolDir: skillsDirFor(deps.ctx.config.daemon.agentsDir),
      editable: Boolean(deps.settings),
    } satisfies { skills: CatalogSkill[]; software: SoftwareCheck[]; poolDir: string; editable: boolean });
  });

  /**
   * The `SKILL.md` behind one row.
   *
   * Served by *name* rather than by a path from the client. A route that read any path the caller
   * sent would be a file-disclosure hole wearing a skills badge; resolving the name against the pool
   * means only a real skill can be read.
   */
  control.get("/skills/:name/source", async (c) => {
    const name = c.req.param("name");
    const found = (await pool(deps)).find((skill) => skill.name === name);
    if (!found) return c.json({ error: "no such skill", name }, 404);

    const source = await readTextFileIfExists(found.path);
    if (source === null) return c.json({ error: "the skill's SKILL.md is gone", plain: "This skill's main file is gone. Reload the page.", name }, 404);

    return c.json({
      name: found.name,
      description: found.description,
      scope: found.scope,
      path: found.path,
      requires: found.requires ?? [],
      missing: missingFor(found),
      needsTools: found.needsTools ?? [],
      source,
    } satisfies { name: string; description: string; scope: string; path: string; requires: string[]; missing: string[]; needsTools: string[]; source: string });
  });

  /**
   * Rewrite one pool skill's `SKILL.md`, whole.
   *
   * `POST` rather than `PUT`, matching every other write here. Consistency with the surrounding API is worth more
   * than the verb being the textbook one, and it saves the client a second helper.
   *
   * Raw source rather than structured fields, matching what `GET /skills/:name/source` returns, so
   * the dashboard is a text editor over the actual file and the round-trip is exact. A structured
   * form could not express adding a frontmatter key, and a skill is a document somebody reads — the
   * thing to edit is the document.
   *
   * **Built-in skills are refused**, for the same reason `DELETE` refuses them: they ship inside the
   * executable's `skills/` directory, so on a packaged install the file is not the operator's and on
   * a source checkout it is version-controlled. An edit here would look permanent and be undone by
   * the next upgrade. Switching it off per agent is the operation that exists for them.
   *
   * `name:` is forced back to the directory name rather than trusted. The loader finds a skill by
   * its directory and the prompt advertises the frontmatter name, so letting those diverge produces
   * a skill every agent is told about under a name that resolves to nothing — and the operator who
   * renamed one field would have no reason to expect it.
   */
  control.post("/skills/:name/source", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const name = c.req.param("name");
    const found = (await pool(deps)).find((skill) => skill.name === name);
    if (!found) return c.json({ error: "no such skill", name }, 404);
    if (found.scope === "builtin") {
      return c.json(
        {
          error:
            "built-in skills ship with Nouride and cannot be edited. Switch it off for the agents that should not carry it, or copy it into the pool under another name",
          name,
        },
        400,
      );
    }

    const payload = await jsonBody(c);
    const source = payload && typeof payload.source === "string" ? payload.source : null;
    if (source === null) return c.json({ error: "`source` must be a string" }, 400);

    const { fields, body } = parseFrontmatter(source);
    if (!body.trim()) return c.json({ error: "the body is empty, and a skill with no procedure is not a skill" }, 400);
    const description = (fields.description ?? "").trim();
    // Refused rather than defaulted. `description` is what the prompt matches a task against, so a
    // skill without one is loaded and never triggers — present, inert, and impossible to debug from
    // the outside.
    if (!description) {
      return c.json({ error: "`description:` is required: it is the line every agent matches a task against" }, 400);
    }

    const written = await updateExistingSkill(deps.ctx.config.daemon.agentsDir, {
      name,
      description,
      ...(fields.requires ? { requires: fields.requires } : {}),
      ...(fields.needs_tools ? { needsTools: fields.needs_tools } : {}),
      body,
      ...(fields.author ? { author: fields.author } : {}),
      ...(fields.verified_by ? { verifiedBy: fields.verified_by } : {}),
      ...(fields.created ? { created: fields.created } : {}),
      updated: new Date().toISOString().slice(0, 10),
    });
    if (!written.ok) return c.json({ error: written.error, plain: NOT_SAVED, name }, 400);

    // Every agent, as `DELETE` and `skill_create` do: a pooled skill is in all of their prompts, so
    // reloading one pack would leave the rest serving the old body.
    try {
      await deps.registry.reloadAll();
    } catch (err) {
      return c.json({ error: `wrote ${written.path} but reloading the agents failed: ${String(err)}`, plain: "Saved, but the agents could not load it yet. Whoever looks after them can see why." }, 400);
    }

    deps.audit.record({
      action: "skill_edited",
      actor: principal.actor,
      details: { skill: name, path: written.path, bytes: source.length },
    });
    return c.json({ ok: true, skill: name, path: written.path } satisfies { ok: true; skill: string; path: string });
  });

  /**
   * Switch one skill off — or back on — for every agent at once.
   *
   * The other axis from `POST /skills/:name/agents/:agentId`, which writes one cell of one pack. A
   * built-in has no other removal: it ships inside the executable, so `DELETE` refuses it and a
   * deletion would be undone by the next upgrade. Fanning `false` out across every pack would not be
   * off either — it would be off for the agents that existed when the button was pressed.
   *
   * The reload is what makes it take effect now: the registry reads `[skills] off` through a closure
   * on every pack load, so the switch applies from the next message rather than the next restart.
   */
  control.post("/skills/:name/global", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);

    const name = c.req.param("name");
    if (!(await pool(deps)).some((skill) => skill.name === name)) {
      return c.json({ error: "no such skill", name }, 404);
    }
    const payload = await jsonBody(c);
    if (!payload || typeof payload.off !== "boolean") {
      return c.json({ error: "`off` must be true or false" }, 400);
    }

    const saved = await deps.settings.setSkillOffGlobally({ name, off: payload.off, actor: principal.actor });
    if (!saved.ok) return c.json({ error: saved.error, plain: NOT_SAVED }, 400);

    try {
      await deps.registry.reloadAll();
    } catch (err) {
      return c.json({ error: `saved but reloading the agents failed: ${String(err)}`, plain: "Saved, but the agents could not load it yet. Whoever looks after them can see why." }, 400);
    }
    return c.json({ ok: true, skill: name, off: payload.off } satisfies { ok: true; skill: string; off: boolean });
  });

  /**
   * What a skill ships beside its body.
   *
   * Read-only and cheap, so no role gate: a viewer who can already read `SKILL.md` learns nothing
   * new from knowing a `references/` file exists next to it. Every entry says whether the body
   * points at it, which is the fact that turns a list into something actionable — 1.2MB of a 1.7MB
   * pool turned out to be screenshots nothing referenced.
   */
  control.get("/skills/:name/files", async (c) => {
    const name = c.req.param("name");
    const found = (await pool(deps)).find((skill) => skill.name === name);
    if (!found) return c.json({ error: "no such skill", name }, 404);
    return c.json({
      name,
      scope: found.scope,
      // A built-in's files are readable and never writable, for the same reason its body is not:
      // they live inside the executable's directory and an upgrade would undo the change.
      editable: found.scope !== "builtin" && Boolean(deps.settings),
      files: await listSupportFiles(deps.ctx.config.daemon.agentsDir, name),
    } satisfies { name: string; scope: string; editable: boolean; files: { path: string; bytes: number; kind: "markdown" | "script" | "text" | "binary"; editable: boolean; referenced: boolean }[] });
  });

  /** One support file as text. Binaries are listed and deleted, never read. */
  control.get("/skills/:name/files/read", async (c) => {
    const name = c.req.param("name");
    const path = c.req.query("path") ?? "";
    if (!(await pool(deps)).some((skill) => skill.name === name)) {
      return c.json({ error: "no such skill", name }, 404);
    }
    const result = await readSupportFile(deps.ctx.config.daemon.agentsDir, name, path);
    return result.ok ? c.json({ name, path, kind: result.kind, source: result.text } satisfies { name: string; path: string; kind: string; source: string }) : c.json({ error: result.error, plain: "This file could not be opened." }, 400);
  });

  /**
   * Replace one markdown support file.
   *
   * Markdown only, and the reason is provenance rather than danger: a script is shipped *because it
   * ran and worked*, and one edited here has by construction never run. The refusal says so.
   */
  control.post("/skills/:name/files/write", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const name = c.req.param("name");
    const found = (await pool(deps)).find((skill) => skill.name === name);
    if (!found) return c.json({ error: "no such skill", name }, 404);
    if (found.scope === "builtin") {
      return c.json({ error: "built-in skills ship with Nouride and cannot be edited", name }, 400);
    }

    const payload = await jsonBody(c);
    const path = payload && typeof payload.path === "string" ? payload.path : "";
    const source = payload && typeof payload.source === "string" ? payload.source : null;
    if (source === null) return c.json({ error: "`source` must be a string" }, 400);

    const written = await writeSupportFile(deps.ctx.config.daemon.agentsDir, name, path, source);
    if (!written.ok) return c.json({ error: written.error, plain: NOT_SAVED, name, path }, 400);

    // Every agent: a support file is read by whoever follows the body's pointer, and the pool is
    // shared. Skipping the reload would leave the old text being served from cached packs.
    try {
      await deps.registry.reloadAll();
    } catch (err) {
      return c.json({ error: `wrote ${path} but reloading the agents failed: ${String(err)}`, plain: "Saved, but the agents could not load it yet. Whoever looks after them can see why." }, 400);
    }
    deps.audit.record({
      action: "skill_file_written",
      actor: principal.actor,
      details: { skill: name, path, bytes: source.length },
    });
    return c.json({ ok: true, skill: name, path } satisfies { ok: true; skill: string; path: string });
  });

  /**
   * Remove one support file — any kind, including a script or a binary.
   *
   * Deleting is the operation the pool most needed and had none of: the only remover was the
   * `skill_improve` tool's `remove_files`, which is an agent's verb. `wasReferenced` comes back so
   * the caller can say that the body now points at nothing — that is a real state, not a
   * hypothetical: `x-twitter-poster` already names a `tools/.env` that does not exist.
   */
  control.delete("/skills/:name/files", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const name = c.req.param("name");
    const path = c.req.query("path") ?? "";
    const found = (await pool(deps)).find((skill) => skill.name === name);
    if (!found) return c.json({ error: "no such skill", name }, 404);
    if (found.scope === "builtin") {
      return c.json({ error: "built-in skills ship with Nouride, so nothing in them can be removed", name }, 400);
    }

    const removed = await deleteSupportFile(deps.ctx.config.daemon.agentsDir, name, path);
    if (!removed.ok) return c.json({ error: removed.error, plain: NOT_CHANGED, name, path }, 400);

    try {
      await deps.registry.reloadAll();
    } catch (err) {
      return c.json({ error: `removed ${path} but reloading the agents failed: ${String(err)}`, plain: "Removed, but the agents could not load again yet. Whoever looks after them can see why." }, 400);
    }
    deps.audit.record({
      action: "skill_file_deleted",
      actor: principal.actor,
      details: { skill: name, path, was_referenced: removed.wasReferenced },
    });
    return c.json({ ok: true, skill: name, path, wasReferenced: removed.wasReferenced } satisfies { ok: true; skill: string; path: string; wasReferenced: boolean });
  });

  /**
   * Delete a skill from the pool — the directory, and everything in it.
   *
   * **Built-in skills are refused**, and the refusal is the interesting part. They ship inside the
   * executable's `skills/` directory, so on a packaged install the file is not the operator's to
   * delete and on a source checkout it is version-controlled — either way, removing it here would be
   * undone by the next upgrade while looking permanent in the meantime. Switching it off per agent
   * is the operation that actually exists for them, and the error says so.
   *
   * Operator, not admin. A skill is instructions, not a permission: the worst a deletion can do is
   * make the agents forget a procedure that is recoverable from the audit log and from git, which is
   * the same blast radius as switching it off everywhere.
   */
  control.delete("/skills/:name", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const name = c.req.param("name");
    const found = (await pool(deps)).find((skill) => skill.name === name);
    if (!found) return c.json({ error: "no such skill", name }, 404);
    if (found.scope === "builtin") {
      return c.json(
        {
          error:
            "built-in skills ship with Nouride and cannot be deleted. Switch it off for the agents that should not carry it",
          name,
        },
        400,
      );
    }

    const removed = await deletePoolSkill(deps.ctx.config.daemon.agentsDir, name);
    if (!removed.ok) return c.json({ error: removed.error, plain: NOT_CHANGED, name }, 400);

    /**
     * Every agent, like `skill_create` — and for the mirror-image reason.
     *
     * A pooled skill is in all of their prompts, so reloading one pack would leave the other five
     * advertising a file that is no longer on disk. The agent would read the path it was given and
     * be told the file does not exist, with nothing connecting that to a deletion.
     */
    try {
      await deps.registry.reloadAll();
    } catch (err) {
      return c.json({ error: `deleted ${removed.path} but reloading the agents failed: ${String(err)}`, plain: "Removed, but the agents could not load again yet. Whoever looks after them can see why." }, 400);
    }

    deps.audit.record({
      action: "skill_deleted",
      actor: principal.actor,
      details: { skill: name, path: removed.path },
    });
    return c.json({ ok: true, skill: name, path: removed.path } satisfies { ok: true; skill: string; path: string });
  });

  /**
   * Switch one skill on or off for one agent.
   *
   * One cell of the matrix, because that is what the operator clicks. The whole state map still goes
   * to disk — the merge happens here against the loaded pack, which is the same state the page was
   * rendered from.
   */
  control.post("/skills/:name/agents/:agentId", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const name = c.req.param("name");
    const agentId = c.req.param("agentId");
    const agent = deps.registry.get(agentId);
    if (!agent) return c.json({ error: `no agent "${agentId}"` }, 404);

    const known = await pool(deps);
    if (!known.some((skill) => skill.name === name)) {
      return c.json({ error: "no such skill", name }, 404);
    }

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be true or false" }, 400);
    }

    const result = await deps.settings.saveAgentSkills({
      packDir: agent.dir,
      reload: () => deps.registry.reload(agentId),
      agentId,
      changes: { [name]: body.enabled },
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true, skill: name, agentId, enabled: body.enabled } satisfies { ok: true; skill: string; agentId: string; enabled: boolean });
  });
}

/** The tools an agent's skills can count on: its own, or — a coding CLI answering it — the CLI's (`toolsOfCli`). */
const toolsHeld = (agent: LoadedAgent): readonly string[] => (agent.config.external ? toolsOfCli(agent.config.tools.enabled) : agent.config.tools.enabled);

/** What the agent lacks of a skill's tools: what a pack edit would give it, and — a coding CLI's — what nothing will. */
function toolsGap(agent: LoadedAgent, skill: Skill): { missingTools: string[]; notForCli?: string[] } {
  const missing = missingToolsFor(skill, toolsHeld(agent));
  const never = agent.config.external ? missing.filter(neverForCli) : [];
  return never.length > 0 ? { missingTools: missing.filter((tool) => !never.includes(tool)), notForCli: never } : { missingTools: missing };
}

/**
 * Everything in the pool and everything built in, as one list, by the prompt's rules (`agentSkillPool`): a pool skill
 * shadows a built-in of the same name, so the Workshop offers no row the prompt would never render. States are
 * applied per agent later.
 */
async function pool(deps: ControlDeps): Promise<PoolSkill[]> {
  return await agentSkillPool({
    poolDir: skillsDirFor(deps.ctx.config.daemon.agentsDir),
    builtinDir: deps.builtinSkillsDir,
    states: {},
    offGlobally: deps.ctx.config.skills.off,
  });
}

/** The pool joined with every agent's switch. */
async function catalog(deps: ControlDeps, agents: LoadedAgent[]): Promise<CatalogEntry[]> {
  const listed = await pool(deps);

  const usage = deps.audit.skillReads(listed.map((skill) => skill.path));

  return listed.map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    path: skill.path,
    requires: skill.requires ?? [],
    missing: missingFor(skill),
    needsTools: skill.needsTools ?? [],
    /**
     * Off for everyone, whatever the packs say — `[skills] off`.
     *
     * Reported beside the per-agent row rather than folded into it. A row reading "on for nero" and
     * "off globally" is confusing only until you know that the second is the operator's answer and
     * the first is nero's; collapsing them would hide *why* the skill is not loaded, which is the
     * one thing somebody looking at this page needs.
     */
    offGlobally: skill.offGlobally,
    agents: agents.map((agent) => ({
      id: agent.config.id,
      displayName: agent.config.displayName,
      enabled: skillEnabled(agent.config.skills, skill, agent.config.id),
      ...toolsGap(agent, skill),
      // Whether the agent's `skills.toml` says anything about it, so the Workshop can tell "on
      // because nobody has decided" from "on because somebody chose that".
      decided: skill.name in agent.config.skills,
    })),
    lastUsedAt: usage.get(skill.path)?.readAt ?? null,
  }));
}
