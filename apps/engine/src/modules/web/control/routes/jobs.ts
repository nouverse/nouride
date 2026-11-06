/**
 * Background jobs — what is running, what it printed, and how to stop it.
 */

import type { ControlApp, ControlDeps } from "../types.ts";

export function registerJobRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/jobs", (c) => {
    if (!deps.jobs) return c.json({ error: "background jobs are not enabled" }, 501);
    // `limit` past the default 20, up to the store's cap; `all=1` every row retention has left — `nouride jobs --all` and
    // Helpers & jobs (0.8.12).
    const limit = Number(c.req.query("limit"));
    return c.json({
      jobs: deps.jobs.listSnapshots({
        ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}),
        ...(c.req.query("all") === "1" ? { all: true } : Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      }),
    });
  });

  control.get("/jobs/:id/log", async (c) => {
    if (!deps.jobs) return c.json({ error: "background jobs are not enabled" }, 501);
    const id = c.req.param("id");
    const job = deps.jobs.getSnapshot(id);
    if (!job) return c.json({ error: "no such job", id }, 404);
    // Bounded: a build log is megabytes and this is a JSON response. The full file is on disk, and the
    // job record names it.
    return c.json({ id, job, log: await deps.jobs.tail(id, 20_000) });
  });

  control.post("/jobs/:id/kill", (c) => {
    if (!deps.jobs) return c.json({ error: "background jobs are not enabled" }, 501);
    const id = c.req.param("id");
    return deps.jobs.kill(id, "cli")
      ? c.json({ ok: true, id })
      : c.json({ error: "not running", id }, 409);
  });
}
