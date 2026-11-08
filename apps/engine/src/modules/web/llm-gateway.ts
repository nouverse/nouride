/**
 * `/llm-gateway/*` — the bundled gateway's dashboard, as a page of this one.
 *
 * On a `router` or `pro` build the LLM gateway runs in this process (`nougate-inproc.ts`) and
 * has a dashboard of its own: accounts, keys, usage. It used to be a second site on a second port with
 * a second password. Now the daemon's dashboard shows it as "LLM Gateway", and this file is the whole
 * of the join: the prefix, the session check, and the hand-over.
 *
 * ## One sign-in, and why it cannot be forged
 *
 * The daemon checks its own session here, then builds a **new** request and hands it to the gateway
 * with `serveAs`, which vouches for that request object and no other. The gateway asks "who is
 * signed in" of the object it was handed (`nougate/…/core/host.ts`), so a request that reached the
 * gateway's own port from the network — whatever it carries — is not one the daemon ever vouched
 * for, and gets the gateway's own login as before.
 *
 * Admins only. The gateway holds the credentials of every upstream account; that is the same tier as
 * Models and Secrets, which are admin-only for the same reason.
 *
 * ## What is not forwarded
 *
 * - The browser's **cookies and credentials**. The daemon's session cookie is a key to the daemon,
 *   and the gateway has no use for it: it is told who is signed in.
 * - The gateway's **own sign-in and OAuth landing routes**. Inside the daemon there is nothing to sign
 *   in to, and the OAuth redirect targets are `localhost` ports the gateway lists for its own port —
 *   a code arrives here only if someone put it in a link. `SameSite=Lax` sends the daemon's cookie on
 *   a cross-site *navigation*, so a GET that stores an account must not be reachable through it.
 *   Accounts are added through the dashboard's API calls instead, which are POSTs the cookie rule
 *   already keeps same-site.
 *
 *   `/oauth/start` is not one of them. It only redirects to the issuer's consent page and stores
 *   nothing, and it is how one provider (Antigravity, for a Google account) starts its sign-in — its
 *   `redirectUrl` is that path, relative to the gateway. Blocking it left "Open sign-in" on a 404.
 */

import type { Context, Hono } from "hono";
import { createLogger } from "@nouride/shared";
import type { EmbeddedGateway } from "@/modules/gateways/nougate-inproc.ts";
import { readCookie, SESSION_COOKIE } from "@/modules/users/auth.ts";
import type { UsersPort } from "@/modules/users/users.store.ts";
import { crossSiteWrite } from "@/modules/web/same-origin.ts";

const log = createLogger("web.llm-gateway");

/** Where the gateway's dashboard lives on this daemon's port. */
export const LLM_GATEWAY_PREFIX = "/llm-gateway";

/** Request headers that stay behind: credentials for the daemon, and the daemon's own host. */
const DROPPED_REQUEST_HEADERS = ["cookie", "authorization", "x-api-key", "x-nouride-token", "host"];

/**
 * Paths of the gateway that are not reachable through the daemon.
 *
 * Its own password sign-in and profile (the person is the daemon's account), and the two OAuth
 * landing routes — see the file header for why a GET that stores an account must stay off this
 * origin. `/api/auth/me` stays: the dashboard asks it who is signed in, and gets the daemon's answer.
 */
const BLOCKED = [
  /^\/api\/auth\/(?!me$)/,
  /^\/oauth-callback$/,
  /^\/callback$/,
];

/**
 * How long a forwarded request may sit silent.
 *
 * The event stream sends nothing between updates and is meant to stay open (`0`, no limit); a
 * Playground completion can think for minutes. The daemon's own routes keep the server's 60 s.
 */
const STREAM_SECONDS = 0;
const LONG_SECONDS = 255;

export interface LlmGatewayDeps {
  gateway: EmbeddedGateway;
  users: UsersPort;
}

/**
 * Where a client on the viewer's network reaches the gateway's API — the address the page was loaded
 * from, at the gateway's port. Absent when that port answers only on this machine, so the page says
 * nothing rather than an address that leads nowhere.
 */
function apiOriginFor(requestUrl: URL, gateway: EmbeddedGateway): string | undefined {
  if (!gateway.reachableFromNetwork) return undefined;
  return `${requestUrl.protocol}//${requestUrl.hostname}:${gateway.port}`;
}

export function mountLlmGateway(app: Hono, deps: LlmGatewayDeps): void {
  app.all(LLM_GATEWAY_PREFIX, (c) => c.redirect(`${LLM_GATEWAY_PREFIX}/frontend/`));

  app.all(`${LLM_GATEWAY_PREFIX}/*`, async (c: Context) => {
    // Another site's page may not write through the session this page holds — it is every upstream account.
    const crossSite = crossSiteWrite(c.req.raw);
    if (crossSite) return c.json({ error: "forbidden", note: crossSite }, 403);

    // A browser session and nothing else. Not `identify()`: that also accepts the CLI's control
    // token, which has no business here, and it is the session alone that this page is about.
    const session = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    const user = session ? deps.users.sessionUser(session) : null;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (user.role !== "admin") return c.json({ error: "admin only" }, 403);

    const outer = new URL(c.req.url);
    const path = outer.pathname.slice(LLM_GATEWAY_PREFIX.length) || "/";
    if (BLOCKED.some((pattern) => pattern.test(path))) return c.json({ error: "not found" }, 404);

    const raw = c.req.raw;
    const headers = new Headers(raw.headers);
    for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
    const hasBody = raw.method !== "GET" && raw.method !== "HEAD";

    // The origin is a placeholder — the gateway routes on the path — but it has to be a URL.
    const inner = new URL(`${path}${outer.search}`, "http://llm-gateway.internal");
    const request = new Request(inner.toString(), {
      method: raw.method,
      headers,
      ...(hasBody ? { body: await raw.arrayBuffer() } : {}),
      // So a closed tab ends the gateway's event stream rather than leaving it writing to nobody.
      signal: raw.signal,
    });

    (c.env as { keepOpen?: (seconds: number) => void } | undefined)?.keepOpen?.(
      path === "/api/sse" ? STREAM_SECONDS : LONG_SECONDS,
    );

    const apiOrigin = apiOriginFor(outer, deps.gateway);
    let response: Response;
    try {
      response = await deps.gateway.serveAs(request, {
        username: user.username,
        basePath: LLM_GATEWAY_PREFIX,
        ...(apiOrigin ? { apiOrigin } : {}),
      });
    } catch (err) {
      log.warn("the gateway failed a dashboard request", { path, error: String(err) });
      return c.json({ error: "the LLM gateway did not answer" }, 502);
    }

    // The gateway answers its own port with `Access-Control-Allow-Origin: *` for API clients. On
    // this origin there are no cross-origin callers to serve, so none of that is passed on.
    const out = new Headers(response.headers);
    for (const name of [...out.keys()]) {
      if (name.startsWith("access-control-")) out.delete(name);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  });
}
