/**
 * The dashboard links the daemon hands a person (0.8.11): one builder for every page, from `[dashboard] public_url`,
 * and none without it — a link that reaches nobody from a phone is the wrong answer the config's type warns about. An
 * agent asked about a mission, a schedule or an approval could not hand the person the page it was on, and six places
 * built an address from `public_url`, each trimming it its own way.
 */

import { isAbsolute, realPath, relative } from "@nouride/runtime";

/** A page a link may open: a closed set, so no caller builds a free path. Every id goes through `encodeURIComponent`. */
export type DashboardPage =
  | { kind: "mission"; id: string }
  | { kind: "schedule"; job?: string }
  | { kind: "overview" }
  | { kind: "agent-cli"; agentId: string }
  | { kind: "mcp-install"; name: string; agent: string }
  /** A file of the workspace in the Workspace tab that shows it: an agent's own, or the Agents menu's. `path` as a files view writes one. */
  | { kind: "workspace-file"; agentId: string | null; path: string };

/** `[dashboard] public_url`, trimmed and without a trailing slash; "" where it is not set. */
export function publicBase(dashboard: { publicUrl: string }): string {
  return dashboard.publicUrl.trim().replace(/\/+$/, "");
}

/** A page's address on the dashboard, or null without `public_url` — never `host:port`. */
export function dashboardLink(dashboard: { publicUrl: string }, page: DashboardPage): string | null {
  const base = publicBase(dashboard);
  return base ? `${base}/dashboard${pathOf(page)}` : null;
}

/**
 * A page's path under the dashboard, with no address: what a tool says it made or changed (`ToolResult.page`). Its
 * reader is in the dashboard, so it goes with or without `public_url`, where a link for a chat app does not.
 */
export const pagePath = (page: DashboardPage): string => pathOf(page);

function pathOf(page: DashboardPage): string {
  const at = encodeURIComponent;
  switch (page.kind) {
    case "mission":
      return `/missions/${at(page.id)}`;
    case "schedule":
      return page.job ? `/automations/${at(page.job)}` : "/automations";
    case "overview":
      return "/";
    case "agent-cli":
      return `/agents/${at(page.agentId)}/cli`;
    case "mcp-install":
      return `/mcp?install=${at(page.name)}&agent=${at(page.agent)}`;
    case "workspace-file":
      return `${page.agentId === null ? "/workspace" : `/agents/${at(page.agentId)}/workspace`}?path=${at(page.path)}`;
  }
}

/** `file`'s parts under `folder`, or null where it is not in it. */
function partsUnder(folder: string, file: string): string[] | null {
  const path = relative(folder, file);
  const outside = path === "" || path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
  return outside ? null : path.split(/[\\/]/).filter(Boolean);
}

/**
 * The Workspace tab that opens a file of the workspace, or null where none does: a file of an agent's own folder opens
 * in that agent's tab, one of the folder the agents share in the Agents menu's. A file anywhere else has no such page,
 * and neither has any file where the install keeps the workspace outside `root`, the folder the files views show: the
 * tab says there that it cannot be looked through.
 */
export function workspaceFilePage(where: { root: string; workspace: string }, file: string): DashboardPage | null {
  // `file` is where a tool found it, every link on the way followed. The two folders are read the same way: written
  // as the config has them, an install under a linked folder would hold no file of its own workspace.
  const shown = partsUnder(realPath(where.root), file);
  const inside = partsUnder(realPath(where.workspace), file);
  if (!shown || !inside) return null;
  const path = shown.join("/");
  if (inside[0] === "private" && inside.length > 2) return { kind: "workspace-file", agentId: inside[1]!, path };
  return inside[0] === "shared" && inside.length > 1 ? { kind: "workspace-file", agentId: null, path } : null;
}

/** The link that opens a file of the workspace, for the reader in a chat: its page where it has one, by the rule for who gets one. */
export function workspaceFileLink(linkFor: LinkFor, where: { root: string; workspace: string }, to: LinkReader, file: string): string | null {
  const page = workspaceFilePage(where, file);
  return page ? linkFor(to, page) : null;
}

/** A page only an admin opens: the Workspace tabs, as System's Files. Its link goes to an admin and to nobody else. */
function adminOnly(page: DashboardPage): boolean {
  return page.kind === "workspace-file";
}

/**
 * A link for a chat, or null where none goes: without `public_url`, and in a DM whose person holds no dashboard
 * account — they get the result and its files anyway. In a group it is written whoever is there; one without an account
 * who opens it gets the login page and nothing more.
 */
function chatLink(dashboard: { publicUrl: string }, page: DashboardPage, reader: { group: boolean; hasAccount: boolean }): string | null {
  return reader.group || reader.hasAccount ? dashboardLink(dashboard, page) : null;
}

/**
 * A page inside the dashboard a sign-in goes on to (`next`), or null. A link opened signed out went to the login form
 * and, once signed in, to Overview: the page it named was lost. Only a path: one that starts `//`, or holds a backslash
 * or a control character — which a browser reads as `//` — is another site, and `next` an open redirect; `/login` would
 * loop. The dashboard checks it the same way (`commons/lib/session.ts`).
 */
export function pathInDashboard(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return null;
  const path = (next.split(/[?#]/)[0] ?? "").toLowerCase();
  return path === "/login" || path.startsWith("/login/") ? null : next;
}

/** Whether a text holds a dashboard link — sent with its preview off, so no card of the login page shows. */
export function holdsDashboardLink(dashboard: { publicUrl: string }, text: string): boolean {
  const base = publicBase(dashboard);
  return base !== "" && text.includes(`${base}/dashboard/`);
}

/** Who a link is for: the chat it goes into and the person there. `chatType` where the caller knows it. */
export interface LinkReader {
  gatewayId: string;
  chatId: string;
  senderId: string;
  chatType?: string;
}

/** What every tool and notice asks — the one rule for whether a link goes into this chat (`chatLink`). */
export type LinkFor = (to: LinkReader, page: DashboardPage) => string | null;

/** The rule, bound to the live config and the install's people and accounts. */
export function linksFor(deps: {
  dashboard: () => { publicUrl: string };
  hasAccount: (who: { gatewayId: string; senderId: string }) => boolean;
  /** Whether this sender is an admin by People. Without it no link to a page only an admin opens is given. */
  isAdmin?: (who: { gatewayId: string; senderId: string }) => boolean;
  chatTypeOf?: (gatewayId: string, chatId: string) => string | undefined;
}): LinkFor {
  return (to, page) => {
    const type = to.chatType ?? deps.chatTypeOf?.(to.gatewayId, to.chatId);
    const group = type === "group" || type === "channel";
    if (adminOnly(page)) {
      // In a group, the one who asked: a page the others cannot open is not handed to them on an admin's word alone.
      // In a DM its person, read as below for a turn the daemon started there.
      const admin = deps.isAdmin?.(to) === true || (!group && deps.isAdmin?.({ gatewayId: to.gatewayId, senderId: to.chatId }) === true);
      return admin ? dashboardLink(deps.dashboard(), page) : null;
    }
    // A DM's person is its sender — or, in a turn the daemon started there (a job's run, a mission it proposed), the chat
    // itself, whose id is its person's where the platform makes it so, as the morning lines read it. The sender alone
    // was the system's id there, and the person holding an account got no link.
    const hasAccount = !group && (deps.hasAccount(to) || deps.hasAccount({ gatewayId: to.gatewayId, senderId: to.chatId }));
    return chatLink(deps.dashboard(), page, { group, hasAccount });
  };
}
