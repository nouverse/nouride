/**
 * Webhooks: the jobs that fire on a request rather than on a clock. One store with the scheduled ones (`cron.ts`), two
 * views.
 */

import type { WebhookSummary } from "@nouride/wire";
import type { Job } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import { webhookUrl } from "@/modules/web/hooks.ts";
import { sendReachTest } from "@/modules/web/hook-reach.ts";
import { cronInputFrom, isCronRefusal, jsonBody, webhookView } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jobFor, thingOfJob, thingsFor, type Things } from "../whose.ts";
import { refusalWords, unknownStepAgent } from "./cron.ts";

export function registerWebhookRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The other view of the same table: jobs that fire on request rather than on a clock.
   *
   * The token comes back, because the URL is the entire point of the page — and it is already
   * behind the dashboard's admin session, which is a stronger check than the endpoint it addresses.
   */
  control.get("/webhooks", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    // A webhook's address is the way to call it: listed for whoever may change it, its owner or an admin.
    const things = thingsFor(deps, c.get("principal"), c.req.query("whose"));
    const jobs = deps.cron.store
      .list({
        ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}),
        includeDisabled: true,
      })
      .filter((job) => job.trigger.kind === "webhook" && things.listed(thingOfJob(job)) && things.changes(thingOfJob(job)));

    return c.json({
      webhooks: jobs.map((job) => hookOf(job, deps, things)),
    } satisfies { webhooks: WebhookSummary[] });
  });

  control.post("/webhooks", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const principal = c.get("principal");
    // Same class of decision as a cron job that runs commands unattended, and gated the same way.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;

    // A webhook's URL gets handed to a third party, who sees 202 and reasonably concludes it worked —
    // so an agent that does not exist is refused before the URL exists. `/cron` checks the same.
    const agentId = String(body.agentId ?? "");
    if (!deps.registry.get(agentId)) {
      return c.json({ error: `no agent "${agentId}": a webhook must point at one that exists` }, 400);
    }

    try {
      const input = { ...cronInputFrom(body, principal.actor, deps.cron.timezone, { trigger: { kind: "webhook" } }), ...(principal.user ? { owner: `web:${principal.user.id}` } : {}) };
      const unknown = unknownStepAgent(deps, input.payload);
      if (unknown) return c.json({ error: unknown }, 400);
      const job = deps.cron.store.create(input);
      deps.audit.record({
        action: "webhook_create",
        agentId: job.agentId,
        actor: principal.actor,
        details: { job: job.id, name: job.name, payload_kind: job.payload.kind },
      });
      return c.json({ webhook: hookOf(job, deps, thingsFor(deps, principal)) } satisfies { webhook: WebhookSummary });
    } catch (err) {
      if (isCronRefusal(err)) return c.json({ error: (err as Error).message, plain: refusalWords(err) }, 400);
      throw err;
    }
  });

  /**
   * Send a test through the hook's public address: whether a call from outside reaches this daemon, without
   * running the job. Kept on the hook until the next test, so the page can say where it stands after a restart.
   */
  control.post("/webhooks/:id/test", async (c) => {
    if (!deps.cron?.tests) return c.json({ error: "the scheduler is not enabled" }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const found = jobFor(deps, c.get("principal"), c.req.param("id"));
    const job = found?.changeable ? found.job : null;
    if (!job || job.trigger.kind !== "webhook") return c.json({ error: "no such webhook" }, 404);
    // A paused hook answers 404 to everyone, a test included — which would read as "unreachable".
    if (!job.enabled) return c.json({ error: "it is paused. Resume it first; a paused webhook answers nobody, a test included" }, 409);
    if (webhookUrl(deps.ctx.config.dashboard, job.webhookToken ?? "").guessed) {
      return c.json({ error: "no public address is set ([dashboard] public_url), so there is nowhere outside to test through", plain: "This server has no public address yet, so a test cannot come in from outside. Whoever runs the server can set one." }, 409);
    }
    const test = await sendReachTest(deps.cron.tests, deps.ctx.config.dashboard, job);
    deps.cron.store.recordReachTest(job.id, test);
    return c.json({ webhook: hookOf({ ...job, reachTest: test }, deps, found!.things) } satisfies { webhook: WebhookSummary });
  });

  /** Mint a new token. The old URL stops working the moment this returns. */
  control.post("/webhooks/:id/rotate", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const job = deps.cron.store.rotateWebhookToken(c.req.param("id"), principal.actor);
    if (!job) return c.json({ error: "no such webhook" }, 404);
    return c.json({ webhook: hookOf(job, deps, thingsFor(deps, principal)) } satisfies { webhook: WebhookSummary });
  });
}

/** A webhook as its routes answer it, to whoever may change it. */
function hookOf(job: Job, deps: ControlDeps, things: Things): WebhookSummary {
  const { owner: _owner, ...shown } = webhookView(job, deps) as WebhookSummary & { owner?: string };
  return { ...shown, ...things.said(thingOfJob(job)) };
}
