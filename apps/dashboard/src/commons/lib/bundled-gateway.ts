/**
 * The LLM gateway a build carries, as the dashboard sees it — from what the daemon says it carries and runs
 * (`bundledGateway` in the setup state), never from which edition it is.
 *
 * The daemon runs it in its own process and serves its dashboard through this one, under
 * `bundledGateway.mount` (`/llm-gateway`) — that is the LLM Gateway page, and the API the setup
 * wizard signs accounts in through. Its own port stays loopback by default and is for the daemon's
 * model calls and for clients with a gateway key, not for a browser.
 *
 * Until 2026-10 the wizard filled a provider form with that loopback address and sent the person to
 * the gateway's own console for a key; the mount replaced both, and the helpers that described them
 * went with them.
 */

import type { SetupState } from "@nouride/wire";

/**
 * Where the gateway's dashboard and API are reachable through this daemon — or null.
 *
 * Both halves, for the reason the daemon gives them both: `available` says the gateway is running,
 * `mount` says this daemon serves it. A daemon older than the mount reports the first without the
 * second, and offering the sign-in step there would send every request to a route that is not there.
 */
export function gatewayMount(state: SetupState | null | undefined): string | null {
  const gateway = state?.bundledGateway;
  return gateway?.available && gateway.mount ? gateway.mount : null;
}

/**
 * Where the LLM Gateway page can show the gateway's dashboard — or null.
 *
 * Stricter than `gatewayMount`. The sign-in step needs only the gateway's API, which is in the
 * binary; the page needs the dashboard bundle beside it, and an update before 2026-10-15 replaced the
 * binary and not the bundle. The daemon checks which it has (`dashboard`), and an old bundle is not
 * framed — it would call this daemon's API instead of the gateway's.
 */
export function gatewayDashboard(state: SetupState | null | undefined): string | null {
  return state?.bundledGateway?.dashboard === true ? gatewayMount(state) : null;
}

/**
 * The switch, where the daemon has one: whether the gateway runs, where it would be served, and whether the server's
 * environment holds the switch — or null.
 *
 * Null for a daemon that does not say `carried`: one older than the switch, which offered the gateway only while it
 * ran and has no route to turn it, so a page drawn against it during an update offers nothing to switch. Null too for
 * a build that does not carry it.
 */
export function gatewaySwitch(
  state: SetupState | null | undefined,
): { on: boolean; mount: string | null; locked: boolean; stopping: boolean } | null {
  const gateway = state?.bundledGateway;
  if (gateway?.carried !== true) return null;
  return { on: gateway.available, mount: gateway.mount ?? null, locked: gateway.decidedBy === "environment", stopping: gateway.stopping === true };
}

/**
 * The setup wizard's "Use Nougate": where the gateway is reached, and whether it has to be turned on first — or null
 * where there is nothing to offer: no gateway, or one that is off where only the server can turn it on.
 */
export function gatewayOffer(state: SetupState | null | undefined): { mount: string; on: boolean } | null {
  const running = gatewayMount(state);
  if (running) return { mount: running, on: true };
  const offered = gatewaySwitch(state);
  return offered?.mount && !offered.locked && !offered.on ? { mount: offered.mount, on: false } : null;
}

/** Whether the LLM Gateway page is in the menu: it can show the gateway, or there is a switch on it to turn. */
export function gatewayPage(state: SetupState | null | undefined): boolean {
  return gatewayDashboard(state) !== null || gatewaySwitch(state) !== null;
}

/**
 * A nougate's own console, derived from the provider endpoint pointed at it — or null.
 *
 * The endpoint is `<origin>/openai/v1`; the console is the origin. That is worth offering, because
 * the thing an operator wants next after seeing which models an agent uses is the place those
 * models are configured, and today that means copying a URL out of a description line and editing
 * the path off it.
 *
 * **Null for loopback, and that is the important half.** A provider pointed at `127.0.0.1` is the
 * bundled gateway, which binds loopback deliberately and serves the backend alone — there is no
 * console there, and a link would resolve to the *reader's own machine* rather than the daemon's.
 * A dead link that looks live is worse than no link: it reads as "the console is down".
 *
 * Null for anything that is not a nougate endpoint, because the origin of `api.openai.com/v1` is a
 * marketing site and nothing an operator wanted.
 */
export function nougateConsoleUrl(baseUrl: string): string | null {
  const match = /^(https?:\/\/[^/]+)\/(?:openai|anthropic)\/v1\/?$/.exec(baseUrl.trim());
  const origin = match?.[1];
  if (!origin) return null;
  // `localhost` as well as the literal address: both are the daemon's own host, not the reader's.
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(origin)) return null;
  return origin;
}

/**
 * Whether a provider endpoint is the gateway this daemon hosts — which has no console of its own to
 * link to (`nougateConsoleUrl` says null for loopback) but does have the LLM Gateway page.
 */
export function isBundledEndpoint(baseUrl: string, state: SetupState | null | undefined): boolean {
  const origin = state?.bundledGateway?.baseUrl?.replace(/\/+$/, "");
  return gatewayDashboard(state) !== null && !!origin && baseUrl.trim().startsWith(`${origin}/`);
}
