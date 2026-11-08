/**
 * `skill_root` — an agent asks for a project's folder to be one of its skill roots, or for one to be taken away (0.8.24).
 *
 * A root's `.agents/skills/` become instructions in the agent's own prompt, so whether a repository's skills become
 * the agent's is the same decision as a change to its persona: an approval at every level, `trusted` too, answered in a
 * chat by an admin only (`HardlineClass` `persona`, `approval-answerers.ts`). Before, the agent could only ask the
 * person to edit its `config.toml`, which the file tools refuse it: Nix, asked to add Nouride Home's repository to its
 * own, could not (2026-11-08).
 *
 * The folder is checked before anyone is asked (`setup/skill-roots.ts`): one that could not be added — not there, a
 * file, the credentials folder's, one it has — is refused to the agent, so an admin is never asked a question whose
 * yes would fail. Approved, the change is written as the Files tab's save writes it, audited with the agent's reason;
 * denied, nothing changes. Only the caller's own roots: the agent is `ctx.agentId`, never a parameter.
 */

import type { GateDecision, Tool, ToolContext, ToolResult } from "@nouride/shared";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";
import type { SkillRoots } from "@/modules/setup/skill-roots.ts";

/** A reason is a sentence or two for the admin deciding. */
const MAX_REASON = 600;

interface Request {
  action: "add" | "remove";
  /** As it will be written, or as the agent named it for a removal. */
  path: string;
  reason: string;
  /** What the folder brings, for an addition: the admin decides on these. */
  skills: string[];
}

export function createSkillRootTool(options: { roots: Pick<SkillRoots, "check" | "rootOf" | "skillsAt" | "add" | "remove"> }): Tool {
  /** The request a call makes, checked against the agent's roots as they stand — or why it is not one to ask about. */
  function requestOf(args: Record<string, unknown>, ctx: Pick<ToolContext, "agentId">): Request | { refused: string } {
    const action = args.action === "add" || args.action === "remove" ? args.action : null;
    if (!action) return { refused: "`action` is add or remove" };
    const given = typeof args.path === "string" ? args.path.trim() : "";
    if (!given) return { refused: "`path` is required: the project's folder, the one that holds .agents/skills" };
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) return { refused: "`reason` is required: why, for the admin deciding it" };
    if (reason.length > MAX_REASON) return { refused: `\`reason\` is over ${MAX_REASON} characters: say why in a sentence or two` };
    if (!workTextIsEnglish(reason)) return { refused: writeWorkInEnglish("The reason") };
    if (action === "remove") {
      const root = options.roots.rootOf(ctx.agentId, given);
      if (!root) return { refused: `${given} is not one of your skill roots, so there is nothing to take away` };
      return { action, path: root, reason, skills: [] };
    }
    const checked = options.roots.check(ctx.agentId, given);
    if ("refused" in checked) return { refused: checked.error };
    return { action, path: checked.path, reason, skills: options.roots.skillsAt(checked.path) };
  }

  return {
    requiresApproval: true,
    definition: {
      name: "skill_root",
      description:
        "Ask for a project's folder to be one of your skill roots, so the skills in its .agents/skills are yours, or for one to be " +
        "taken away. An admin approves or denies it in the chat; nothing changes until then.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "remove"] },
          path: { type: "string", description: "The project's folder on this machine, as a full path: the one that holds .agents/skills." },
          reason: { type: "string", description: "Why, for the admin deciding, in English." },
        },
        required: ["action", "path", "reason"],
      },
    },

    gate(args, ctx): GateDecision {
      const request = requestOf(args, ctx);
      if ("refused" in request) return { action: "refuse", reason: request.refused };
      const why = request.reason.replace(/[.!\s]+$/, "");
      const what =
        request.action === "add"
          ? `${ctx.agentId} asks to take the skills in ${request.path} as its own (${request.skills.length > 0 ? request.skills.join(", ") : "none there yet"}): ` +
            "they become instructions it follows, a change to its persona, which an admin alone answers."
          : `${ctx.agentId} asks to stop taking the skills in ${request.path}, a change to its persona, which an admin alone answers.`;
      return { action: "ask", grantable: false, hardline: true, hardlineClass: "persona", reason: `${what} Its reason: ${why}` };
    },

    async execute(args, ctx): Promise<ToolResult> {
      const request = requestOf(args, ctx);
      if ("refused" in request) return { content: request.refused, isError: true };
      // Written only on an admin's yes: every level asks this, so a call with no answer behind it was never put to one.
      if (!ctx.approved) return { content: "Nothing was changed: no admin's answer to this request was found. Ask again.", isError: true };
      const input = { agentId: ctx.agentId, path: request.path, actor: `agent:${ctx.agentId}`, details: { via: "skill_root", reason: request.reason } };
      const done = request.action === "add" ? await options.roots.add(input) : await options.roots.remove(input);
      if (!done.ok) return { content: `Nothing was changed: ${done.error}`, isError: true };
      if (request.action === "remove") return { content: `${done.path} is no longer one of your skill roots, as approved: its skills leave your list from your next turn.`, isError: false };
      return {
        content:
          `${done.path} is one of your skill roots, as approved: ${done.skills.length > 0 ? `its skills (${done.skills.join(", ")}) are` : "the skills it gets later are"} in your list from your next turn. ` +
          "A coding CLI lists them when its next conversation opens (/new in a chat already going).",
        isError: false,
      };
    },
  };
}
