/**
 * What the engine knows about multi-user capability — which is deliberately little.
 *
 * The **rules** live in `internals/pro/packages/multi-user`, outside this source tree, so that
 * `--external nouride-multi-user` can genuinely remove them from the Basic (free) build.
 * A binary without `--pro` or `--pro` does not contain that code, which is the
 * difference between a feature switched off and a feature that is not there. The same
 * boundary `internals/pro/packages/oauth` draws for Nouverse sign-in.
 *
 * This file used to hold a boolean and let the routes keep the rules —
 * `if (multiUserSupported()) { …every multi-user decision… }`. That removed the feature
 * from the *binary* and not from the *source*, so publishing the engine would have
 * published multi-user with it. What is here now is the seam and nothing else: load the
 * plugin once, hand out whichever policy this build actually has, and let the route ask
 * it rather than decide for itself.
 *
 * The fallback below is the whole of multi-user in a Basic build, and it is a refusal.
 */

import { createLogger } from "@nouride/shared";
import type { UserRole } from "@nouride/wire";

const log = createLogger("users.multi-user");

/**
 * The questions a route asks before it changes an account.
 *
 * Mirrors `nouride-multi-user`'s exports rather than importing them: the plugin is
 * optional, and a type imported from an optional module makes it required. The ambient
 * declaration in `nouride-multi-user.d.ts` is what keeps the two in agreement, and
 * `multi-user-external.test.ts` fails when they drift.
 */
export type UserAdmission =
  | { ok: true; role: UserRole }
  | { ok: false; status: 400 | 403 | 409; reason: string };

export interface UserPolicy {
  /** Whether this build carries multi-user support at all. Drives the dashboard's shape. */
  readonly multiUser: boolean;
  admitAccountCreation(request: { existingAccounts: number; requestedRole: unknown }): UserAdmission;
  admitRoleChange(request: {
    currentRole: UserRole;
    requestedRole: unknown;
    adminCount: number;
  }): UserAdmission;
}

/**
 * What a Basic build does instead, which is refuse.
 *
 * Not "the same rules with a seat limit of one" — there are no rules here to have. The
 * bootstrap admin is created by `ensureInitialAdmin` at boot and never comes through a
 * route, so every request this policy sees is one asking for the second account or for a
 * role to move, and both answers are the same sentence.
 *
 * 403 rather than 501: the request is understood and refused, and an edition is a
 * property of this daemon rather than a feature nobody implemented.
 */
const SINGLE_ACCOUNT_POLICY: UserPolicy = {
  multiUser: false,
  admitAccountCreation: () => ({
    ok: false,
    status: 403,
    reason:
      "multi-user accounts require the Pro edition: " +
      "this build supports a single admin account only",
  }),
  admitRoleChange: () => ({
    ok: false,
    status: 403,
    reason:
      "role management requires the Pro edition: " +
      "this build supports a single admin account only",
  }),
};

/**
 * Resolved once at boot and cached, because a route handler is synchronous and a dynamic
 * import is not. `boot` calls {@link resolveMultiUserSupport} before the server accepts
 * anything, so by the time a route asks, the answer is known.
 *
 * Starts as the refusing policy rather than `undefined`: a race that answered "supported"
 * before resolution would allow account creation in a build that must not permit it, and
 * the safe default for "we do not know yet" is the restricted edition.
 */
let policy: UserPolicy = SINGLE_ACCOUNT_POLICY;

/** The policy this build actually has. Every account-changing route goes through it. */
export function userPolicy(): UserPolicy {
  return policy;
}

/** Whether this BUILD carries multi-user support at all. */
export function multiUserSupported(): boolean {
  return policy.multiUser;
}

/**
 * Try to load the multi-user plugin, once, at boot.
 *
 * The specifier is a **package name** precisely so `--external` can match it; a relative
 * path cannot be externalised. In a Basic build the module is not in the artefact and this
 * leaves the refusing policy in place — no error, because that is not a failure, it is the
 * build.
 *
 * The plugin's functions are adopted rather than copied: this wrapper exists only to widen
 * `MultiUserRole` to the engine's `UserRole`, which are the same three strings declared on
 * both sides of a boundary that must not become an import.
 */
export async function resolveMultiUserSupport(): Promise<boolean> {
  try {
    const mod = await import("nouride-multi-user");
    // `verifyMultiUserEdition` is what keeps the build marker alive through minification;
    // calling it is also the cheapest proof that what resolved is the real module and not
    // an empty object some bundler left behind.
    if (typeof mod.verifyMultiUserEdition !== "function" || !mod.verifyMultiUserEdition()) {
      policy = SINGLE_ACCOUNT_POLICY;
    } else {
      policy = {
        multiUser: true,
        admitAccountCreation: (request) => mod.admitAccountCreation(request) as UserAdmission,
        admitRoleChange: (request) => mod.admitRoleChange(request) as UserAdmission,
      };
    }
  } catch {
    policy = SINGLE_ACCOUNT_POLICY;
  }
  log.debug("multi-user support", { supported: policy.multiUser });
  return policy.multiUser;
}
