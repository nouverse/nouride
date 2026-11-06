/**
 * `/appliance/*` — forwarded to the appliance plugin, for admins, and nothing else.
 *
 * The dashboard's My Box page belongs to `internals/pro/appliance` (Pro only): its state,
 * its claim links and what claiming means all live there, behind `handle()`. This file knows none of
 * it — the prefix, the admin check, and the forward. On any other edition, or before the plugin has
 * loaded, `ctx.appliance` is unset and the answer is a 404, the same as a route that does not exist,
 * because on that build it does not.
 */

import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

const PREFIX = "/api/control/appliance";

export function registerApplianceRoutes(control: ControlApp, deps: ControlDeps): void {
  control.all("/appliance/*", async (c) => {
    const appliance = deps.ctx.appliance;
    if (!appliance?.handle) return c.json({ error: "not found" }, 404);
    // Claiming binds the box to an account; that is an admin's decision, like minting a role.
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);

    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(url.pathname.indexOf(PREFIX) + PREFIX.length) || "/";
    const raw = c.req.raw;
    const hasBody = raw.method !== "GET" && raw.method !== "HEAD";
    return appliance.handle(
      new Request(url.toString(), {
        method: raw.method,
        headers: raw.headers,
        ...(hasBody ? { body: await raw.arrayBuffer() } : {}),
      }),
    );
  });
}
