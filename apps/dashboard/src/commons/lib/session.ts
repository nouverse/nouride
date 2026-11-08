/**
 * Who is signed in, and where the app is allowed to send them.
 *
 * Two gates, and they are separate on purpose. **Signed in** is about this browser; **set up** is about
 * this installation. A fresh instance has neither, and the order matters — an operator who lands on a
 * login form before an account exists has nothing they can do, so the wizard runs first and creating the
 * admin is the first thing in it.
 *
 * The redirect decision lives here rather than in each route so there is one description of it. Spread
 * across five components it becomes five subtly different descriptions, and the one that is wrong is
 * always the one guarding something.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Principal, SetupState } from "@nouride/wire";
import { ApiError } from "./api.client";

export interface Gate {
  loading: boolean;
  principal: Principal | null;
  setup: SetupState | null;
  /** Where this visitor belongs, or null if they are already in the right place. */
  redirectTo: string | null;
  /** The daemon is not answering — restarting, most likely. Nobody is signed out for it. */
  offline: boolean;
}

/** While the daemon does not answer, how often to ask again — so the page comes back by itself. */
const RECONNECT_MS = 2_000;

/**
 * Who is signed in: one query, with its options in one place, for the gate and every page that asks.
 *
 * Thirty-seven pages each declared their own, with the default retries and a 5 s staleness, so any of them could
 * refetch it during a restart — and the gate read the failed refetch as signed out.
 */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    // A 401 is the normal state for a visitor who has not signed in, not a failure to retry.
    retry: false,
    staleTime: 30_000,
    refetchInterval: (query) => (sessionFrom(query.state.data, query.state.error).offline ? RECONNECT_MS : false),
  });
}

/**
 * What an answer from `/auth/me` says about the session. Pure, because it is the decision this module gets wrong
 * when it gets one wrong.
 *
 * Only the daemon saying so signs anybody out — a 401 or a 403. A daemon restarting answers 503, or nothing at all
 * (status 0 from `request`), and the cookie is as good as it was: the principal last seen stands, and the page says
 * it is reconnecting. Read as signed out, a restart from Overview, or an update installing, sent whoever switched
 * back to the tab to the login form, and their unsaved edits with it.
 */
export function sessionFrom(data: Principal | undefined, error: unknown): { principal: Principal | null; offline: boolean } {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 401 || status === 403) return { principal: null, offline: false };
  return { principal: data ?? null, offline: unreachable(error) };
}

/**
 * The daemon not answering, as opposed to answering no: nothing came back (status 0), it is starting (503), or a proxy
 * in front of it answered for it — 502 and 504, and Cloudflare's 520–527 for an origin that is down.
 */
function unreachable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const status = error.status;
  return status === 0 || (status >= 502 && status <= 504) || (status >= 520 && status <= 527);
}

export function useGate(pathname: string, search = ""): Gate {
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: api.setupState,
    staleTime: 2_000,
    // Asked again with the session, so a first load during a boot still finds an unfinished install its wizard.
    refetchInterval: (query) => (unreachable(query.state.error) ? RECONNECT_MS : false),
  });
  const me = useMe();

  if (setup.isPending || me.isPending) {
    return { loading: true, principal: null, setup: null, redirectTo: null, offline: false };
  }

  const { principal, offline } = sessionFrom(me.data, me.error);
  const state = setup.data ?? null;
  // Not answering and nobody known yet — a first load during a boot: nowhere to send them, the login form least.
  const redirectTo = offline && !principal ? null : redirectFor(principal, state, pathname, search);
  return { loading: false, principal, setup: state, redirectTo, offline };
}

/** The page a remote MCP server's login comes back to — `redirectUriFor` in the engine's `mcp-oauth/where.ts`. */
export const MCP_LOGIN_CALLBACK = "/oauth/mcp/callback";

/**
 * A page inside the dashboard a sign-in goes on to (`next`, 0.8.11), or null. A link from a chat, opened signed out, went
 * to the login form and then to Overview: the page it named was lost. Only a path: one that starts `//`, or holds a
 * backslash or a control character — which a browser reads as `//` — is another site, and `next` an open redirect;
 * `/login` would loop. The daemon checks the one an OAuth sign-in keeps the same way (`web/links.ts`).
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return null;
  const path = (next.split(/[?#]/)[0] ?? "").toLowerCase();
  return path === "/login" || path.startsWith("/login/") ? null : next;
}

/** The login page's `next`, checked: where its sign-in goes on to. */
export function nextOf(search: string): string | null {
  return safeNext(new URLSearchParams(search).get("next"));
}

/**
 * Where a visitor belongs, or null if they are already there. Pure, so the order can be tested —
 * it is the whole of what this module decides, and it was wrong once (setup before the password).
 * `search` is the address's query, `?…`: a page sent to the login form keeps it in `next`.
 */
export function redirectFor(principal: Principal | null, state: SetupState | null, pathname: string, search = ""): string | null {
  const onLogin = pathname.startsWith("/login");
  const onSetup = pathname.startsWith("/setup");

  // Where an MCP server's login comes back to (0.7.19) stays put signed out: sent to the login form, its address — the
  // code and the state, the whole of the answer — would be gone. The page says how to finish it instead.
  // Any other page goes to the login form with itself as `next`, and is opened once signed in.
  if (!principal) {
    if (onLogin || pathname.startsWith(MCP_LOGIN_CALLBACK)) return null;
    const here = safeNext(`${pathname}${search}`);
    return here && here !== "/" ? `/login?next=${encodeURIComponent(here)}` : "/login";
  }

  // First, before the setup wizard: the account itself. A first-login password (generated, or a
  // box's setup PIN) works once, and the owner asked for "personalize your account" to be the first
  // screen, not a step after models and agents.
  //
  // A generated bootstrap password works once, and replacing it is not optional — so it gets a screen
  // of its own rather than a card on a settings page among other cards. It is also a *set* rather than
  // a change: the old value was printed by the daemon, not chosen by anyone, and the session they are
  // holding was opened with it moments ago. Asking for it again proves nothing.
  //
  // And the only place to be until it is done: falling through here on `/welcome` itself would send
  // an unfinished install straight on to `/setup`, which is the order this replaced.
  if (principal.user?.mustChangePassword) {
    return pathname.startsWith("/welcome") ? null : "/welcome";
  }

  // Signed in but the instance is not finished. Everything else is reachable, but landing anywhere
  // else first shows an empty dashboard with no explanation of what to do about it.
  if (state && !state.complete) {
    return onSetup ? null : "/setup";
  }

  if (onLogin) return nextOf(search) ?? "/";
  return null;
}

export function canWrite(principal: Principal | null): boolean {
  return principal?.role === "admin" || principal?.role === "operator";
}

export function isAdmin(principal: Principal | null): boolean {
  return principal?.role === "admin";
}
