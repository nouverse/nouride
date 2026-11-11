/**
 * Automations: every job on one list, whatever starts it, and the steps that wait for a person.
 *
 * The same rows `routes/cron.ts` serves as scheduled jobs and as webhooks, read once for the page that shows both. What
 * differs between a schedule and a webhook is one field (`start`) and what goes with it: a next time, or an address.
 * Writing a job stays where it was (`/cron`, `/webhooks`): the addresses an install and its scripts already use.
 */

import type { AutomationStart, AutomationSummary, JobRunSummary, WaitingStep } from "@nouride/wire";
import type { Job } from "@nouride/shared";
import { describeTrigger } from "@/modules/cron/parse.ts";
import { jsonBody, webhookView } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { NOT_CHANGED } from "../plain.ts";

function startOf(job: Job): AutomationStart {
  return job.trigger.kind === "webhook" ? "webhook" : job.trigger.kind === "manual" ? "manual" : "scheduled";
}

/** A job as the page lists it: when it runs in words, a webhook's address, its newest run, and a change that waits. */
function automationOf(job: Job, deps: ControlDeps, all: readonly Job[]): AutomationSummary {
  const cron = deps.cron!;
  const hook = job.trigger.kind === "webhook" ? webhookView(job, deps) : null;
  const [lastRun] = cron.store.runs(job.id, 1);
  const suggested = all.find((other) => other.proposal?.replaces === job.id);
  return {
    ...job,
    describes: describeTrigger(job.trigger, cron.timezone),
    start: startOf(job),
    ...(hook ? { hook: { webhookToken: hook.webhookToken, path: hook.path, url: hook.url, urlGuessed: hook.urlGuessed, reach: hook.reach } } : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(suggested ? { suggested: suggested.id } : {}),
  };
}

export function registerAutomationRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/automations", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const all = deps.cron.store.list({ ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}), includeDisabled: true });
    return c.json({
      automations: all.map((job) => automationOf(job, deps, all)),
      timezone: deps.cron.timezone,
    } satisfies { automations: AutomationSummary[]; timezone: string });
  });

  /** Registered before `/automations/:id`: Hono matches in order, and `waiting` would be read as a job's id. */
  control.get("/automations/waiting", (c) => {
    if (!deps.cron) return c.json({ waiting: [] } satisfies { waiting: WaitingStep[] });
    const store = deps.cron.store;
    const waiting = store.waitingRuns().flatMap(({ run, state }): WaitingStep[] => {
      const job = store.get(run.jobId);
      if (!job || state.wait.kind !== "approval") return [];
      const said = state.before?.said.trim();
      return [{ runId: run.id, jobId: job.id, jobName: job.name, agentId: job.agentId, ask: state.wait.ask, ...(said ? { said: said.slice(0, 2000) } : {}), since: state.wait.since, until: state.wait.until }];
    });
    return c.json({ waiting } satisfies { waiting: WaitingStep[] });
  });

  /** A person's answer to a step that waits for one. The run goes on behind the answer: its page shows how. */
  control.post("/automations/runs/:runId/answer", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    // A write, so an operator's or an admin's: the rule every route here is under refuses a viewer before this runs.
    const principal = c.get("principal");
    const body = ((await jsonBody(c)) ?? {}) as { go?: unknown };
    if (typeof body.go !== "boolean") return c.json({ error: "send { go: true } to continue, or { go: false } to stop" }, 400);
    const by = principal.user?.displayName?.trim() || principal.actor;
    const answered = deps.cron.scheduler.answerRun(c.req.param("runId"), body.go, by, "dashboard");
    if ("refused" in answered) return c.json({ error: answered.refused, plain: NOT_CHANGED }, 409);
    deps.audit.record({ action: "cron_step_answer", actor: principal.actor, details: { run: c.req.param("runId"), go: body.go } });
    return c.json({ ok: true } satisfies { ok: true });
  });

  control.get("/automations/:id", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const all = deps.cron.store.list({ includeDisabled: true });
    const job = all.find((one) => one.id === c.req.param("id"));
    if (!job) return c.json({ error: "no such job" }, 404);
    const automation = automationOf(job, deps, all);
    const suggested = automation.suggested ? all.find((one) => one.id === automation.suggested) : undefined;
    return c.json({
      automation,
      runs: deps.cron.store.runs(job.id, 20),
      ...(suggested ? { suggested: automationOf(suggested, deps, all) } : {}),
      timezone: deps.cron.timezone,
    } satisfies { automation: AutomationSummary; runs: JobRunSummary[]; suggested?: AutomationSummary; timezone: string });
  });
}
