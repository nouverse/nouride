/**
 * `mcp_search` — an agent finding an MCP server in the official registry for a task it has no tool for (0.7.19).
 *
 * It finds, and it says where to add one; it never adds one. An MCP server is a process this daemon starts, or an
 * endpoint it dials with a credential, under the agent's name and without asking on every call — that is a person's
 * decision, made on the MCP page (or with `nouride mcp add --from`), so the answer ends with the link to make it.
 */

import type { Tool, ToolResult } from "@nouride/shared";
import type { CatalogCard, McpCatalog } from "@/modules/mcp-registry/index.ts";
import type { LinkFor } from "@/modules/web/links.ts";

export function createMcpSearchTool(options: { catalog: McpCatalog; linkFor: LinkFor }): Tool {
  return {
    requiresApproval: false,
    parallelSafe: true,
    definition: {
      name: "mcp_search",
      description: "Search the official MCP registry for a server that gives a tool you lack. You cannot add one: give the person the link to add it.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What the server should do, or its name, in a few words." } },
        required: ["query"],
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { content: "`query` is required.", isError: true };
      let hits: CatalogCard[];
      try {
        hits = (await options.catalog.search(query, 6)).cards;
      } catch (err) {
        return { content: `The MCP catalog did not answer: ${err instanceof Error ? err.message : String(err)}. Try again later.`, isError: true };
      }
      if (hits.length === 0) return { content: `No MCP server in the registry matches "${query}".`, isError: false, metadata: { count: 0 } };
      const lines = hits.map((card, i) => {
        // Configure → MCP, the form filled in and this agent ticked to switch it on. Without a link — no `public_url`,
        // or a DM whose person holds no dashboard account — a bare path opened nothing from a chat: the way there, said.
        const link = options.linkFor(ctx, { kind: "mcp-install", name: card.name, agent: ctx.agentId }) ?? `on the dashboard, Configure → MCP, search "${card.name}"`;
        return `${i + 1}. ${card.title ?? card.name} (${card.name} v${card.version})${describe(card)}\n   ${card.description.slice(0, 200)}\n   add it: ${link}`;
      });
      return {
        content:
          `MCP servers in the official registry for "${query}", published by others and unreviewed. You cannot add one yourself: ` +
          `tell the person what it would give you and send them its link, where they add it (and any key it needs).\n\n${lines.join("\n\n")}`,
        isError: false,
        metadata: { count: hits.length },
      };
    },
  };
}

function describe(card: CatalogCard): string {
  if (card.unsupported) return ` · by ${card.publisher} · cannot run here (${card.blocked?.label ?? "unsupported"}): ${card.unsupported}`;
  const how = card.runsVia === "remote" ? "a remote endpoint" : `runs here through ${card.runsVia}`;
  return ` · by ${card.publisher} · ${how}${card.needs.length ? ` · needs ${card.needs.join(", ")}` : ""}`;
}
