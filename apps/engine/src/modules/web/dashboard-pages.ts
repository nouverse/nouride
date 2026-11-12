/**
 * The dashboard's pages, by what its menu calls them: what an agent is told when a person writes to it from the
 * dashboard (`pageNotes` in `pipeline/messages.ts`), so a link it writes opens a page that is there. Asked "take me
 * there", an agent wrote an address from what it remembered of one, or read the source for it on the one box that
 * had the source.
 *
 * The menu is the dashboard's own (`apps/dashboard/src/commons/components/layout/nav.tsx`, `SectionTabs.tsx`, and the
 * Settings page's list). This is held to it, and to the dashboard's routes, by `tests/contracts/dashboard-pages.test.ts`:
 * a page added to the menu and not here fails there. My Box and the LLM Gateway are left out: neither is on every
 * install, and a link to one that is not there opens nothing.
 */

/** Each page of the menu: its name there and its path under the dashboard. A section's page goes by its tab's name. */
export const DASHBOARD_PAGES: readonly (readonly [name: string, path: string])[] = [
  ["Home", "/"],
  ["Chats", "/chat"],
  ["Waiting for you", "/work"],
  ["Automations", "/automations"],
  ["Missions", "/missions"],
  ["Helpers", "/jobs"],
  ["Agents", "/agents"],
  ["Office", "/office"],
  ["Skills", "/skills"],
  ["Connectors", "/mcp"],
  ["Knowledge & Memory", "/memories"],
  ["Memory graph", "/memories/graph"],
  ["People", "/people"],
  ["Groups", "/groups"],
  ["Settings", "/settings"],
  ["Models", "/models"],
  ["Secrets", "/secrets"],
  ["Integrations", "/integrations"],
  ["Web Search", "/web-search"],
  ["Access", "/access"],
  ["Users", "/users"],
  ["My Account", "/account"],
  ["Logs", "/logs"],
  ["Update", "/update"],
];

/** The pages of one thing, opened by its id: what it is, and the path its id goes under. */
export const DASHBOARD_PAGES_OF_ONE: readonly (readonly [what: string, under: string])[] = [
  ["agent", "/agents"],
  ["automation", "/automations"],
  ["mission", "/missions"],
];

/** How the note begins, and by which a conversation that already holds it is told (`pageNotes`). */
export const PAGES_NOTE_START = "(The dashboard's pages, each under /dashboard:";

/**
 * The pages, in one note on a message written from the dashboard, with how a link to one is written. A path, never
 * an address with a host: the person reads the answer in the dashboard, which opens a path of its own in place.
 */
export function pagesNote(): string {
  const pages = DASHBOARD_PAGES.map(([name, path]) => `${name} ${path}`).join(", ");
  const ofOne = DASHBOARD_PAGES_OF_ONE.map(([what, under]) => `one ${what} at ${under}/<its id>`).join(", ");
  return `${PAGES_NOTE_START} ${pages}; ${ofOne}. To take the person to a page, write a link they can click, as [Automations](/dashboard/automations), and only to a page listed here or the one they have open.)`;
}
