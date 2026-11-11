/**
 * Scheduled jobs and webhooks — one store, two views.
 */

import type { CronRunEntry, JobRunSummary, JobSummary, RunNowOutcome, WebhookSummary } from "@nouride/wire";
import type { Job } from "@nouride/shared";
import { describeTrigger } from "@/modules/cron/parse.ts";
import { atLeast } from "@/modules/users/auth.ts";
import { webhookUrl } from "@/modules/web/hooks.ts";
import { sendReachTest } from "@/modules/web/hook-reach.ts";
import { settledCard, turnOnProposal } from "@/modules/cron/proposals.ts";
import type { CronField } from "@/modules/cron/validate.ts";
import { cronInputFrom, cronPatchFrom, cronRefusalField, isCronRefusal, jsonBody, webhookView } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { NOT_CHANGED, notSaved } from "../plain.ts";

/** Each field a job or a webhook can be refused for, as the Schedule and Webhooks pages' forms name it. */
const CRON_FIELDS: Record<CronField, string> = {
  name: "the name",
  agent: "the agent",
  target: "where it goes",
  schedule: "when it runs",
  kind: "what should happen",
  text: "the message",
  message: "what to ask the agent",
  command: "the command",
  goal: "the mission's goal",
  checks: "the mission's checks",
  review: "the mission's review",
  delivery: "where it goes",
};

/** A cron refusal in the page's words: the field it names, or what was entered. */
function refusalWords(err: unknown): string {
  const field = cronRefusalField(err);
  return notSaved(field && CRON_FIELDS[field]);
}

