/**
 * What the engine knows about external sign-in — which is deliberately little.
 *
 * The **flow** lives in `internals/pro/oauth`, outside this source tree, so that
 * `--external nouride-oauth` can genuinely remove it from a build. A binary
 * that is not a Pro edition does not contain that code, which is the
 * difference between a feature switched off and a feature that is not there.
 * The same boundary `packages/wa-bridge` draws for Baileys.
 *
 * What stays here is everything that is a **property of the config** rather
 * than of the flow: whether this install is configured for it, and where the
 * provider should send the browser back. Both are pure functions of
 * `[dashboard]`, both are needed by `/setup/state` on every edition, and
 * neither is worth a dynamic import.
 */

import { createLogger, type DashboardSection } from "@nouride/shared";
import { publicBase } from "@/modules/web/links.ts";

const log = createLogger("users.oidc");

/** The cookie the flow uses. Named here because the callback route clears it. */
export const OIDC_FLOW_COOKIE = "nouride_oidc";

/**
 * Whether this install is configured for external sign-in.
 *
 * Four things, and an install missing any of them shows a password form and
 * nothing else. `publicUrl` is in the list because without it the redirect URI
 * is a guess, and a guessed redirect URI fails at the provider with an error
 * about a mismatch — after the user has already logged in, which is the least
 * useful moment to find out.
 *
 * **Says nothing about whether this build can do it.** That is
 * {@link oauthSupported}, and `/setup/state` needs both.
 */
export function oauthReady(dashboard: DashboardSection | undefined): boolean {
  // `undefined` rather than a required section, because this is asked from
  // `/setup/state` — the one route that answers before anything is configured.
  if (!dashboard?.oauth) return false;
  const { oauth, publicUrl } = dashboard;
  return Boolean(oauth.issuer && oauth.clientId && oauth.secretName && publicUrl?.trim());
}

/**
 * Where the provider sends the browser back.
 *
 * Built once, from `[dashboard] public_url`, because the provider compares it
 * byte-for-byte against the URL it has registered *and* against the one sent
 * again at the token exchange. Behind a reverse proxy `host:port` is
 * `0.0.0.0:18254` and reaches nobody, which is why that setting exists at all.
 */
export function redirectUriFor(dashboard: DashboardSection): string {
  return `${publicBase(dashboard)}/api/control/auth/oauth/callback`;
}

/**
 * Whether this BUILD carries the sign-in flow at all.
 *
 * Resolved once and cached, because `/setup/state` is a synchronous handler and
 * a dynamic import is not. `boot` calls {@link resolveOauthSupport} before the
 * server accepts anything, so by the time a route asks, the answer is known.
 *
 * Starts as `false` rather than `undefined`: a race that answered "available"
 * before resolution would draw a button whose route 404s, and the safe default
 * for "we do not know yet" is the edition that has nothing.
 */
let supported = false;

export function oauthSupported(): boolean {
  return supported;
}

/**
 * Try to load the flow, once, at boot.
 *
 * The specifier is a **package name** precisely so `--external` can match it;
 * a relative path cannot be externalised, which is why this is not one. In an
 * edition built without `--pro` the module is not in the artefact and this
 * resolves to false — no error, because that is not a failure, it is the build.
 */
export async function resolveOauthSupport(): Promise<boolean> {
  try {
    await import("nouride-oauth");
    supported = true;
  } catch {
    supported = false;
  }
  log.debug("external sign-in support", { supported });
  return supported;
}

/** The flow itself, loaded on demand. Throws in an edition that does not carry it. */
export async function loadOauth(): Promise<typeof import("nouride-oauth")> {
  return await import("nouride-oauth");
}
