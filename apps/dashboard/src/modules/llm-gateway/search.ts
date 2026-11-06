/**
 * Where inside the gateway's dashboard the LLM Gateway page is, kept in the URL.
 *
 * The gateway's frontend runs in a frame and reports each page it moves to; the page writes it here
 * as `?page=`, so a reload, a bookmark or a link from elsewhere opens the same screen rather than the
 * gateway's overview every time.
 */

export interface GatewaySearch {
  /** A path inside the gateway's dashboard — `/providers/codex`, `/api-keys`. */
  page?: string;
}

/**
 * Only a plain path of the gateway's own: it becomes part of the frame's address, and a value that
 * climbed out of `/frontend` with `..` or named another origin with `//` would frame something else.
 */
const PAGE = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/;

export function parseGatewaySearch(search: Record<string, unknown>): GatewaySearch {
  const page = typeof search.page === "string" ? search.page.trim() : "";
  return page && page !== "/" && PAGE.test(page) ? { page } : {};
}

/** The frame's address for a page, carrying the host's theme so the first paint already matches. */
export function frameSource(mount: string, page: string | undefined, theme: "light" | "dark"): string {
  return `${mount}/frontend${page ?? "/"}?theme=${theme}`;
}
