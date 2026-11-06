/**
 * `skill_improve` — an agent saying, mid-task, that a skill it just used is wrong.
 *
 * The other half of the learning loop, and the half that arrives with the best information. The
 * reflection pass looks *after* a turn and has to infer what was learned from a transcript; this
 * fires *during* one, from the agent that just read the file and found the step that was missing.
 *
 * Hermes gets this from one line in its system prompt — "patch it immediately with
 * `skill_manage(action='patch')`, don't wait to be asked" — because its agent may write to the
 * library directly. Ours may not, and that is deliberate rather than an omission: the pool is one
 * directory shared by every agent, so one of them rewriting a file silently changes how the other
 * five behave. So the instinct is the same and the destination is different. This tool **proposes**;
 * it never writes. What it raises is the same draft the reflection pass raises, decided by the same
 * person on the same screen.
 *
 * Not approval-gated, and that is the point of routing it through drafts. A tool that writes nothing
 * and blocks nothing should not stop a turn to ask permission — the permission is asked once, later,
 * about the thing that actually changes.
 */

import { createLogger, type Tool, type ToolResult } from "@nouride/shared";
import { skillBodyIsEnglish } from "@nouride/persona";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";

const log = createLogger("tools.skills");

export interface SkillImproveOptions {
  reflection: ReflectionEngine;
}

export function createSkillImproveTool(options: SkillImproveOptions): Tool {
  return {
    /**
     * No approval prompt, and that is the point of routing this through drafts.
     *
     * `skill_create` asks because it writes into a directory every agent reads. This writes nothing:
     * it puts a row in a queue. Stopping a turn to ask permission to *suggest* something would make
     * the agent hesitate to suggest it, which is the opposite of what the tool is for — the
     * permission is asked once, later, about the thing that actually changes.
     */
    requiresApproval: false,
    definition: {
      name: "skill_improve",
      description:
        "Propose a correction to an existing skill you have been using. Use it the moment you find one outdated, incomplete or wrong: a skill nobody maintains becomes a liability. This changes no skill: it raises a draft that a human approves or denies later. By default the call itself also waits for a human to approve it, so send one complete proposal rather than several small ones, but do not hold back a real correction. You cannot improve a skill a person wrote by hand; say what is wrong in your reply instead.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill to improve, exactly as it is named." },
          why: {
            type: "string",
            description:
              "One line for the person who will approve this: what was wrong or missing, and how you found out. Be concrete: this is what they read first.",
          },
          body: {
            type: "string",
            description:
              "The whole improved body, in markdown. Keep everything still true: you are correcting and adding, not rewriting. Somebody who knows this skill should recognise it.",
          },
          description: {
            type: "string",
            description: "Optional: a better one-line trigger. Omit to keep the current one.",
          },
          requires: {
            type: "string",
            description: "Optional: replaces the `requires` line. Programs on THIS host's PATH.",
          },
          needs_tools: {
            type: "string",
            description:
              "Optional: replaces the `needs_tools` line (the Nouride tools the procedure calls, e.g. \"exec, send_file\").",
          },
          files: {
            type: "array",
            description:
              "Optional files to add or replace beside SKILL.md: references/<name> for bulky detail, scripts/<name> for something re-runnable, templates/<name> for a starter file. Only add a script you actually ran and saw work. Point at anything you add from the body.",
            items: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
            },
          },
          replaces: {
            type: "string",
            description:
              "The id of a draft already waiting for this skill, when this body already contains what that draft said. You will be told the id and handed its body if there is one. You cannot guess it, and without it your change would overwrite a lesson nobody has decided on yet.",
          },
          remove_files: {
            type: "array",
            description: "Optional: support files to delete, e.g. a reference that is now wrong.",
            items: { type: "string" },
          },
        },
        required: ["name", "why", "body"],
      },
    },

    async execute(args, ctx) {
      const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
      const why = typeof args.why === "string" ? args.why.trim() : "";
      const body = typeof args.body === "string" ? args.body.trim() : "";

      if (!name) return fail("`name` is required: which skill are you improving?");
      if (!why) return fail("`why` is required: the person deciding reads it before anything else.");
      if (!body) return fail("`body` is required, and it is the whole improved body, not a fragment.");
      if (!skillBodyIsEnglish(body)) {
        return fail(
          "The improved body is not in English. Skills are always in English, whatever language this conversation is in. Rewrite it and call this again.",
        );
      }

      const result = await options.reflection.propose({
        agentId: ctx.agentId,
        gatewayId: ctx.gatewayId,
        chatId: ctx.chatId,
        target: name,
        why,
        body,
        ...(typeof args.description === "string" && args.description.trim()
          ? { description: args.description }
          : {}),
        ...(typeof args.requires === "string" ? { requires: args.requires } : {}),
        ...(typeof args.needs_tools === "string" ? { needsTools: args.needs_tools } : {}),
        ...(readFiles(args.files).length > 0 ? { files: readFiles(args.files) } : {}),
        ...(readPaths(args.remove_files).length > 0 ? { removeFiles: readPaths(args.remove_files) } : {}),
        ...(typeof args.replaces === "string" && args.replaces.trim() ? { replaces: args.replaces.trim() } : {}),
      });

      if (!result.ok) return fail(result.error);

      log.info("skill improvement proposed", { agent_id: ctx.agentId, skill: name });
      return {
        content: `Proposed an improvement to "${name}". It is waiting for a human. Nothing has changed on disk, and you do not need to wait for it. Carry on with the task.`,
        isError: false,
        metadata: { skill: name, draft: result.draft.id },
      };
    },
  };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

function readFiles(raw: unknown): { path: string; content: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, content } = entry as Record<string, unknown>;
    return typeof path === "string" && typeof content === "string" ? [{ path, content }] : [];
  });
}

function readPaths(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}
