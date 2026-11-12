/**
 * Scheduled jobs. The other view of the same store, the jobs that fire on a request, is `webhooks.ts`.
 */

import type { CronRunEntry, JobRunSummary, JobSummary, RunNowOutcome } from "@nouride/wire";
import type { Job } from "@nouride/shared";
import { describeTrigger } from "@/modules/cron/parse.ts";
import { idsOf } from "@/modules/people/match.ts";
import { atLeast } from "@/modules/users/auth.ts";
import { settledCard, turnOnProposal } from "@/modules/cron/proposals.ts";
import type { CronField } from "@/modules/cron/validate.ts";
import type { JobPayload } from "@nouride/shared";
import { cronInputFrom, cronPatchFrom, cronRefusalField, isCronRefusal, jsonBody } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { NOT_CHANGED, notSaved } from "../plain.ts";
import { jobFor, thingOfJob, thingsFor, type Things } from "../whose.ts";

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
  steps: "the steps",
};

/** A cron refusal in the page's words: the field it names, or what was entered. */
export function refusalWords(err: unknown): string {
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
  //
  // And each job is a person's (`whose.ts`): read by whoever sees it, changed by its owner or an admin. For anyone
  // else a job named by its id is answered as one that is not there.

  control.get("/cron", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const things = thingsFor(deps, c.get("principal"), c.req.query("whose"));
    const jobs = deps.cron.store
      .list({
        ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}),
        includeDisabled: c.req.query("all") === "1",
      })
      .filter((job) => things.listed(thingOfJob(job)));
    return c.json({
      // Webhook jobs are excluded here and listed by /webhooks instead. One store, two views: what
      // you want to see about a scheduled job is when it next runs, and what you want to see about a
      // webhook is its URL. A single table showing "next run: never" for half its rows serves
      // neither question.
      jobs: jobs.filter((job) => job.trigger.kind !== "webhook").map((job) => summaryOf(job, deps.cron!.timezone, things)),
      timezone: deps.cron.timezone,
    } satisfies { jobs: JobSummary[]; timezone: string });
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
    // A run is its job's: of the jobs the reader sees. One whose job is gone is an admin's.
    const things = thingsFor(deps, c.get("principal"));
    const seen = new Map<string, boolean>();
    const mine = (jobId: string): boolean => {
      if (!seen.has(jobId)) {
        const job = deps.cron!.store.get(jobId);
        seen.set(jobId, job ? things.sees(thingOfJob(job)) : things.reader.everyone);
      }
      return seen.get(jobId)!;
    };
    return c.json({
      runs: deps.cron.store.recentRuns(Number.isFinite(limit) ? limit : 100).filter((run) => mine(run.jobId)),
      timezone: deps.cron.timezone,
    } satisfies { runs: CronRunEntry[]; timezone: string });
  });

  control.get("/cron/:id", (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const found = jobFor(deps, c.get("principal"), c.req.param("id"));
    if (!found) return c.json({ error: "no such job" }, 404);
    const { job } = found;
    return c.json({
      job: summaryOf(job, deps.cron.timezone, found.things),
      runs: deps.cron.store.runs(job.id, 20),
      timezone: deps.cron.timezone,
    } satisfies { job: JobSummary; runs: JobRunSummary[]; timezone: string });
  });

  control.post("/cron", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const principal = c.get("principal");

    try {
      // Its maker's: the account, as People writes one. The command line's is nobody's.
      const input = { ...cronInputFrom(body, principal.actor, deps.cron.timezone), ...(principal.user ? { owner: `web:${principal.user.id}` } : {}) };
      // An agent that does not exist used to be accepted here and fail into a log hours later, when
      // the job came due — which is exactly when nobody is watching. Said now, to whoever asked.
      const unknown = unknownAgent(deps, input.agentId) ?? unknownStepAgent(deps, input.payload);
      if (unknown) return c.json({ error: unknown }, 400);
      const job = deps.cron.store.create(input);
      deps.audit.record({
        action: "cron_create_api",
        agentId: job.agentId,
        actor: principal.actor,
        details: { job: job.id, name: job.name, payload_kind: job.payload.kind },
      });
      return c.json({ job: summaryOf(job, deps.cron.timezone, thingsFor(deps, principal)) } satisfies { job: JobSummary });
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
    const found = jobFor(deps, c.get("principal"), c.req.param("id"));
    // A proposal is answered, not rewritten: only its owner or an admin edits a job.
    const existing = found?.owned ? found.job : null;
    if (!existing) return c.json({ error: "no such job" }, 404);

    try {
      const patch = cronPatchFrom(body, deps.cron.timezone);
      const unknown = (patch.agentId !== undefined ? unknownAgent(deps, patch.agentId) : null) ?? unknownStepAgent(deps, patch.payload);
      if (unknown) return c.json({ error: unknown }, 400);
      const job = deps.cron.store.update(existing.id, patch, c.get("principal").actor);
      if (!job) return c.json({ error: "no such job" }, 404);
      return c.json({ job: summaryOf(job, deps.cron.timezone, found!.things) } satisfies { job: JobSummary });
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
    const found = jobFor(deps, principal, c.req.param("id"));
    const job = found?.owned ? found.job : null;
    if (!job) return c.json({ error: "no such job" }, 404);
    const things = found!.things;
    if (!atLeast(principal, job.trigger.kind === "webhook" ? "admin" : "operator")) return c.json({ error: job.trigger.kind === "webhook" ? "admin only" : "operator only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { add?: { keys?: unknown; label?: unknown }; remove?: unknown };
    const changed = typeof body.remove === "string" ? deps.cron.store.disallow(job.id, body.remove, principal.actor) : undefined;
    if (changed === null) return c.json({ error: "no such job" }, 404);
    if (changed) return c.json({ job: summaryOf(changed, deps.cron.timezone, things) } satisfies { job: JobSummary });
    const keys = Array.isArray(body.add?.keys) ? body.add.keys.filter((key): key is string => typeof key === "string" && key.length > 0) : [];
    if (keys.length === 0 || typeof body.add?.label !== "string") return c.json({ error: "send { add: { keys, label } } or { remove: key }" }, 400);
    const allowed = deps.cron.store.allow(job.id, { keys, label: body.add.label }, principal.actor);
    if (!allowed) return c.json({ error: "no such job" }, 404);
    return c.json({ job: summaryOf(allowed, deps.cron.timezone, things) } satisfies { job: JobSummary });
  });

  /**
   * Whose it is, set by an admin: `{ person: <key> }` hands it to that person, `{ person: null }` to nobody. For the
   * ones nobody owns: made from the command line, or from before with nothing a person could be read from. Registered
   * before `/cron/:id/:action`, which would take the word for an action.
   */
  control.post("/cron/:id/owner", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { person?: unknown };
    if (body.person !== null && typeof body.person !== "string") return c.json({ error: "send { person: <key> } or { person: null }" }, 400);
    const person = body.person === null ? null : deps.ctx.config.people.find((one) => one.key === body.person);
    if (person === undefined) return c.json({ error: `no person "${String(body.person)}" in People` }, 400);
    // Kept as an id of theirs People reads: their account where they have one, so what they make later sits beside it.
    const ids = person ? idsOf(person) : [];
    const owner = person ? (ids.find((id) => id.startsWith("web:")) ?? ids[0] ?? null) : null;
    if (person && !owner) return c.json({ error: `${person.name ?? person.key} has no account or chat id in People to hold it by`, plain: NOT_CHANGED }, 400);
    const job = deps.cron.store.setOwner(c.req.param("id"), owner, principal.actor);
    if (!job) return c.json({ error: "no such job" }, 404);
    return c.json({ job: summaryOf(job, deps.cron.timezone, thingsFor(deps, principal)) } satisfies { job: JobSummary });
  });

  control.post("/cron/:id/:action", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);
    const id = c.req.param("id");
    const action = c.req.param("action");
    const principal = c.get("principal");
    const actor = principal.actor;
    const found = jobFor(deps, principal, id);
    // Another person's job is not there for this reader; one they only read is not theirs to run, pause or turn on.
    if (!found?.changeable) return c.json({ error: "no such job" }, 404);
    const { job, things } = found;
    if (job.proposal && action === "run") return c.json({ error: "a proposal runs once somebody turns it on" }, 409);
    /**
     * A proposal is turned on, not enabled (0.8.0): it runs as whoever said yes, a change takes the shape of the job it
     * replaces, and its card in the chat says so. A webhook's is an admin's, as making one is.
     */
    if (job.proposal && action === "enable") {
      if (job.trigger.kind === "webhook" && !atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
      const turned = turnOnProposal(deps.cron.store, id, { actor, as: principal.user?.id ?? actor, ...(principal.user ? { owner: `web:${principal.user.id}` } : {}) });
      if ("refused" in turned) return c.json({ error: turned.refused, plain: NOT_CHANGED }, 409);
      deps.cron.proposals?.settled(id, settledCard(job, true, principal.user?.displayName?.trim() || actor));
      return c.json({ job: summaryOf(turned.job, deps.cron.timezone, thingsFor(deps, principal)) } satisfies { job: JobSummary });
    }

    switch (action) {
      case "enable":
      case "disable":
        const set = deps.cron.store.setEnabled(id, action === "enable", actor);
        if (!set) return c.json({ error: "no such job" }, 404);
        return c.json({ job: summaryOf(set, deps.cron.timezone, things) } satisfies { job: JobSummary });
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
    const found = jobFor(deps, principal, id);
    const job = found?.changeable ? found.job : null;
    if (!job || !deps.cron.store.delete(id, principal.actor)) return c.json({ error: "no such job" }, 404);
    // A proposal deleted is a proposal discarded: its card in the chat says so, and its buttons go.
    if (job.proposal) deps.cron.proposals?.settled(id, settledCard(job, false, principal.user?.displayName?.trim() || principal.actor));
    return c.json({ ok: true, id } satisfies { ok: true; id: string });
  });
}

/**
 * A job as every route here answers it: the stored job, when it runs in one line of words, whose it is and whether
 * the reader may change it. Its owner goes out as the person, never as the id it is kept under.
 */
function summaryOf(job: Job, timezone: string, things: Things): JobSummary {
  const { owner: _owner, ...shown } = job;
  return { ...shown, describes: describeTrigger(job.trigger, timezone), ...things.said(thingOfJob(job)) };
}

/** Why `agentId` cannot own a job, or null. Empty is the store's to refuse, with its own sentence. */
function unknownAgent(deps: ControlDeps, agentId: string): string | null {
  if (!agentId.trim() || deps.registry.get(agentId)) return null;
  return `no agent "${agentId}": a job must name one that exists`;
}

/** The same for a step that names an agent of its own, in a job of several: said at the request, with the step's number. */
export function unknownStepAgent(deps: ControlDeps, payload: JobPayload | undefined): string | null {
  if (payload?.kind !== "steps") return null;
  for (const [index, step] of payload.steps.entries()) {
    if ((step.kind === "agentTurn" || step.kind === "mission") && step.agentId && !deps.registry.get(step.agentId)) return `step ${index + 1}: no agent "${step.agentId}": a step must name one that exists`;
  }
  return null;
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
