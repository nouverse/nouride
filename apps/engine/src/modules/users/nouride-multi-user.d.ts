/**
 * What the engine needs from `nouride-multi-user`, declared here rather than imported.
 *
 * The same choice — and the same two reasons — as `gateways/wa-bridge.d.ts` and
 * `users/oauth.d.ts`:
 *
 * - A path mapping would drag the plugin's source into this project's program,
 *   so the engine's typecheck would start reporting the plugin's problems as its own.
 * - It would make the plugin **required**. The Basic (free) build is compiled with
 *   `--external nouride-multi-user`, and an optional component must never become a
 *   required one.
 *
 * `scripts/check-seams.ts` (`bun run lint:seams`) compiles the plugin's module
 * against everything below and fails on any difference, so the duplication
 * cannot drift silently. It skips when `internals/pro` is not checked out.
 */

declare module "nouride-multi-user" {
  /**
   * Human-readable capability description used as the build assertion marker.
   * Value: "multi-user capability provider active in this daemon process"
   */
  export const MULTI_USER_CAPABILITY: string;

  /**
   * Verification function called by the engine's boot resolver.
   */
  export function verifyMultiUserEdition(): string;

  /** The three roles an account may be assigned. Same list the engine declares for `atLeast()`. */
  export type MultiUserRole = "admin" | "operator" | "viewer";

  /**
   * One rule's answer, shaped for an HTTP route.
   *
   * The status travels with the refusal because a role that is not a role (400) and
   * "this daemon would be left with no administrator" (409) are different answers.
   */
  export type MultiUserAdmission =
    | { ok: true; role: MultiUserRole }
    | { ok: false; status: 400 | 409; reason: string };

  /** May another account be created, and holding which role. */
  export function admitAccountCreation(request: {
    existingAccounts: number;
    requestedRole: unknown;
  }): MultiUserAdmission;

  /** May this account's role move, given how many admins would be left. */
  export function admitRoleChange(request: {
    currentRole: MultiUserRole;
    requestedRole: unknown;
    adminCount: number;
  }): MultiUserAdmission;
}
