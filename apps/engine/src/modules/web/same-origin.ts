/**
 * A write to the control API or the hosted LLM gateway comes from this daemon's own pages, or from no browser at all
 * (S9).
 *
 * Both are signed in by the dashboard's session cookie, and until 0.7.9 the only thing between another site and a
 * POST carrying it was `SameSite=Lax`: right for a cross-site form, and no help against a *same-site* one — a sibling
 * subdomain is the same site, and on a box behind `agents.example.com` that is every other app under the domain. The
 * gateway's page is the sharper case: it holds the credentials of every upstream account, in a frame of this origin.
 *
 * So a write says where it came from, and the browser is the one that says it. `Sec-Fetch-Site` is set by the browser
 * and no page can forge it: `same-origin` is this daemon's own pages, `none` a person typing or a bookmark; anything
 * else — `same-site`, `cross-site` — is another site's page. A browser too old to send it sends `Origin`, compared with
 * the host the request was addressed to; a reverse proxy's `X-Forwarded-Host` stands in for `Host`, and cannot be set
 * by a cross-site page without a preflight this daemon never answers. A request with neither is not from a browser
 * — the CLI, a script with the token — and a cookie it does not carry is not one somebody else's page can borrow.
 *
 * Reads are not asked: a GET changes nothing here, and refusing one would break a link into the dashboard.
 */

/** Methods that change nothing — never refused for where they came from. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Why a request is refused as another site's write, or null when it may go on. */
export function crossSiteWrite(request: Request): string | null {
  if (SAFE_METHODS.has(request.method)) return null;

  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    return site === "same-origin" || site === "none" ? null : `a ${site} request may not change anything here`;
  }

  const origin = request.headers.get("origin");
  if (origin === null) return null;
  // The first proxy's, when there is a chain: the host the browser addressed.
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const addressed = forwarded || (request.headers.get("host") ?? new URL(request.url).host);
  let from: string;
  try {
    from = new URL(origin).host;
  } catch {
    // `Origin: null` — a sandboxed frame, a `data:` page — is somebody else's page by definition.
    return "a request from an opaque origin may not change anything here";
  }
  return from === addressed ? null : `a request from ${origin} may not change anything here`;
}
