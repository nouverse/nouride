/**
 * A step tried alone, from its panel (`cron/try-step.ts`): `{ agentId, step, input? }`, the step as it is written on
 * the page, saved or not. Run once, for real, and what it printed is the answer: no run is kept and nothing is sent
 * to a chat.
 *
 * Only a script or a command: an agent's turn, a mission and a wait for a person are tried with Run now, which keeps
 * the run. Held to what a saved step is, and asked of the machine the same way, before anything runs. It names no
 * automation and answers with none, so there is nobody's to ask after: it is an agent's command, which whoever may
 * make an automation may run.
 */

import type { JobPayload } from "@nouride/shared";
import type { TriedStep } from "@nouride/wire";
import { payloadAudit } from "@/modules/cron/job-audit.ts";
import { assertScriptsRun } from "@/modules/cron/scripts.ts";
import { stepsFrom } from "@/modules/cron/step-input.ts";
import { validateDoes } from "@/modules/cron/validate.ts";
import { isCronRefusal, jsonBody } from "../payloads.ts";
import { ONLY_A_SCRIPT_IS_TRIED } from "../plain.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { refusalWords, unknownAgent } from "./cron.ts";

export function registerCronTryRoute(control: ControlApp, deps: ControlDeps): void {
  control.post("/cron/try", async (c) => {
    if (!deps.cron?.tryCommand) return c.json({ error: "the scheduler is not enabled" }, 501);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const principal = c.get("principal");
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const unknown = agentId.trim() ? unknownAgent(deps, agentId) : "say which agent's it is: `agentId`";
    if (unknown) return c.json({ error: unknown }, 400);
    try {
      const [step] = stepsFrom([body.step]);
      if (step?.kind !== "command") return c.json({ error: "only a script or a command is tried alone: an agent's turn, a mission and a wait for a person are tried with Run now", plain: ONLY_A_SCRIPT_IS_TRIED }, 400);
      const payload: JobPayload = { kind: "steps", steps: [step] };
      validateDoes({ agentId, payload });
      await assertScriptsRun(agentId, payload, deps.cron.scripts);
      // Kept whole, as a saved command is: it ran on this machine, whether or not it is ever saved.
      deps.audit.record({ action: "cron_try", agentId, actor: principal.actor, details: payloadAudit(payload) });
      const tried = await deps.cron.tryCommand(agentId, step, typeof body.input === "string" && body.input !== "" ? body.input : undefined);
      return c.json({ tried } satisfies { tried: TriedStep });
    } catch (err) {
      if (isCronRefusal(err)) return c.json({ error: (err as Error).message, plain: refusalWords(err) }, 400);
      throw err;
    }
  });
}
