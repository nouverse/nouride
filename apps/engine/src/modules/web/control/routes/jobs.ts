/**
 * Background jobs — what is running, what it printed, and how to stop it.
 */

import type { BackgroundJob } from "@nouride/wire";
import type { ControlApp, ControlDeps } from "../types.ts";
import { mayOpen, readerOf, Spoke, type Reader } from "../whose.ts";

/**
 * A job is its chat's: its command and what it printed are part of that conversation, read by whoever may open it
 * (`whose.ts`). One with no chat — started by the daemon itself — is everyone's.
 */
function theirs(deps: ControlDeps, reader: Reader, job: Pick<BackgroundJob, "gatewayId" | "chatId">, spoke?: Spoke): boolean {
  if (reader.everyone || !job.gatewayId || !job.chatId) return true;
  return mayOpen(deps, reader, { gatewayId: job.gatewayId, chatId: job.chatId, openedBy: deps.sessions?.openerOfChat(job.gatewayId, job.chatId) }, spoke);
}

export function registerJobRoutes(control: ControlApp, deps: ControlDeps): void {
  const readerIn = (principal: Parameters<typeof readerOf>[0]) => readerOf(principal, deps.ctx.config.people);

  control.get("/jobs", (c) => {
    if (!deps.jobs) return c.json({ error: "background jobs are not enabled" }, 501);
    // `limit` past the default 20, up to the store's cap; `all=1` every row retention has left — `nouride jobs --all` and
    // Helpers & jobs (0.8.12).
    const limit = Number(c.req.query("limit"));
    const reader = readerIn(c.get("principal"));
    const spoke = new Spoke(deps, reader);
    return c.json({
      jobs: deps.jobs
        .listSnapshots({
          ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}),
          ...(c.req.query("all") === "1" ? { all: true } : Number.isInteger(limit) && limit > 0 ? { limit } : {}),
        })
        .filter((job) => theirs(deps, reader, job, spoke)),
    } satisfies { jobs: BackgroundJob[] });
  });

  control.get("/jobs/:id/log", async (c) => {
    if (!deps.jobs) return c.json({ error: "background jobs are not enabled" }, 501);
    const id = c.req.param("id");
    const job = deps.jobs.getSnapshot(id);
    if (!job || !theirs(deps, readerIn(c.get("principal")), job)) return c.json({ error: "no such job", id }, 404);
    // Bounded: a build log is megabytes and this is a JSON response. The full file is on disk, and the
    // job record names it.
    return c.json({ id, job, log: await deps.jobs.tail(id, 20_000) } satisfies { id: string; job: BackgroundJob; log: string });
  });

  control.post("/jobs/:id/kill", (c) => {
    if (!deps.jobs) return c.json({ error: "background jobs are not enabled" }, 501);
    const id = c.req.param("id");
    const job = deps.jobs.getSnapshot(id);
    // Answered as a job that is not running, as one that is not there is.
    if (job && !theirs(deps, readerIn(c.get("principal")), job)) return c.json({ error: "not running", id }, 409);
    return deps.jobs.kill(id, "cli")
      ? c.json({ ok: true, id } satisfies { ok: true; id: string })
      : c.json({ error: "not running", id }, 409);
  });
}
