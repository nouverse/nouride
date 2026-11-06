/**
 * The web tools. Composition only — nothing here fetches anything.
 */

export { createWebFetchTool } from "@/modules/tools/builtins/web/fetch.ts";
export { createWebSearchTool } from "@/modules/tools/builtins/web/search.ts";
export type { WebToolOptions } from "@/modules/tools/builtins/web/shared.ts";
