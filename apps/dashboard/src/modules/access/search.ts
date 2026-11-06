/**
 * The Access page's place in the URL: which tab, and which agent's connections. In the URL so an
 * agent's own Access tab can link straight to its senders, and a reload keeps the view. Anything
 * unrecognised is dropped rather than refused, so an old or hand-typed link still opens the page.
 */

const ACCESS_TABS = ["pending", "approved", "denied", "blocked", "history"] as const;
export type AccessTab = (typeof ACCESS_TABS)[number];

export interface AccessSearch {
  tab?: AccessTab;
  /** An agent id: only the requests that reached its connections. */
  agent?: string;
}

export function parseAccessSearch(search: Record<string, unknown>): AccessSearch {
  const tab = ACCESS_TABS.find((candidate) => candidate === search.tab);
  const agent = typeof search.agent === "string" && search.agent.trim() ? search.agent.trim() : undefined;
  return { ...(tab ? { tab } : {}), ...(agent ? { agent } : {}) };
}
