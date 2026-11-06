/**
 * The MCP catalog, as the daemon serves it (`routes/mcp-catalog.ts`, 0.7.19): Nouverse's mirror of the official MCP
 * registry, searched — or, without words, its own list — and one entry with the form adding it would fill in.
 */

import { control, request } from "./api.client";

/** One page of results, and where the catalog stands. */
export interface McpCatalogPage {
  entries: McpCatalogCard[];
  /** How many match in all. */
  total: number;
  /** When Nouverse last brought its copy of the registry up to date (ISO). */
  syncedAt: string | null;
}

export interface McpCatalogCard {
  name: string;
  version: string;
  title?: string;
  description: string;
  publisher: string;
  /** Its website, or else its repository. */
  link?: string;
  runsVia?: "remote" | "npm" | "pypi" | "docker";
  needs?: string[];
  /** Why this machine cannot run it, instead of `runsVia`: a sentence, with how to fix it. */
  unsupported?: string;
  /** The same for a badge: what it needs (any one), why an installed one cannot be used, or the forms it comes in. */
  blocked?: { needs: ("npx" | "uvx" | "docker")[]; unusable?: Partial<Record<"npx" | "uvx" | "docker", string>>; forms?: string[]; label: string };
  /** Its place in Nouverse's list, when pinned there. */
  pinned?: number;
}

export interface CatalogInput {
  name: string;
  description?: string;
  required: boolean;
}

/** What the daemon would write, as `mcp-registry/draft.ts` builds it. */
export interface CatalogDraft {
  name: string;
  title?: string;
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envInputs?: CatalogInput[];
  secretEnv?: CatalogInput[];
  headers?: Record<string, string>;
  token?: CatalogInput & { header?: string };
  source: string;
  publisher: string;
  runsVia: "remote" | "npm" | "pypi" | "docker";
  notes: string[];
}

export const mcpCatalogApi = {
  mcpCatalog: (query: string) => request<McpCatalogPage>(`${control}/mcp/catalog?q=${encodeURIComponent(query)}`),
  mcpCatalogEntry: (name: string) =>
    request<McpCatalogCard & { result?: { draft: CatalogDraft } | { unsupported: string } }>(`${control}/mcp/catalog/entry?name=${encodeURIComponent(name)}`),
};
