/**
 * Dashboard accounts. Every route here is admin-only: minting an account is minting a role.
 */

import { atLeast } from "@/modules/users/auth.ts";
import { accountIdentity } from "@/modules/config/settings/identities.ts";
import { multiUserSupported, userPolicy } from "@/modules/users/multi-user.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_RUNNING } from "../plain.ts";

export function registerUserRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/users", (c) => {
    if (!deps.users) return c.json({ users: [], multiUser: false });
    return c.json({ users: deps.users.list(), multiUser: multiUserSupported() });
  });

  control.post("/users", async (c) => {
    if (!deps.users) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    // Minting an account is minting a role, and minting a role includes minting an admin. Operators run
    // the daemon; they do not decide who else may.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;

    /**
     * Whether a second account may exist, and holding which role, is not decided here.
     *
     * `internals/pro/multi-user` decides it; a Basic build has no such plugin and its policy
     * refuses. Keeping the rule out of this file is the point — the route's job is to
     * read a request, ask, and carry the answer back. The bootstrap admin is created by
     * `ensureInitialAdmin` at boot and never arrives here, so every request this sees is
     * one the policy is entitled to refuse.
     */
    const admission = userPolicy().admitAccountCreation({
      existingAccounts: deps.users.count(),
      requestedRole: body.role,
    });
    if (!admission.ok) {
      return c.json({ error: admission.reason, plain: admission.status === 403 ? "This server does not take more accounts, or one with that role." : "No account was added. Check what you entered, and try again." }, admission.status);
    }

    const role = admission.role;
    try {
      /**
       * An omitted password means an account with none — provider sign-in only.
       *
       * Deliberately distinct from an empty string: `""` was what this sent
       * before, and the store rejected it as too short. Now the two say
       * different things, so "add somebody by email" is expressible without a
       * password nobody will ever use and everybody has to keep secret.
       */
      const password = typeof body.password === "string" && body.password.length > 0
        ? body.password
        : undefined;

      const user = await deps.users.create({
        username: typeof body.username === "string" ? body.username : "",
        ...(password ? { password } : {}),
        role,
        createdBy: principal.actor,
        mustChangePassword: body.must_change_password === true,
      });
      return c.json({ user });
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err), plain: "No account was added. Check the name and the password, and try again." }, 400);
    }
  });

  control.post("/users/:id/role", async (c) => {
    if (!deps.users) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;

    // Ordered before the policy call because "no such user" is about this request, and
    // the policy needs the role it holds to answer at all.
    const id = c.req.param("id");
    const target = deps.users.byId(id);
    if (!target) return c.json({ error: "no such user" }, 404);

    /**
     * Same seam as `POST /users`: whether a role may move — including the rule that the
     * last administrator may not be demoted, because promoting one back requires an
     * administrator — belongs to `internals/pro/multi-user`. A Basic build refuses the whole
     * route, and it refuses it from there rather than from a condition written here.
     */
    const admission = userPolicy().admitRoleChange({
      currentRole: target.role,
      requestedRole: body.role,
      adminCount: deps.users.adminCount(),
    });
    if (!admission.ok) {
      return c.json({ error: admission.reason, plain: admission.status === 403 ? "This server does not allow that role change." : "The role was not changed. Check what you picked, and try again." }, admission.status);
    }

    deps.users.setRole(id, admission.role, principal.actor);
    return c.json({ ok: true });
  });

  control.delete("/users/:id", async (c) => {
    if (!deps.users) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const id = c.req.param("id");
    const result = deps.users.delete(id, principal.actor, principal.user?.id);
    if (!result.ok) {
      const plain =
        result.why === "own"
          ? "You cannot remove your own account. Ask another admin to do it."
          : result.why === "last-admin"
            ? "This is the only admin. Make another account an admin first."
            : "That account is not there any more. Reload the page.";
      return c.json({ error: result.reason, plain }, 400);
    }
    // The account's `web:<id>` off the person it was linked to: it named an account that no longer exists.
    const unlinked = await deps.settings?.unlinkIdentity({ identity: accountIdentity(id), actor: principal.actor });
    if (unlinked && !unlinked.ok) return c.json({ ok: true, warning: `the account is deleted, but its link to a person stays: ${unlinked.error}` });
    return c.json({ ok: true });
  });
}
