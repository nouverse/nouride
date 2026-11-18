/**
 * Device tokens (`users/devices.store.ts`): a Home app on the daemon's own machine stays signed in.
 *
 * Made with the control token alone (`nouride auth device`): holding it is the proof that whoever asks can read the
 * data folder, which is what "on the same machine" means here. A signed-in admin cannot make one from a browser, and
 * no route trusts a request for coming from loopback: on a phone every app reaches 127.0.0.1. Traded on a public
 * route for an ordinary session, under the sign-in's own limit per address: a guessed token is a guessed password.
 * An admin lists and revokes them from the dashboard.
 */

import type { DeviceTokenView, User } from "@nouride/wire";
import { createLogger, type RateLimiter } from "@nouride/shared";
import { atLeast, sessionCookie } from "@/modules/users/auth.ts";
import { secureCookies } from "../guard.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_RUNNING } from "../plain.ts";

const log = createLogger("control.devices");

/** A label the list can show: the app and the machine, as a person would name them. */
const LABEL = /^[\p{L}\p{N} ._'()-]{1,60}$/u;
/** Addressless requests share one bucket rather than bypassing the rule, as the password's do. */
const NO_ADDRESS = "unknown";

export function registerDeviceRoutes(control: ControlApp, deps: ControlDeps, limits: { byAddress: RateLimiter }): void {
  control.post("/auth/devices", async (c) => {
    if (!deps.users || !deps.devices) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (principal.kind !== "token") {
      return c.json({ error: "a device token is made with `nouride auth device` on the machine itself", plain: "A device's sign-in is made on the machine Nouride runs on, with `nouride auth device`." }, 403);
    }
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const label = typeof body.name === "string" ? body.name.trim() : "";
    if (!LABEL.test(label)) return c.json({ error: "name is what the device is called, 1 to 60 letters, digits, spaces and . _ ' ( ) -" }, 400);
    const admin = deps.devices.firstAdmin();
    if (!admin) return c.json({ error: "there is no admin account yet: the daemon's first start makes one" }, 409);

    const made = deps.devices.create({ userId: admin.id, label, now: Date.now() });
    deps.audit.record({ action: "device_token_created", actor: principal.actor, details: { id: made.device.id, label, user: admin.username } });
    return c.json(made satisfies { device: DeviceTokenView; value: string }, 201);
  });

  control.get("/auth/devices", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    return c.json({ devices: deps.devices?.list() ?? [] } satisfies { devices: DeviceTokenView[] });
  });

  control.delete("/auth/devices/:id", (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const id = c.req.param("id");
    if (!deps.devices?.revoke(id, Date.now())) return c.json({ error: `no live device token ${id}`, plain: "That device is not there any more. Reload the page." }, 404);
    deps.audit.record({ action: "device_token_revoked", actor: principal.actor, details: { id } });
    return c.json({ id, revoked: true } satisfies { id: string; revoked: boolean });
  });

  /**
   * Trade a device token for a session: public, since the app is not signed in when it asks. The address's allowance
   * is spent before the token is looked at and given back only when it was good, as a password sign-in's is, so a
   * failed trade counts against the same limit.
   */
  control.post("/auth/device", async (c) => {
    if (!deps.users || !deps.devices) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);
    const address = c.env.clientAddress ?? NO_ADDRESS;
    const verdict = limits.byAddress.check(address);
    if (!verdict.ok) {
      log.warn("device sign-in rate limited", { retry_after_ms: verdict.retryAfterMs });
      c.header("retry-after", String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
      return c.json({ error: "too many sign-in attempts. Wait a few minutes and try again" }, 429);
    }
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const device = typeof body.token === "string" ? deps.devices.use(body.token, Date.now()) : null;
    const user = device ? deps.users.byId(device.userId) : null;
    if (!device || !user) {
      deps.audit.record({ action: "device_login_failed", actor: "device", details: {} });
      return c.json({ error: "this device's sign-in is not valid any more" }, 401);
    }

    limits.byAddress.refund(address);
    const session = deps.users.startSession(user.id, device.id);
    c.header("set-cookie", sessionCookie(session.token, session.expiresAt, secureCookies(c)));
    deps.audit.record({ action: "login", actor: user.username, details: { device: device.id } });
    return c.json({ user, expiresAt: session.expiresAt } satisfies { user: User; expiresAt: number });
  });
}
