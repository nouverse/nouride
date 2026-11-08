/**
 * My Box — this Nouride Box's link to a Nouverse account, served by the appliance plugin.
 *
 * Every call goes to `/api/control/appliance/*`, which the engine forwards to `internals/pro/packages/appliance`
 * (Pro only) for admins. On any other edition the route does not exist and these
 * calls answer 404, which the page reads as "this is not a box".
 *
 * Its own module rather than more lines in `api.ts`, for the reason that file's budget note gives —
 * and not spread into `api` either: the page imports it from here.
 */

import { control, post, request } from "./api.client";
import type { BoxState, ClaimLink } from "@nouride/wire";

/**
 * Whether the daemon this dashboard talks to is a paired Box — which decides whether My Box exists.
 *
 * Its own answer (`appliance` in `/health`) and nothing else. Every Box runs a build that gives one, and a daemon
 * without the field is not a Box. The edition is no stand-in: a Pro pod is the Pro edition with nothing behind the
 * page, and the names that once meant a Box (`device`, `device-pro`) are carried by no daemon since 2026-09-30.
 */
export function isPairedBox(health: { appliance?: boolean } | undefined): boolean {
  return health?.appliance === true;
}

export const applianceApi = {
  boxState: () => request<BoxState>(`${control}/appliance/state`),
  /** Mint a one-time claim link. The box reports its token to Nouverse before this answers. */
  boxClaimLink: () => post<ClaimLink>(`${control}/appliance/claim-link`),
  /** Ask Nouverse now — "I just claimed it on my phone". */
  boxRefresh: () => post<BoxState>(`${control}/appliance/refresh`),
  /** Open the setup hotspot for 15 minutes beside the Wi-Fi, to reach the setup console. */
  boxOpenSetup: () => post<{ ok: boolean; error?: string; state: BoxState }>(`${control}/appliance/setup-mode`),
  /** The setup console's sign-in back to the card (admin + PIN). */
  boxResetSetupLogin: () => post<BoxState>(`${control}/appliance/setup-login/reset`),
  /** Whether the box installs offered updates by itself, overnight. */
  boxSetAutomaticUpdates: (automatic: boolean) => post<BoxState>(`${control}/appliance/updates`, { automatic }),
};