export function registerCronRoutes(control: ControlApp, deps: ControlDeps): void {
  // ── Scheduled jobs ────────────────────────────────────────────────────────
  //
  // Everything that writes here is already behind the operator role check at the top of this file,
  // and that is what makes this the right place for `command` payloads. A command job runs argv on
  // the host with no model and no approval gate; an agent reaching this argv through `exec nouride` meets a
  // hardline gate in @nouride/policy, because holding the control token is *not* the same as being an
  // operator — `cli/client.ts` reads it off disk and a bare token is `role: "admin"`.

  control.get("/cron", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const jobs = deps.cron.store.list({
      ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}),
      includeDisabled: c.req.query("all") === "1",
    });
    return c.json({
      // Webhook jobs are excluded here and listed by /webhooks instead. One store, two views: what
      // you want to see about a scheduled job is when it next runs, and what you want to see about a
      // webhook is its URL. A single table showing "next run: never" for half its rows serves
      // neither question.
      jobs: jobs
        .filter((job) => job.trigger.kind !== "webhook")
        .map((job) => ({ ...job, describes: describeTrigger(job.trigger, deps.cron!.timezone) })),
      timezone: deps.cron.timezone,
    } satisfies { jobs: JobSummary[]; timezone: string });
  });

  /**
   * The other view of the same table: jobs that fire on request rather than on a clock.
   *
   * The token comes back, because the URL is the entire point of the page — and it is already
   * behind the dashboard's admin session, which is a stronger check than the endpoint it addresses.
   */
  control.get("/webhooks", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const jobs = deps.cron.store.list({
      ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}),
      includeDisabled: true,
    });

    return c.json({
      webhooks: jobs
        .filter((job) => job.trigger.kind === "webhook")
        .map((job) => webhookView(job, deps)),
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
      const job = deps.cron.store.create({
        ...cronInputFrom(body, principal.actor, deps.cron.timezone, { trigger: { kind: "webhook" } }),
      });
      deps.audit.record({
        action: "webhook_create",
        agentId: job.agentId,
        actor: principal.actor,
        details: { job: job.id, name: job.name, payload_kind: job.payload.kind },
      });
      return c.json({ webhook: webhookView(job, deps) } satisfies { webhook: WebhookSummary });
    } catch (err) {
      if (isCronRefusal(err)) return c.json({ error: (err as Error).message, plain: refusalWords(err) }, 400);
      throw err;
    }
  });

  /**
   * Send a test through the hook's public address (0.8.0): whether a call from outside reaches this daemon, without
   * running the job. Kept on the hook until the next test, so the page can say where it stands after a restart.
   */
  control.post("/webhooks/:id/test", async (c) => {
    if (!deps.cron?.tests) return c.json({ error: "the scheduler is not enabled" }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const job = deps.cron.store.get(c.req.param("id"));
    if (!job || job.trigger.kind !== "webhook") return c.json({ error: "no such webhook" }, 404);
    // A paused hook answers 404 to everyone, a test included — which would read as "unreachable".
    if (!job.enabled) return c.json({ error: "it is paused. Resume it first; a paused webhook answers nobody, a test included" }, 409);
    if (webhookUrl(deps.ctx.config.dashboard, job.webhookToken ?? "").guessed) {
      return c.json({ error: "no public address is set ([dashboard] public_url), so there is nowhere outside to test through", plain: "This server has no public address yet, so a test cannot come in from outside. Whoever runs the server can set one." }, 409);
    }
    const test = await sendReachTest(deps.cron.tests, deps.ctx.config.dashboard, job);
    deps.cron.store.recordReachTest(job.id, test);
    return c.json({ webhook: webhookView({ ...job, reachTest: test }, deps) } satisfies { webhook: WebhookSummary });
  });

  /** Mint a new token. The old URL stops working the moment this returns. */
  control.post("/webhooks/:id/rotate", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const job = deps.cron.store.rotateWebhookToken(c.req.param("id"), principal.actor);
    if (!job) return c.json({ error: "no such webhook" }, 404);
    return c.json({ webhook: webhookView(job, deps) } satisfies { webhook: WebhookSummary });
  });

  /**
   * What has fired lately, across every job.
   *
   * Registered before `/cron/:id` — Hono matches in order, and `runs` would otherwise be read as a
   * job id and answer 404. The question it exists for is the one you have *before* you know which
   * job misbehaved, which nothing could answer without opening each one in turn.
   */
  control.get("/cron/runs", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json({
      runs: deps.cron.store.recentRuns(Number.isFinite(limit) ? limit : 100),
      timezone: deps.cron.timezone,
    } satisfies { runs: CronRunEntry[]; timezone: string });
  });

  control.get("/cron/:id", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const job = deps.cron.store.get(c.req.param("id"));
    if (!job) return c.json({ error: "no such job" }, 404);
    return c.json({
      job: { ...job, describes: describeTrigger(job.trigger, deps.cron.timezone) },
      runs: deps.cron.store.runs(job.id, 20),
      timezone: deps.cron.timezone,
    } satisfies { job: JobSummary; runs: JobRunSummary[]; timezone: string });
  });

  control.post("/cron", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const principal = c.get("principal");

    try {
      const input = cronInputFrom(body, principal.actor, deps.cron.timezone);
      // An agent that does not exist used to be accepted here and fail into a log hours later, when
      // the job came due — which is exactly when nobody is watching. Said now, to whoever asked.
      const unknown = unknownAgent(deps, input.agentId);
      if (unknown) return c.json({ error: unknown }, 400);
      const job = deps.cron.store.create(input);
      deps.audit.record({
        action: "cron_create_api",
        agentId: job.agentId,
        actor: principal.actor,
        details: { job: job.id, name: job.name, payload_kind: job.payload.kind },
      });
      return c.json({ job: summaryOf(job, deps.cron.timezone) } satisfies { job: JobSummary });
    } catch (err) {
      // A refusal here is the caller's mistake, not a server fault, and the message is written for
      // them — 500 with a stack trace would hide the one sentence that says which field is wrong.
      if (isCronRefusal(err)) return c.json({ error: (err as Error).message, plain: refusalWords(err) }, 400);
      throw err;
    }
  });

  control.post("/cron/:id", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const existing = deps.cron.store.get(c.req.param("id"));
    if (!existing) return c.json({ error: "no such job" }, 404);

    try {
      const patch = cronPatchFrom(body, deps.cron.timezone);
      const unknown = patch.agentId !== undefined ? unknownAgent(deps, patch.agentId) : null;
      if (unknown) return c.json({ error: unknown }, 400);
      const job = deps.cron.store.update(existing.id, patch, c.get("principal").actor);
      if (!job) return c.json({ error: "no such job" }, 404);
      return c.json({ job: summaryOf(job, deps.cron.timezone) } satisfies { job: JobSummary });
    } catch (err) {
      if (isCronRefusal(err)) return c.json({ error: (err as Error).message, plain: refusalWords(err) }, 400);
      throw err;
    }
  });

  /**
   * *Always for this job* from its page (0.8.0): `{ add: { keys, label } }` — an action its guards held, allowed for its
   * runs from now on — or `{ remove: key }` to take one back. An operator's, as running the job is; a webhook's an
   * admin's, as making one is. Registered before `/cron/:id/:action`, which would take the word for an action.
   */
  control.post("/cron/:id/allowed", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const principal = c.get("principal");
    const job = deps.cron.store.get(c.req.param("id"));
    if (!job) return c.json({ error: "no such job" }, 404);
    if (!atLeast(principal, job.trigger.kind === "webhook" ? "admin" : "operator")) return c.json({ error: job.trigger.kind === "webhook" ? "admin only" : "operator only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { add?: { keys?: unknown; label?: unknown }; remove?: unknown };
    const changed = typeof body.remove === "string" ? deps.cron.store.disallow(job.id, body.remove, principal.actor) : undefined;
    if (changed === null) return c.json({ error: "no such job" }, 404);
    if (changed) return c.json({ job: summaryOf(changed, deps.cron.timezone) } satisfies { job: JobSummary });
    const keys = Array.isArray(body.add?.keys) ? body.add.keys.filter((key): key is string => typeof key === "string" && key.length > 0) : [];
    if (keys.length === 0 || typeof body.add?.label !== "string") return c.json({ error: "send { add: { keys, label } } or { remove: key }" }, 400);
    const allowed = deps.cron.store.allow(job.id, { keys, label: body.add.label }, principal.actor);
    if (!allowed) return c.json({ error: "no such job" }, 404);
    return c.json({ job: summaryOf(allowed, deps.cron.timezone) } satisfies { job: JobSummary });
  });

  control.post("/cron/:id/:action", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const id = c.req.param("id");
    const action = c.req.param("action");
    const principal = c.get("principal");
    const actor = principal.actor;
    const job = deps.cron.store.get(id);
    if (!job) return c.json({ error: "no such job" }, 404);
    if (job.proposal && action === "run") return c.json({ error: "a proposal runs once somebody turns it on" }, 409);
    /**
     * A proposal is turned on, not enabled (0.8.0): it runs as whoever said yes, a change takes the shape of the job it
     * replaces, and its card in the chat says so. A webhook's is an admin's, as making one is.
     */
    if (job.proposal && action === "enable") {
      if (job.trigger.kind === "webhook" && !atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
      const turned = turnOnProposal(deps.cron.store, id, { actor, as: principal.user?.id ?? actor });
      if ("refused" in turned) return c.json({ error: turned.refused, plain: NOT_CHANGED }, 409);
      deps.cron.proposals?.settled(id, settledCard(job, true, principal.user?.displayName?.trim() || actor));
      return c.json({ job: summaryOf(turned.job, deps.cron.timezone) } satisfies { job: JobSummary });
    }

    switch (action) {
      case "enable":
      case "disable":
        const set = deps.cron.store.setEnabled(id, action === "enable", actor);
        if (!set) return c.json({ error: "no such job" }, 404);
        return c.json({ job: summaryOf(set, deps.cron.timezone) } satisfies { job: JobSummary });
      case "run": {
        // Awaited: the caller typed `nouride cron run` to find out whether the job works, and an
        // immediate 200 that says nothing about the outcome is the answer they did not ask for.
        const run = deps.cron.scheduler.runNow(id, actor);
        const wait = asyncWait(c.req.header("prefer"));
        if (wait === null) return c.json({ outcome: await run } satisfies { outcome: RunNowOutcome });
        // A browser asks to be answered within `wait` (RFC 7240): an agent turn can take an hour, and a request held
        // open that long is cut off by its own timeout or a proxy, which read a run still going as a failure. The run
        // goes on either way, and its runs list says how it ended.
        const outcome = await within(run, wait * 1000);
        if (outcome) return c.json({ outcome } satisfies { outcome: RunNowOutcome });
        c.header("Preference-Applied", "respond-async");
        return c.json({ outcome: { status: "running" } } satisfies { outcome: RunNowOutcome }, 202);
      }
      default:
        return c.json({ error: `unknown action "${action}"` }, 400);
    }
  });

  control.delete("/cron/:id", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const id = c.req.param("id");
    const principal = c.get("principal");
    const job = deps.cron.store.get(id);
    if (!job || !deps.cron.store.delete(id, principal.actor)) return c.json({ error: "no such job" }, 404);
    // A proposal deleted is a proposal discarded: its card in the chat says so, and its buttons go.
    if (job.proposal) deps.cron.proposals?.settled(id, settledCard(job, false, principal.user?.displayName?.trim() || principal.actor));
    return c.json({ ok: true, id } satisfies { ok: true; id: string });
  });
}

