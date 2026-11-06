/**
 * Who is allowed through, and what they may do once they are.
 *
 * One middleware for the whole control API rather than a check per route: a route added later is
 * authenticated and read-only-for-viewers by default, which is the safe direction for a rule nobody
 * will remember to update.
 */

import type { Context, MiddlewareHandler } from "hono";
import { atLeast, identify, type Principal } from "@/modules/users/auth.ts";
import { crossSiteWrite } from "@/modules/web/same-origin.ts";
import type { ControlDeps } from "./types.ts";

/**
 * Routes reachable without a credential.
 *
 * Exactly two, and both exist so the dashboard can render its first screen: logging in, and asking
 * whether this instance has been set up yet. `/setup/state` answers with three booleans and nothing
 * else — an unconfigured instance is not a secret, and the alternative is a browser that cannot tell a
 * fresh install from a locked one and shows a login form nobody can satisfy.
 */
const PUBLIC_PATHS = new Set([
  "/auth/login",
  "/setup/state",
  /**
   * The two halves of an external sign-in, and they have to be public for the obvious reason:
   * nobody is signed in yet. `start` only redirects to the issuer, and `callback` proves nothing on
   * its own — it checks a `state` value against a cookie this daemon set, and then matches the
   * identity to an account that must already exist. Neither creates access on its own.
   */
  "/auth/oauth/start",
  "/auth/oauth/callback",
]);

/**
 * Whether the cookie this response sets should carry `Secure`.
 *
 * `x-forwarded-proto` is honoured because the intended production shape is a reverse proxy
 * terminating TLS. Trusting a header is only safe behind one — which is the same condition under
 * which it is present at all.
 */
export function secureCookies(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  return proto === "https";
}

export function controlGuard(deps: ControlDeps): MiddlewareHandler<{ Variables: { principal: Principal } }> {
  return async (c, next) => {
    // Before anything else, the public routes included: a sign-in posted from another site is a login CSRF (S9).
    const crossSite = crossSiteWrite(c.req.raw);
    if (crossSite) {
      return c.json({ error: "forbidden", note: crossSite, plain: "Nouride turned this down: it came from another website. Open the dashboard at its own address, and try again." }, 403);
    }

    if (PUBLIC_PATHS.has(new URL(c.req.url).pathname.replace(/^\/api\/control/, ""))) {
      return await next();
    }

    const principal = identify({
      tokenHeader: c.req.header("x-nouride-token"),
      cookieHeader: c.req.header("cookie"),
      controlToken: deps.token,
      ...(deps.users ? { users: deps.users } : {}),
    });
    if (!principal) return c.json({ error: "unauthorized" }, 401);

    // A viewer may look at anything and change nothing. Enforced on the method rather than by listing
    // routes: a new route added later is read-only to a viewer by default, which is the safe direction
    // for a rule nobody will remember to update.
    if (c.req.method !== "GET" && !atLeast(principal, "operator")) {
      return c.json({ error: "forbidden", note: "this account is read-only" }, 403);
    }

    c.set("principal", principal);
    await next();
  };
}
