/**
 * `[queue] steer_reply` and `steer_ack` for the whole daemon: what a person is told when they write to an agent that is
 * already working. Admin, as every daemon-wide switch here is; live on the next steered message.
 */

import type { SteeringPolicy } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NO_SETTINGS, notSaved } from "../plain.ts";

function policy(deps: ControlDeps): Omit<SteeringPolicy, "editable"> {
  return { reply: deps.ctx.config.queue.steerReply, ack: deps.ctx.config.queue.steerAck };
}

export function registerSteeringRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/policy/steering", (c) => c.json({ ...policy(deps), editable: Boolean(deps.settings) } satisfies SteeringPolicy));

  control.post("/policy/steering", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    for (const key of ["reply", "ack"] as const) {
      if (key in body && typeof body[key] !== "boolean") return c.json({ error: `${key} must be true or false` }, 400);
    }
    const result = await deps.settings.setSteering({
      ...(typeof body.reply === "boolean" ? { reply: body.reply } : {}),
      ...(typeof body.ack === "boolean" ? { ack: body.ack } : {}),
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("what a person is told while the agent works") }, 400);
    return c.json({ ok: true, ...policy(deps) } satisfies { ok: true; reply: boolean; ack: boolean });
  });
}
