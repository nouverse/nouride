/**
 * Skill authoring and switching — an agent writing down how to do something so it does not have to
 * be re-derived next time, and deciding which of the written-down things it carries.
 *
 * A skill is a directory holding `SKILL.md`: frontmatter with a name and a description, then a body
 * of instructions. Only the frontmatter is loaded at boot; the body is read on demand when a task
 * matches, which is what keeps a dozen skills from filling the context window every turn (§6.3 SPEC).
 *
 * **One pool, switched per agent.** Every skill lives in `agents/skills/`, and every agent can see and switch on any
 * of them — there is no per-agent skills folder, so a procedure worked out once is never re-derived per pack. A skill
 * `skill_create` writes is on for the agent that wrote it (`agents:`), as an approved draft is: one agent's lesson in
 * every other agent's prompt, unasked, is how a box ended up with 37 skills in each. It stays approval-gated, and it
 * is checked like a draft (`draft-lint.ts`) — the agent asked to "save this as a skill" is the other door into the pool.
 */

import { join } from "@nouride/runtime";
import { editSkillStates } from "@/modules/config/config-file.ts";
import { agentSkillPool, skillsDirFor } from "@nouride/persona";
import { createLogger, type Skill, type Tool, type ToolResult } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import {
  skillBodyIsEnglish,
  VALID_SKILL_NAME,
  writeNewSkill,
  type SkillFileInput,
} from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import { draftRefusal } from "@/modules/reflection/draft-lint.ts";

const log = createLogger("tools.skills");

export interface SkillToolOptions {
  registry: AgentRegistry;
  agentsDir: string;
  /**
   * Where the skills that ship with the daemon live, when there are any.
   *
   * Needed so `skill_toggle` can list and switch a built-in skill. Without it the tool would show an
   * agent half of what it carries and refuse to switch the other half, with nothing saying why.
   */
  builtinSkillsDir?: string;
  /** `[skills] off`, read when asked — the operator can change it while the daemon runs. */
  skillsOffGlobally?: () => readonly string[];
  audit?: AuditPort;
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: false, ...(metadata ? { metadata } : {}) };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * `skill_create` — write a new SKILL.md into the pool.
 *
 * Refuses to overwrite. A skill someone has been refining is not something to clobber because a
 * model picked the same name twice, and "create" should never be destructive. Rewriting an existing
 * one is `edit` on its path, which `nouride skills -v` prints.
 */
