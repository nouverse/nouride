/**
 * The Web Search page: `[security.web]` as four choices, and a test search before saving.
 *
 * Split out of `api.ts` for the reason `api.tool-budget.ts` was: that file is over its line budget.
 * Spread into `api`, so the call sites read `api.webSearch()`.
 */

import { control, post, request } from "./api.client";

export type WebSearchMode = "free" | "brave" | "searxng" | "custom";

export interface WebSearchSettings {
  mode: WebSearchMode;
  endpoint: string;
  /** A secret *name*. The value never leaves the daemon. */
  apiKeySecret: string;
  apiKeyOrigin: "env" | "store" | "missing";
  fallbackEnabled: boolean;
  allowPrivateUrls: boolean;
  /** What a rebuilt `web_search` would use with these settings. */
  effective: "brave" | "searxng" | "free" | "unavailable";
  problem?: string;
  /** What it needs, in the page's words (0.8.23); `problem` is the settings file's, under Details. */
  plain?: string | null;
  /** Saved, and the running tool was built before it: a restart applies it. */
  restartPending: boolean;
  editable: boolean;
}

export interface WebSearchPatch {
  mode: WebSearchMode;
  endpoint?: string;
  apiKeySecret?: string;
  /** A key typed into the form. Stored as a secret under `apiKeySecret` on save; used once on test. */
  apiKeyValue?: string;
  fallbackEnabled?: boolean;
  allowPrivateUrls?: boolean;
}

export interface WebSearchTest {
  ok: boolean;
  ms?: number;
  query?: string;
  source?: string;
  results?: { title: string; url: string }[];
  error?: string;
  /** Why it failed in the page's words (0.8.20), where `error` is the search service's own. */
  plain?: string;
}

export const webSearchApi = {
  webSearch: () => request<WebSearchSettings>(`${control}/web-search`),
  setWebSearch: (patch: WebSearchPatch) =>
    post<{ ok: true; restartRequired: boolean; settings: WebSearchSettings }>(`${control}/web-search`, patch),
  testWebSearch: (patch: WebSearchPatch) => post<WebSearchTest>(`${control}/web-search/test`, patch),
};
