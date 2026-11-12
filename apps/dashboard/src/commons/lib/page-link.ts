/**
 * Whether a link in what an agent wrote opens a page of this dashboard, and which one.
 *
 * An agent that knows the page a person has open (`floating-chat/page-open.ts`) answers "take me there" with a link to
 * another one: a path, `/dashboard/memories/graph`, or this dashboard's own address in full. A path was drawn as its
 * label alone, since only `http(s)` is ever an `href` (`Markdown.tsx`), and the full address opened a second tab on the
 * dashboard the person was already in.
 */

import { safeNext } from "./session";

/**
 * The page a link names, as the router takes it (under the dashboard, with its query and its place on the page), or
 * null where it names none: another site, another part of this one (the daemon's own routes), or not an address.
 *
 * Read as the browser would read it, and only then held to the dashboard: `/dashboard/../api/…`, a backslash and
 * `//host` are each another place once a browser has them, whatever the text began with.
 */
export function pageInDashboard(href: string, at: { origin: string; basepath: string }): string | null {
  if (!/^(\/|https?:\/\/)/i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, `${at.origin}/`);
  } catch {
    return null;
  }
  if (url.origin !== at.origin) return null;
  const base = at.basepath.replace(/\/+$/, "");
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  return safeNext(`${url.pathname.slice(base.length) || "/"}${url.search}${url.hash}`);
}
