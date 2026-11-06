/**
 * The bundled gateway's own API, reached through this daemon at `<mount>/api/*`.
 *
 * On a `router` or `pro` build with the gateway on, the daemon hands these requests to the gateway in its own
 * process, as the person already signed in here (`engine/src/modules/web/llm-gateway.ts`) — so there
 * is no second login and no key. Only the calls the setup wizard's sign-in step needs live here; the
 * LLM Gateway page is the gateway's own frontend and makes its own.
 *
 * The shapes are the gateway's (`nougate/apps/backend/src/router/admin.ts`), restated narrowly: what
 * this side reads, nothing more.
 */

import { post, request } from "@/commons/lib/api.client";

/** How an account is added — the gateway's `accountFlow`, read off each provider. */
export type AccountFlow = "oauth-redirect" | "device-code" | "api-key" | "oauth-token";

/**
 * What a sign-in screen says about a provider, in the provider's own words — the gateway's
 * `AccountCopy`. This side draws whatever it is given and knows no provider by name.
 */
export interface AccountCopy {
  label: string;
  hint: string;
  order: number;
  title?: string;
  intro?: string;
  button?: string;
  consent?: string;
  pasteLabel?: string;
  pastePlaceholder?: string;
}

export interface GatewayProvider {
  id: string;
  displayName: string;
  accountCount: number;
  /** Null when the gateway sets no cap. */
  accountLimit: number | null;
  isCustom: boolean;
  /** Absent from a gateway older than the field, which the wizard reads as "not offered here". */
  accountFlow?: AccountFlow | null;
  /** Absent or null: listed under `displayName`, with neutral words. */
  accountCopy?: AccountCopy | null;
}

/** What starting a sign-in answers: an address to open, or a code to enter somewhere. */
export interface SignInStart {
  redirectUrl?: string;
  step?: "device_flow";
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  /** Seconds between polls, as the issuer asked. */
  interval?: number;
}

export interface DevicePoll {
  status: "success" | "pending" | "expired";
  error?: string;
  account?: { email?: string; label?: string };
}

/**
 * Exchanging a code is several round trips upstream — token, profile, sometimes quota — and on a
 * small box that can outlast the client's usual fifteen seconds without anything being wrong.
 */
const EXCHANGE_TIMEOUT_MS = 60_000;

function providerPath(mount: string, id: string): string {
  return `${mount}/api/providers/${encodeURIComponent(id)}`;
}

export function gatewayApi(mount: string) {
  return {
    providers: () => request<GatewayProvider[]>(`${mount}/api/providers`),
    /** OAuth providers answer with `redirectUrl`; device-code providers with a code to enter. */
    startSignIn: (id: string) => post<SignInStart>(`${providerPath(mount, id)}/accounts/add`, {}),
    finishOAuth: (id: string, code: string, state?: string) =>
      post<{ success?: boolean; email?: string; error?: string }>(
        `${providerPath(mount, id)}/accounts/add`,
        { code, ...(state ? { state } : {}) },
        { timeoutMs: EXCHANGE_TIMEOUT_MS },
      ),
    /** `oauth-token`: a token the person got from the provider, pasted as the account's credential. */
    pasteToken: (id: string, token: string) =>
      post<{ id?: string; error?: string }>(`${providerPath(mount, id)}/accounts/add`, { apiKey: token }, { timeoutMs: EXCHANGE_TIMEOUT_MS }),
    pollDevice: (id: string, deviceCode: string) =>
      request<DevicePoll>(`${providerPath(mount, id)}/device-status?device_code=${encodeURIComponent(deviceCode)}`, {
        timeoutMs: EXCHANGE_TIMEOUT_MS,
      }),
  };
}

/**
 * Where to send the browser for a sign-in the gateway started.
 *
 * Most providers answer with the issuer's own address. One answers with a path of the gateway's —
 * Antigravity's `/oauth/start`, which redirects to Google — and a path is relative to whoever serves
 * the gateway: under this daemon that is the mount, not this origin's root.
 */
export function signInHref(mount: string, redirectUrl: string): string {
  return redirectUrl.startsWith("/") && !redirectUrl.startsWith("//") ? `${mount}${redirectUrl}` : redirectUrl;
}

/**
 * The code and state out of whatever was pasted back from an OAuth tab.
 *
 * The issuer redirects to a `localhost` address the gateway registered, which on a box is the
 * person's own machine — so the tab fails to load and its address is what they copy. Some issuers
 * show the code on a page instead. Both are accepted: a URL is read for `code` and `state`, anything
 * else is taken as the code itself.
 */
export function parsePastedCode(pasted: string): { code: string; state?: string } | null {
  const text = pasted.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text) || text.includes("?")) {
    try {
      const url = new URL(text, "http://localhost");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (code) return { code, ...(state ? { state } : {}) };
    } catch {
      // Not a URL after all — fall through and treat it as the code.
    }
  }
  return { code: text };
}
