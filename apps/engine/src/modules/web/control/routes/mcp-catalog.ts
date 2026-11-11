/**
 * The MCP catalog, for the MCP page's Explore tab and `nouride mcp search` / `nouride mcp add --from` (0.7.19) — asked
 * of Nouverse's (`modules/mcp-registry`), which mirrors the official MCP registry.
 *
 * Read by an operator, as the skills hubs are: it is public data, and what it leads to — adding a server — is the
 * admin-only `POST /agents/:id/mcp`, unchanged. Nothing here writes a pack.
 */

import type { CatalogDraft, McpCatalogCard, McpCatalogPage } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function registerMcpCatalogRoutes(control: ControlApp, deps: ControlDeps): void {
  // Without words: Nouverse's own list, what it pinned first.
  control.get("/mcp/catalog", async (c) => {
    const catalog = deps.mcpCatalog;
    if (!catalog) return c.json({ error: "the MCP catalog is turned off on this install (NOURIDE_MCP_CATALOG_URL is empty)", plain: "Finding new connectors is turned off on this server." }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const query = (c.req.query("q") ?? "").trim();
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
    try {
      const page = await catalog.search(query, limit);
      return c.json({ entries: page.cards, total: page.total, syncedAt: page.syncedAt } satisfies McpCatalogPage);
    } catch (err) {
      return c.json({ error: `the MCP catalog did not answer: ${reason(err)}`, plain: "The list of connectors could not be reached. Try again in a moment." }, 502);
    }
  });

  // By query rather than path: a registry name holds a "/".
  control.get("/mcp/catalog/entry", async (c) => {
    const catalog = deps.mcpCatalog;
    if (!catalog) return c.json({ error: "the MCP catalog is turned off on this install (NOURIDE_MCP_CATALOG_URL is empty)", plain: "Finding new connectors is turned off on this server." }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const name = (c.req.query("name") ?? "").trim();
    try {
      const opened = name ? await catalog.open(name) : undefined;
      if (!opened) return c.json({ error: `no "${name}" in the MCP catalog`, plain: "That connector is not in the list any more." }, 404);
      return c.json({ ...opened.card, result: opened.result } satisfies McpCatalogCard & { result?: { draft: CatalogDraft } | { unsupported: string } });
    } catch (err) {
      return c.json({ error: `the MCP catalog did not give ${name}: ${reason(err)}`, plain: "That connector could not be fetched. Try again in a moment." }, 502);
    }
  });
}
