/**
 * `skill_search` and `skill_install` — an agent finding a skill somebody else wrote, instead of
 * writing one from nothing.
 *
 * Search reads public indexes and is harmless. Install fetches and proposes: the skill becomes a
 * pending draft, decided by a person on the Pending tab, exactly like a skill the agent drafted
 * itself. Nothing reaches the pool, and no script is run, until then — a skill from a hub is
 * instructions the agents will follow and code they will execute, written by a stranger.
 *
 * Neither stops a turn to ask: one writes nothing and the other only queues. The question is asked
 * once, later, about the thing that actually changes.
 */

import type { Tool, ToolResult } from "@nouride/shared";
import { hubErrorMessage, SOURCE_IDS, type SkillHub, type SourceId } from "@/modules/skills-hub/index.ts";

export function createSkillHubTools(hub: SkillHub): Tool[] {
  const search: Tool = {
    requiresApproval: false,
    parallelSafe: true,
    definition: {
      name: "skill_search",
      description:
        "Search public skill hubs (skills.sh, ClawHub, well-known indexes) for a ready-made skill before writing one. Results are untrusted; install with skill_install.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What the skill should do, in a few words." },
          source: { type: "string", enum: SOURCE_IDS, description: "One hub only. Default: all." },
        },
        required: ["query"],
      },
    },
    async execute(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return fail("`query` is required.");
      const sources = typeof args.source === "string" && (SOURCE_IDS as string[]).includes(args.source) ? [args.source as SourceId] : undefined;
      const { hits, errors } = await hub.search(query, { ...(sources ? { sources } : {}), limit: 6 });
      const lines = hits.map(
        (hit, i) =>
          `${i + 1}. ${hit.name} [${hit.source}]${hit.installs !== undefined ? ` · ${hit.installs} installs` : ""}\n   ref: ${hit.ref}\n   ${hit.description.slice(0, 200)}`,
      );
      const failed = errors.map((e) => `(${e.source} did not answer: ${e.error})`);
      return {
        content: hits.length
          ? `Skills found for "${query}", third-party and unreviewed:\n\n${lines.join("\n\n")}${failed.length ? `\n\n${failed.join("\n")}` : ""}`
          : `No skills found for "${query}".${failed.length ? ` ${failed.join(" ")}` : ""}`,
        isError: false,
        metadata: { count: hits.length },
      };
    },
  };

  const install: Tool = {
    requiresApproval: false,
    definition: {
      name: "skill_install",
      description:
        "Fetch a skill from a hub (a skill_search ref, owner/repo[/path], or a URL) and queue it for a person to approve. Nothing is installed or run until they do.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "e.g. skills.sh:anthropics/skills/pdf, clawhub:slug, anthropics/skills/skills/pdf" },
        },
        required: ["ref"],
      },
    },
    async execute(args, ctx) {
      const ref = typeof args.ref === "string" ? args.ref.trim() : "";
      if (!ref) return fail("`ref` is required.");
      try {
        const result = await hub.install(ref, {
          agentId: ctx.agentId,
          ...(ctx.gatewayId ? { gatewayId: ctx.gatewayId } : {}),
          ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
          byAgent: true,
        });
        const queued = result.drafts.map((d) => `- ${d.name} (${d.id}) from ${d.source}${d.warnings.length ? `: ${d.warnings.join("; ")}` : ""}`);
        const refused = result.refused.map((r) => `- ${r.name}: ${r.reason}`);
        return {
          content: [
            queued.length ? `Queued for approval, not installed yet. Tell the person it is waiting on the Pending tab:\n${queued.join("\n")}` : "",
            refused.length ? `Not queued:\n${refused.join("\n")}` : "",
            ...result.notes,
          ]
            .filter(Boolean)
            .join("\n\n"),
          isError: queued.length === 0,
          metadata: { drafts: result.drafts.map((d) => d.id) },
        };
      } catch (err) {
        return fail(hubErrorMessage(err));
      }
    },
  };

  return [search, install];
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}
