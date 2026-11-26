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

/**
 * The Open agents page's place in the URL, as the Access page keeps its own: which open agent, and which of its three
 * lists. An agent's own Access tab links straight to its people; a reload keeps the view.
 */
const OPEN_TABS = ["wrote", "let-in", "blocked"] as const;
export type OpenAgentsTab = (typeof OPEN_TABS)[number];

export interface OpenAgentsSearch {
  tab?: OpenAgentsTab;
  /** An open agent's id: its people. Another, or none, is the first open agent's. */
  agent?: string;
}

export function parseOpenAgentsSearch(search: Record<string, unknown>): OpenAgentsSearch {
  const tab = OPEN_TABS.find((candidate) => candidate === search.tab);
  const agent = typeof search.agent === "string" && search.agent.trim() ? search.agent.trim() : undefined;
  return { ...(tab ? { tab } : {}), ...(agent ? { agent } : {}) };
}