export function createSkillCreateTool(options: SkillToolOptions): Tool {
  return {
    requiresApproval: true,
    definition: {
      name: "skill_create",
      description:
        "Write a new skill: the procedure for a kind of task, for the next time work like this comes up. A body naming an address, an account or a past session is refused: those belong in memory. On for you; other agents can switch it on, so write it for a reader who is not you. Fails if the name is taken.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Directory name: lowercase, hyphens, e.g. release-checklist",
          },
          description: {
            type: "string",
            description:
              "One line starting \"Use when\" that says which tasks this applies to. It is what you will match against later, not a title, and not what you changed.",
          },
          body: {
            type: "string",
            description:
              "The instructions themselves, in markdown, and **in English**: a skill is read by every agent here and by whoever reviews it, whatever language the conversation was in. Write what you would need to be told to do this well, including the mistakes worth avoiding.",
          },
          requires: {
            type: "string",
            description:
              "Host software the procedure runs, comma-separated (e.g. \"kubectl, dig\"). Checked against THIS host's PATH: a command you run on a remote machine over ssh needs `ssh` here, not the remote's tooling. Surfaced in the dashboard and by `nouride doctor`, so a missing dependency is visible before a task fails on it. Leave empty only if the procedure runs no programs.",
          },
          needs_tools: {
            type: "string",
            description:
              "Nouride tools the procedure calls, comma-separated: `exec` if it runs any shell command, plus every other Nouride tool it calls by name (e.g. read, write, edit, send_file, web_search, web_fetch, delegate, session, nouride, memory_search). A different question from `requires` (that is about the machine, this is about what an agent is allowed to do), and an agent without the tool fails partway through.",
          },
          files: {
            type: "array",
            description:
              "Optional files to ship beside SKILL.md. Use references/<name> for detail too bulky for the body (it is read on demand, the body is not), scripts/<name> for something re-runnable, templates/<name> for a starter file to copy. Only add a script you actually ran and saw work: an untested one presents a guess as a tool. Point at anything you add from the body, or nobody will find it.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "references/foo.md, scripts/check.py, templates/config.toml" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["name", "description", "body"],
      },
    },

    async execute(args, ctx) {
      const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
      if (!VALID_SKILL_NAME.test(name)) {
        return fail(
          `"${name}" is not a valid skill name: lowercase letters, digits and hyphens, starting with a letter, 2–48 characters.`,
        );
      }
      if (typeof args.description !== "string" || !args.description.trim()) {
        return fail("`description` is required: it is how you will find this skill later.");
      }
      if (typeof args.body !== "string" || !args.body.trim()) {
        return fail("`body` is required: a skill with no instructions is not a skill.");
      }
      // Refused rather than accepted-and-flagged: the agent is right here and can rewrite it in one
      // step, which is the cheapest moment this will ever be fixable.
      if (!skillBodyIsEnglish(args.body)) {
        return fail(
          "This skill is not written in English. Skills are always in English, whatever language the conversation is in: every agent here reads them, and so does whoever reviews this one. Rewrite the body in English and call this again.",
        );
      }

      // The checks a draft gets: the agent is here and can rewrite it now, the cheapest moment it will ever be fixable.
      const refusal = draftRefusal({ description: args.description, body: args.body, descriptionChanged: true });
      if (refusal) {
        return fail(
          `Not written: ${refusal}. A skill is the procedure for a kind of task, written so it works the next time: leave out this task's details. Rewrite it and call this again.`,
        );
      }
      // Rendered and written by `skill-writer.ts`, which the RSI approval path also calls — so a
      // skill an agent writes and a skill a human approved are the same file, field for field.
      const files = readFiles(args.files);
      const written = await writeNewSkill(options.agentsDir, {
        name,
        description: args.description,
        ...(typeof args.requires === "string" && args.requires.trim() ? { requires: args.requires } : {}),
        ...(typeof args.needs_tools === "string" && args.needs_tools.trim()
          ? { needsTools: args.needs_tools }
          : {}),
        body: args.body,
        author: ctx.agentId,
        agents: ctx.agentId,
        ...(files.length > 0 ? { files } : {}),
      });
      if (!written.ok) return fail(written.error);
      const path = written.path;

      /**
       * Every agent is reloaded, not only the author: each lists the pool, and `skill_toggle` on a sibling must find the
       * new skill there to switch it on.
       */
      try {
        await options.registry.reloadAll();
      } catch (err) {
        return fail(`Wrote ${path} but reloading failed: ${String(err)}`);
      }

      options.audit?.record({
        action: "skill_created",
        agentId: ctx.agentId,
        actor: ctx.senderId,
        details: { skill: name, path },
      });
      log.info("skill created", { agent_id: ctx.agentId, skill: name, path });

      return ok(
        `Created skill "${name}" in the shared pool${files.length > 0 ? ` with ${files.length} support file(s)` : ""}, on for you from the next message. Another agent switches it on with skill_toggle; the operator with \`nouride skills on ${name} <agent>\`.`,
        { skill: name, path, ...(files.length > 0 ? { files: files.map((file) => file.path) } : {}) },
      );
    },
  };
}

/**
 * `skill_toggle` — list what exists, and switch one on or off for *this* agent.
 *
 * Listing is half the tool and not an afterthought. The system prompt names only the skills that are
 * already on, so without a listing an agent could never switch one back on: it would have no way to
 * learn the name of something it is not carrying. Called with no arguments, this answers "what is
 * there, and what am I holding".
 *
 * Writes `agents/<id>/skills.toml` and never `config.toml` — see `AgentConfig.skills`.
 */
