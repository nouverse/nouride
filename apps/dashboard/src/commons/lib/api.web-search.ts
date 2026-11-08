/**
 * The Web Search page: `[security.web]` as four choices, and a test search before saving.
 *
 * Split out of `api.ts` for the reason `api.tool-budget.ts` was: that file is over its line budget.
 * Spread into `api`, so the call sites read `api.webSearch()`.
 */

import { control, post, request } from "./api.client";
import type { WebSearchPatch, WebSearchSettings, WebSearchTest } from "@nouride/wire";

export const webSearchApi = {
  webSearch: () => request<WebSearchSettings>(`${control}/web-search`),
  setWebSearch: (patch: WebSearchPatch) =>
    post<{ ok: true; restartRequired: boolean; settings: WebSearchSettings }>(`${control}/web-search`, patch),
  testWebSearch: (patch: WebSearchPatch) => post<WebSearchTest>(`${control}/web-search/test`, patch),
};
