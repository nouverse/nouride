/**
 * The MCP catalog, as the daemon serves it (`routes/mcp-catalog.ts`, 0.7.19): Nouverse's mirror of the official MCP
 * registry, searched — or, without words, its own list — and one entry with the form adding it would fill in.
 */

import { control, request } from "./api.client";
import type { CatalogDraft, McpCatalogCard, McpCatalogPage } from "@nouride/wire";

export const mcpCatalogApi = {
  mcpCatalog: (query: string) => request<McpCatalogPage>(`${control}/mcp/catalog?q=${encodeURIComponent(query)}`),
  mcpCatalogEntry: (name: string) =>
    request<McpCatalogCard & { result?: { draft: CatalogDraft } | { unsupported: string } }>(`${control}/mcp/catalog/entry?name=${encodeURIComponent(name)}`),
};