export function createSkillToggleTool(options: SkillToolOptions): Tool {
  return {
    requiresApproval: true,
    definition: {
      name: "skill_toggle",
      description:
        "List every skill that exists and whether it is on for you, or switch one on or off for yourself. Call with no arguments to see the list, including skills you are not carrying. Other agents are unaffected. By default every call, listing included, waits for a human to approve it; the `nouride` tool with `{\"args\": [\"skills\", \"--all\"]}` also lists them.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill to switch. Omit to list without changing anything.",
          },
          enabled: {
            type: "boolean",
            description: "true to switch it on for you, false to switch it off.",
          },
        },
        required: [],
      },
    },

    async execute(args, ctx) {
      const agent = options.registry.get(ctx.agentId);
      if (!agent) return fail(`No agent "${ctx.agentId}" is loaded.`);

      // By the prompt's own rules: listed with both the shared and the built-in copy of an overridden skill, and
      // `[on]` for a skill the operator had switched off everywhere, the listing disagreed with the prompt it describes.
      const listed = await agentSkillPool({
        poolDir: skillsDirFor(options.agentsDir),
        builtinDir: options.builtinSkillsDir,
        states: agent.config.skills,
        offGlobally: options.skillsOffGlobally?.() ?? [],
        agent: ctx.agentId,
      });

      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return ok(renderList(listed), { skills: listed.length });

      const target = listed.find((skill) => skill.name === name);
      if (!target) {
        return fail(
          `There is no skill called "${name}". These exist:\n${renderList(listed)}\n\nWrite a new one with skill_create.`,
        );
      }
      if (typeof args.enabled !== "boolean") {
        return fail(
          `\`enabled\` is required when you name a skill: true switches "${name}" on for you, false switches it off.`,
        );
      }

      const enabled = args.enabled;
      // Its own switch cannot bring it back, so switching it on would promise a prompt it will not reach.
      if (target.offGlobally && enabled) {
        return fail(
          `"${name}" is switched off for every agent by the operator ([skills] off in config.toml), and your own switch does not override that. Nothing changed.`,
        );
      }
      if (target.enabled === enabled) {
        return ok(`"${name}" is already ${enabled ? "on" : "off"} for you. Nothing changed.`);
      }

      // This agent only: the file belongs to the pack, and one agent's decision must not move
      // another's. `reloadAll` in `skill_create` is the opposite case — a new file everyone can see.
      // Merged under the pack's lock, in turn with the Workshop's saves of the same file.
      const saved = await editSkillStates({
        packDir: join(options.agentsDir, ctx.agentId),
        changes: { [name]: enabled },
        reload: () => options.registry.reload(ctx.agentId),
      });
      if (!saved.ok) return fail(saved.error);

      options.audit?.record({
        action: "skill_toggled",
        agentId: ctx.agentId,
        actor: ctx.senderId,
        details: { skill: name, enabled },
      });
      log.info("skill toggled", { agent_id: ctx.agentId, skill: name, enabled });

      return ok(
        enabled
          ? `Switched "${name}" on for you: it is in your prompt from the next message.`
          : `Switched "${name}" off for you. Other agents still have it; switch it back on any time.`,
        { skill: name, enabled },
      );
    },
  };
}

/**
 * The listing an agent reads.
 *
 * `on`/`off` before the name rather than after it, because the model is scanning for the ones it does
 * not have — and the description is what tells it whether switching one on is worth doing.
 */
function renderList(
  skills: { enabled: boolean; offGlobally: boolean; name: string; description: string; scope: Skill["scope"] }[],
): string {
  if (skills.length === 0) return "There are no skills yet. skill_create writes the first one.";

  return skills
    .map(
      (skill) =>
        `- [${skill.enabled && !skill.offGlobally ? "on" : "off"}] ${skill.name}${skill.scope === "builtin" ? " (built in)" : ""}${skill.offGlobally ? " (off for every agent)" : ""}: ${skill.description || "(no description)"}`,
    )
    .join("\n");
}

/** The `files` argument, shaped. Anything malformed is dropped; the writer validates the paths. */
function readFiles(raw: unknown): SkillFileInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, content } = entry as Record<string, unknown>;
    return typeof path === "string" && typeof content === "string" ? [{ path, content }] : [];
  });
}
