/**
 * The hosted gateway's own port, once its dashboard is a page of this one: keys only, no sign-in.
 *
 * The gateway keeps a user table of its own and signs people in on its own port. Hosted, that was a second door to
 * every upstream account, with a second password: the first-run one the daemon lent it, which stayed good there after
 * the person changed the daemon's — and, with `HOST` on the LAN, open to the network. Once the daemon serves the
 * gateway's dashboard under its own session, that door has nothing left to open: clients with a gateway key and the
 * daemon's own model calls are what the port is for, and both carry a key, never a cookie.
 *
 * So a sign-in there is refused with where to go instead, and a session cookie is not passed on — one minted before
 * the upgrade stops working with the password that minted it. The key-authenticated routes are untouched.
 *
 * Kept where the gateway can still be its own console: a build whose dashboard bundle cannot be shown inside this
 * one, or a daemon with no dashboard, has no other way in, and closing this one would lock the operator out.
 */

type GatewayFetch = (request: Request) => Response | Promise<Response>;

/** What a person signing in on the gateway's port is told. */
const ELSEWHERE =
  "Sign-in here is off: this gateway runs inside Nouride. Open LLM Gateway in Nouride's dashboard: it is signed in " +
  "with Nouride's own account.";

/**
 * Whether the gateway's own port keeps its sign-in: unless this daemon serves a dashboard and the gateway's bundle can
 * be shown inside it — then the LLM Gateway page is the way in, and the port has nothing left to sign anyone in to.
 */
export function keepsStandaloneLogin(input: { hostedDashboard: boolean; embeddable: boolean }): boolean {
  return !(input.hostedDashboard && input.embeddable);
}

/** The gateway's handler, as its own port serves it while the daemon hosts its dashboard. */
export function withoutStandaloneLogin(fetch: GatewayFetch): GatewayFetch {
  return (request) => {
    const path = new URL(request.url).pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
    if (path === "/api/auth/login") {
      return Response.json({ error: ELSEWHERE, code: "hosted" }, { status: 403 });
    }
    if (!request.headers.has("cookie")) return fetch(request);
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    return fetch(new Request(request, { headers }));
  };
}
