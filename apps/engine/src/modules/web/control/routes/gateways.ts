/**
 * Chat connections: where messages arrive.
 *
 * A different question from `access.ts`, which is whose messages are answered.
 */

import { atLeast } from "@/modules/users/auth.ts";
import type { GatewayField } from "@/modules/config/settings/gateways.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_CHANGED, NO_SETTINGS, notSaved } from "../plain.ts";

/** Each field a connection's save can be refused for, as its form on an agent's page names it. */
const GATEWAY_FIELDS: Record<GatewayField, string> = {
  platform: "the chat app",
  name: "the connection's name",
  token: "the key",
  groupContextMessages: "the group context",
};

export function registerGatewayRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/gateways", (c) => {
    if (!deps.settings) return c.json({ gateways: [], editable: false });
    return c.json({
      gateways: deps.settings.gateways(),
      editable: true,
      // What a connection with no override of its own inherits, so the form can show it instead of
      // hard-coding a placeholder that drifts from `defaults.ts`.
      groupContextDefault: deps.settings.groupContextDefault(),
    });
  });

  control.post("/gateways", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    // Adding a gateway hands a chat platform a route into this daemon's agents. That is the same
    // class of change as editing the daemon config by hand, and it is gated the same way.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.settings.saveGateway({
      platform: String(body.platform ?? ""),
      name: String(body.name ?? ""),
      enabled: body.enabled !== false,
      actor: principal.actor,
      ...(typeof body.token === "string" ? { token: body.token } : {}),
      ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
      ...(typeof body.sessionDir === "string" ? { sessionDir: body.sessionDir } : {}),
      // Passed through as-is rather than coerced: `Number("")` is 0, which is the off position, so a
      // form field that arrived empty would silently switch group context off for this connection.
      // `saveGateway` refuses anything that is not a whole number in range.
      ...(typeof body.groupContextMessages === "number"
        ? { groupContextMessages: body.groupContextMessages }
        : {}),
    });
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: notSaved(result.field && GATEWAY_FIELDS[result.field]) }, 400);
  });

  control.delete("/gateways/:id", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const result = await deps.settings.removeGateway(c.req.param("id"), principal.actor);
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: NOT_CHANGED }, 400);
  });

  /**
   * The pairing code for a gateway that has one.
   *
   * WhatsApp has no bot token: linking is a phone scanning a QR, and the person holding the phone is
   * not the person reading `journalctl`. So the code is served here and rendered in the dashboard.
   *
   * Detected by capability rather than by platform id — asking "does this gateway have a pairing
   * code" keeps the rule that nothing outside an adapter branches on which platform it is, and it
   * means a future platform that pairs the same way needs no edit here.
   */
  control.get("/gateways/:id/pairing", (c) => {
    const gateway = deps.ctx.gateways.get(c.req.param("id"));
    if (!gateway) return c.json({ error: "no such gateway", plain: "That chat connection is not there any more. Reload the page." }, 404);

    const pairable = gateway as unknown as {
      pairingCode?: () => { qr: string; at: number } | null;
      isLinked?: () => boolean;
    };
    if (typeof pairable.pairingCode !== "function") {
      return c.json({ error: "this gateway does not pair with a code", plain: "This chat connection does not pair with a code." }, 400);
    }

    const code = pairable.pairingCode();
    return c.json({
      status: gateway.status,
      linked: pairable.isLinked?.() ?? false,
      // Null while connecting and once linked. The dashboard shows those as states of their own
      // rather than as an empty QR.
      ...(code ? { qr: code.qr, at: code.at } : { qr: null }),
    });
  });

  control.post("/gateways/:id/restart", async (c) => {
    const id = c.req.param("id");
    const gateway = deps.ctx.gateways.get(id);
    if (!gateway) return c.json({ error: `no gateway "${id}"` }, 404);

    deps.audit.record({ action: "gateway_restart", actor: "cli", gatewayId: id });
    await gateway.stop();
    await gateway.start();
    return c.json({ ok: true, id, status: gateway.status });
  });
}
