/**
 * The LLM gateway's switch: on, without a restart; off, through one (`boot/gateway-switch.ts`).
 *
 * An admin's, as the LLM Gateway page is: the gateway holds the credentials of every account signed in to it.
 *
 * Off is a restart because the gateway does not stop and start again inside one process. The setting is written
 * first, and then the restart is asked for the way the dashboard's Restart asks (`modules/update/restart.ts`): once
 * nothing is running, and refused where nothing would start Nouride again. Then the setting stays written, and the
 * page says it takes effect at the next start.
 */

import type { LlmGatewaySwitched, LlmGatewayUser, LlmGatewayView } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NOT_SAVED } from "../plain.ts";

const NOT_CARRIED = "This version of Nouride does not include Nougate.";
const DECIDED_BY_SERVER = "Whether Nougate runs is set on the server itself, so it cannot be changed here. Whoever runs the server can change it there.";
const DID_NOT_START = "Nougate did not start. Restart Nouride to try again.";

/**
 * The agents that reach a model through the gateway hosted here: their own provider, or one of their fallbacks', is a
 * profile whose address is this machine at the gateway's port. What stops answering when it is turned off.
 */
function usersOf(deps: ControlDeps): LlmGatewayUser[] {
  const port = deps.ctx.config.nougate.port;
  const here = new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(?:/|$)`);
  const through = new Set(deps.providers.available().filter((profile) => here.test(profile.baseUrl)).map((profile) => profile.name));
  return deps.registry
    .all()
    .filter((agent) => through.has(agent.config.llm.provider) || (agent.config.llm.fallbacks ?? []).some((pair) => through.has(pair.provider)))
    .map((agent) => ({ id: agent.config.id, name: agent.config.displayName || agent.config.id }));
}

function view(deps: ControlDeps): LlmGatewayView {
  const gateway = deps.llmGateway;
  return {
    carried: gateway?.carried ?? false,
    on: (gateway?.current() ?? null) !== null,
    decidedBy: gateway?.decidedBy ?? null,
    usedBy: usersOf(deps),
    restarts: deps.supervisor?.().restartsOnExit ?? false,
  };
}

export function registerLlmGatewayRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/llm-gateway", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    return c.json(view(deps));
  });

  control.put("/llm-gateway", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const gateway = deps.llmGateway;
    if (!gateway?.carried) return c.json({ error: "this build does not carry the LLM gateway", plain: NOT_CARRIED }, 409);
    const body = (await jsonBody(c)) as Record<string, unknown> | null;
    if (typeof body?.on !== "boolean") return c.json({ error: "on must be true or false", plain: INCOMPLETE }, 400);

    if (body.on) {
      const on = await gateway.turnOn(principal.actor);
      if (!on.ok) {
        if (on.why === "environment") return c.json({ error: on.error, plain: DECIDED_BY_SERVER }, 409);
        if (on.why === "not-carried") return c.json({ error: on.error, plain: NOT_CARRIED }, 409);
        return c.json({ error: on.error, plain: DID_NOT_START }, 500);
      }
      const answer: LlmGatewaySwitched = on.saved
        ? { on: true, saved: true, said: "Nougate is on." }
        : { on: true, saved: false, said: "Nougate is on, but the setting was not saved, so it is off again after Nouride restarts." };
      return c.json(answer);
    }

    const off = await gateway.turnOff(principal.actor);
    if (!off.ok) {
      if (off.why === "environment") return c.json({ error: off.error, plain: DECIDED_BY_SERVER }, 409);
      if (off.why === "not-carried") return c.json({ error: off.error, plain: NOT_CARRIED }, 409);
      return c.json({ error: off.error, plain: NOT_SAVED }, 400);
    }
    if (!off.running) return c.json({ on: false, saved: true, said: "Nougate is off." } satisfies LlmGatewaySwitched);
    if (!deps.restart) return c.json({ on: true, saved: true, said: "Saved. Nougate stops the next time Nouride starts." } satisfies LlmGatewaySwitched);

    const restart = deps.restart.request({ by: principal.actor });
    // Worded for the page from what the restart said: its own note names a service, a container and a flag, for a CLI
    // this route does not have.
    const answer: LlmGatewaySwitched = !restart.ok
      ? {
          on: true,
          saved: true,
          said:
            restart.why === "no-restarter"
              ? "Saved. Nougate stops the next time Nouride starts: nothing on this server would start Nouride again by itself, so it was not restarted now. Whoever runs the server can restart it there."
              : "Saved. Nougate stops the next time Nouride starts; it was not restarted now.",
        }
      : {
          on: true,
          saved: true,
          restart: { waiting: restart.waiting },
          said: restart.waitingFor
            ? "Nougate stops as Nouride restarts, once its background work is done."
            : restart.waiting
              ? "Nougate stops as Nouride restarts, as soon as nothing is running."
              : "Nougate stops as Nouride restarts now.",
        };
    return c.json(answer);
  });
}