/** A job as every route here answers it: the stored job, with when it runs in one line of words. */
function summaryOf(job: Job, timezone: string): JobSummary {
  return { ...job, describes: describeTrigger(job.trigger, timezone) };
}

/** Why `agentId` cannot own a job, or null. Empty is the store's to refuse, with its own sentence. */
function unknownAgent(deps: ControlDeps, agentId: string): string | null {
  if (!agentId.trim() || deps.registry.get(agentId)) return null;
  return `no agent "${agentId}": a job must name one that exists`;
}

/** The longest a caller may ask to be kept waiting before a 202 — under the 100 s a common proxy allows. */
const MAX_WAIT_SECONDS = 60;

/**
 * How many seconds the caller will wait for the run before being told it is still going, from
 * `Prefer: respond-async, wait=<seconds>` (RFC 7240) — or null when it did not say `respond-async`, and
 * waits for the whole run, as the CLI does.
 */
function asyncWait(prefer: string | undefined): number | null {
  if (!prefer) return null;
  const preferences = new Map(
    prefer.split(",").map((part) => {
      const [name = "", value] = (part.split(";")[0] ?? "").split("=");
      return [name.trim().toLowerCase(), value?.trim()] as const;
    }),
  );
  if (!preferences.has("respond-async")) return null;
  const wait = Number(preferences.get("wait"));
  return Number.isInteger(wait) && wait >= 0 ? Math.min(wait, MAX_WAIT_SECONDS) : 0;
}

/** `run`'s outcome if it is over within `ms`, or null. The run is not stopped either way. */
async function within<T>(run: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}
