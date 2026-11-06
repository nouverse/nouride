/**
 * Which of the gateway's providers get a sign-in button, in what order, under what name.
 *
 * None of it is known here. The gateway lists its providers with each one's `accountFlow` (how an
 * account is added) and `accountCopy` (what to call it and what to say), and this only filters and
 * sorts what it is given — so a provider the gateway adds is offered with no change on this side.
 */

import type { GatewayProvider } from "./gateway-api";

/**
 * The flows a person finishes on a sign-in screen: open-and-paste, a code entered elsewhere, a token
 * pasted in. `api-key` is not one — it is what "use an API key" already is, on the step before.
 */
const SIGN_IN_FLOWS = new Set(["oauth-redirect", "device-code", "oauth-token"]);

/** The rows to show: providers an account signs in to, in the order the gateway gives them. */
export function accountProviders(providers: GatewayProvider[] | undefined): GatewayProvider[] {
  return (providers ?? [])
    .filter((p) => SIGN_IN_FLOWS.has(p.accountFlow ?? ""))
    .sort(
      (a, b) =>
        (a.accountCopy?.order ?? Number.MAX_SAFE_INTEGER) - (b.accountCopy?.order ?? Number.MAX_SAFE_INTEGER) ||
        providerCopy(a).name.localeCompare(providerCopy(b).name),
    );
}

/** The name and the one line under it — the provider's words, or its own name and neutral ones. */
export function providerCopy(provider: GatewayProvider): { name: string; hint: string } {
  return {
    name: provider.accountCopy?.label ?? provider.displayName,
    hint: provider.accountCopy?.hint ?? "Sign in with your account",
  };
}

/**
 * The sentence on the card that leads to the sign-in step, built from what the gateway offers —
 * "Sign in with Claude, ChatGPT or Kiro". Neutral when there is nothing to name yet.
 */
export function offerSentence(providers: GatewayProvider[] | undefined, most = 4): string {
  const names = accountProviders(providers).slice(0, most).map((p) => providerCopy(p).name);
  if (names.length === 0) return "Sign in with an AI subscription you already have, no API key.";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Sign in with ${list}, no API key.`;
}
