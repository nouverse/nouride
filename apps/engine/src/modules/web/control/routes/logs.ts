/**
 * The daemon's log and the audit log, read from the dashboard and the command line.
 *
 * An admin's to read, each of them, and asked first: every line of every person's chats, commands and decisions is in
 * them, which is more than an operator's own chats. The command line asks with the control token, an admin.
 */

import type { LogLevel } from "@nouride/shared";
import type { AuditEntry, StoredLogEntry } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

const ADMINS_READ_LOGS = { error: "admin only", plain: "Only an admin can read the logs." };

export function registerLogRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * Recent log lines.
   *
   * The journal remains the full history; this is the window debugging actually uses, available on
   * every platform and over the network. `oldest`/`latest` are returned so a caller can tell whether
   * it has fallen behind the ring rather than silently missing lines.
   */
  control.get("/logs", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_READ_LOGS, 403);
    if (!deps.logs) return c.json({ error: "log buffer is not enabled" }, 501);

    const level = c.req.query("level");
    const since = Number.parseInt(c.req.query("since") ?? "", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);

    return c.json({
      entries: deps.logs.query({
        ...(level === "debug" || level === "info" || level === "warn" || level === "error"
          ? { minLevel: level }
          : {}),
        ...(c.req.query("component") ? { component: c.req.query("component")! } : {}),
        ...(Number.isFinite(since) ? { since } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
      oldest: deps.logs.oldestSeq(),
      latest: deps.logs.latestSeq(),
    });
  });

  /**
   * The log as it is on disk — what System Logs reads.
   *
   * Separate from `/logs` above rather than replacing it. That one answers "what has happened since
   * sequence N", which is what a follower like `nouride logs -f` needs and what the in-memory ring is
   * shaped for. This one answers "show me the last few days, filtered, searchable, and still there
   * after a restart", which a ring structurally cannot.
   */
  control.get("/logs/stored", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_READ_LOGS, 403);
    if (!deps.logStore) return c.json({ error: "log storage is not enabled" }, 501);

    const level = c.req.query("level");
    const before = Number.parseInt(c.req.query("before") ?? "", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    // Narrowed to the three levels the table holds — `debug` is not stored, so accepting it here
    // would answer an empty list to a filter that looks like it should work.
    const minLevel: LogLevel | undefined =
      level === "info" || level === "warn" || level === "error" ? level : undefined;
    const query = {
      ...(minLevel ? { minLevel } : {}),
      ...(c.req.query("component") ? { component: c.req.query("component")! } : {}),
      ...(c.req.query("q")?.trim() ? { search: c.req.query("q")!.trim() } : {}),
    };

    const entries = deps.logStore.query({
      ...query,
      ...(Number.isFinite(before) && before > 0 ? { before } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });

    return c.json({
      entries,
      // The count for *these* filters, so "1 of 12,904" is the real denominator rather than the page.
      total: deps.logStore.count(query),
      // The cursor for the next page. Absent means this was the last one — the daemon decides that,
      // because it is the only thing that knows the page was full.
      ...(entries.length === (Number.isFinite(limit) ? limit : 200)
        ? { nextBefore: entries[entries.length - 1]!.id }
        : {}),
      components: deps.logStore.components(),
      span: deps.logStore.span(),
      retentionDays: deps.ctx.config.retention.logDays,
    } satisfies { entries: StoredLogEntry[]; total: number; nextBefore?: number; components: { component: string; entries: number }[]; span: { oldest: number | null; newest: number | null }; retentionDays: number });
  });

  control.get("/audit", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_READ_LOGS, 403);
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
    return c.json({
      entries: deps.audit.recent(Number.isNaN(limit) ? 50 : Math.min(limit, 500), c.req.query("agent")),
    } satisfies { entries: AuditEntry[] });
  });
}
