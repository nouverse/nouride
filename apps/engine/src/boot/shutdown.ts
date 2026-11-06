/**
 * Shutdown: the signal handlers, and the order things stop in (§14.1 SPEC).
 *
 * The order is the whole content of this file, and it is the reverse of boot for a reason —
 * stop accepting work, finish what is in flight, then close what it was written to. Getting it
 * wrong loses a turn's context silently, which is why `drain` is exported and tested on its own.
 */

import { createLogger } from "@nouride/shared";
import { exitProcess, onShutdownSignal, type SqliteDb } from "@nouride/runtime";
import { markCleanShutdown } from "./integrity.ts";
import type { DaemonContext } from "@/commons/context.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { Pipeline } from "@/modules/pipeline/index.ts";
import type { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { CronScheduler } from "@/modules/cron/scheduler.ts";
import { closeAllSessions } from "@/modules/tools/builtins/sessions.ts";
import { stopTurns } from "@/boot/interrupted.ts";
import { crashDetail } from "@/commons/crash.ts";

const log = createLogger("daemon");

export function installShutdown(
  ctx: DaemonContext,
  db: SqliteDb,
  pipeline: Pipeline,
  audit: AuditPort,
  approvals: SqliteApprovalGate,
  jobs: JobsPort,
  server: { stop(closeActive?: boolean): Promise<void> } | undefined,
  lock: { release(): void },
  scheduler: CronScheduler,
  /** The in-process LLM gateway, when this install hosts one. See `nougate-inproc.ts`. */
  nougate: { stop(): Promise<void> } | null,
  /** The log table's write buffer, so its last lines are flushed before the database closes. */
  logs: { stop(): void },
  /** The event streams open on the control API, ended before the server stops (`web/control/streams.ts`). */
  streams?: { closeAll(): number },
): void {
  let shuttingDown = false;

  // ── Global error safety net ──────────────────────────────────────────────
  // Any fire-and-forget `void` promise that rejects without a .catch() would otherwise kill the
  // process silently. Log it and trigger the same graceful shutdown path as a signal.
  // Logged, and the process keeps running.
  //
  // It used to shut down here, and that was wrong in a way only production showed. Installing this
  // handler is itself what stops the runtime terminating on an unhandled rejection — so once it
  // exists, the `process.kill` inside it is the *only* thing killing the daemon. One stray rejection
  // anywhere then ended every conversation on every gateway.
  //
  // Observed exactly that: Telegram's polling promise rejected with a transient 409, and a daemon
  // serving several chats shut itself down over it, restarted, and did it again.
  //
  // The gap the audit actually named was "dies with **no log**". The answer to that is the log. A
  // rejection is evidence of a missing `.catch()` somewhere — worth finding and fixing at the source,
  // as the Telegram one was — not a reason to take down work that has nothing to do with it.
  //
  // Both handlers are listeners like any other (`lint:timers`): one that threw would end the process on the spot,
  // without the graceful shutdown either of them exists to give. A log line that cannot be written is the only thing
  // here that can throw, and losing it is better than losing the daemon.
  process.on("unhandledRejection", (reason) => {
    try {
      const { error, stack } = crashDetail(reason);
      log.error("unhandled promise rejection: this is a missing .catch(), not a reason to stop", {
        reason: error,
        ...(stack ? { stack } : {}),
      });
    } catch {
      // Nowhere left to say it.
    }
  });
  // This one *does* shut down, and the asymmetry with the handler above is deliberate. A rejected
  // promise is a value nobody read; execution continued normally and the rest of the process is
  // unaffected. An uncaught exception unwound a stack somewhere — whatever it was doing is now half
  // done, and carrying on means working from state no one can vouch for. Shutting down cleanly saves
  // the sessions; carrying on risks writing nonsense into them.
  process.on("uncaughtException", (err) => {
    try {
      log.error("uncaught exception: triggering shutdown", crashDetail(err));
    } catch {
      // The log could not be written; the shutdown is still what an uncaught exception means.
    } finally {
      process.kill(process.pid, "SIGTERM");
    }
  });

  onShutdownSignal((signal) => {
    if (shuttingDown) {
      // Second signal means whoever sent the first has stopped waiting. Honour that rather
      // than politely finishing the sequence.
      log.warn("second signal received: exiting immediately", { signal });
      exitProcess(1);
    }
    shuttingDown = true;
    ctx.status = "shutting_down";
    log.info("shutting down", { signal, timeout_ms: ctx.config.daemon.shutdownTimeoutMs });

    const deadline = new Promise<"timeout">((r) =>
      setTimeout(() => r("timeout"), ctx.config.daemon.shutdownTimeoutMs),
    );
    // Which step the drain is on, said if it runs out of time: on 2026-11-01 a stop on the live box sat its full 30 s
    // with nothing logged after "shutting down", and nothing said what it was waiting for.
    const progress = { step: "starting" };

    void Promise.race([
      drain(
        ctx,
        db,
        pipeline,
        audit,
        approvals,
        jobs,
        server,
        lock,
        scheduler,
        nougate ?? undefined,
        logs,
        streams,
        progress,
      ),
      deadline,
    ])
      .then((outcome) => {
        if (outcome === "timeout") {
          log.warn("shutdown timed out, forcing exit (WAL keeps the database consistent)", { waiting_on: progress.step });
          exitProcess(1);
        }
        log.info("shutdown complete");
        exitProcess(0);
      })
      .catch((err: unknown) => {
        log.error("drain threw during shutdown, forcing exit", { error: String(err) });
        exitProcess(1);
      });
  });
}

export async function drain(
  ctx: DaemonContext,
  db: SqliteDb,
  pipeline: Pipeline,
  audit: AuditPort,
  approvals: SqliteApprovalGate,
  jobs: JobsPort,
  server: { stop(closeActive?: boolean): Promise<void> } | undefined,
  lock: { release(): void },
  /**
   * Optional so the shutdown-order tests can drive this without a scheduler, and because a daemon
   * with `[cron] enabled = false` never builds one.
   */
  scheduler?: { stop(timeoutMs?: number): Promise<void> },
  /**
   * The in-process LLM gateway, when this install hosts one — see `nougate-inproc.ts`.
   *
   * Optional for the same reason `scheduler` is: the shutdown-order tests drive this directly, and
   * almost no install hosts one.
   */
  nougate?: { stop(): Promise<void> },
  /**
   * The log table's write buffer, flushed beside the audit log's.
   *
   * Optional for the same reason the two above are — the shutdown-order tests drive this directly.
   * It matters because its flush timer is unref'd and fires every two seconds: one that lands after
   * the database closes writes an error line about failing to write a log line, which is precisely
   * the "one shutdown poisons a log with an error from nowhere" shape this file already guards
   * against elsewhere.
   */
  logs?: { stop(): void },
  /**
   * The event streams open on the control API. A stream never finishes on its own, and the server's graceful stop
   * waits for every response to: ended first, one open dashboard tab no longer holds the shutdown to its deadline.
   */
  streams?: { closeAll(): number },
  /** Set to each step before it is waited on, so a drain that runs out of time can say which one held it. */
  progress: { step: string } = { step: "" },
): Promise<"clean"> {
  // Before the gateways, because these are the only things left that can start new database work
  // without anyone asking. Everything below assumes no new work is arriving.
  for (const timer of ctx.backgroundTimers) clearInterval(timer);

  /**
   * **First, while the gateways still work.** The turns in flight stop at their next step, close with
   * everything they did, and tell their chats so — `stopTurns`.
   *
   * The ordering is the whole point and it is not obvious from reading downwards: the gateway loop
   * below leaves each connection `disconnected`, and `send()` on a disconnected gateway buffers into
   * a 100-entry in-memory ring with no table behind it. A message written after that line is a
   * message that dies with the process. So this is the last moment anybody can be told anything.
   *
   * What is waiting in the queue is not started: it stays in the inbox and is answered after the
   * restart (`Pipeline.pause`).
   */
  // Half the drain's budget to stop at a step, a sixth more for an abort to close: 15 s and 5 s of the
  // default 30, leaving the rest for everything below.
  const budget = ctx.config.daemon.shutdownTimeoutMs;
  progress.step = "stopping the turns in flight";
  await stopTurns({ pipeline, pauseMs: budget / 2, abortMs: budget / 6 });

  // The scheduler is the other thing that starts work nobody asked for, and it has to stop *before*
  // the gateways: a run already in flight still has a reply to deliver, and taking its gateway away
  // first turns a completed job into a failed one on the way out.
  progress.step = "stopping the scheduler";
  await scheduler?.stop();

  // Inbound first: gateways stop delivering before anything else winds down, so no work
  // arrives for a subsystem that is already closing.
  for (const [id, gateway] of ctx.gateways) {
    progress.step = `stopping gateway ${id}`;
    try {
      await gateway.stop();
    } catch (err) {
      log.warn("gateway stop failed", { gateway: id, error: String(err) });
    }
  }

  // **Before draining, not after.** A turn parked on an approval cannot finish, and nobody is going to
  // answer it — the gateways are already stopped. Releasing it afterwards meant `pipeline.drain()` waited on a
  // turn that was waiting on a human who could no longer reply, so shutdown sat for the full
  // `shutdown_timeout_ms` and then force-exited. Observed: a pending `exec` approval turned a clean stop
  // into `shutdown timed out — forcing exit` every time.
  //
  // Released, and the questions kept (D8): they were expired here, so a restart answered every pending approval
  // "deny". The rows stay pending and the next boot asks them again for the time they have left — or expires them,
  // and tells their chats, when too little is (`boot/approvals-kept.ts`). Logged by the gate, with how many.
  approvals.handOver();

  // Then let in-flight turns finish. Sessions are persisted inside the turn, so a turn that
  // completes here is a turn whose context is safely on disk.
  progress.step = "waiting for the turns to end";
  await pipeline.drain();

  // After the turns, because a turn in flight may still be calling one of these, and before the job
  // sweep below for the same reason it exists: every child we spawned gets reaped, MCP servers
  // included. A stdio server left running is an orphan holding whatever the daemon handed it.
  progress.step = "closing MCP servers";
  try {
    await ctx.mcp?.close();
  } catch (err) {
    log.warn("mcp shutdown failed", { error: String(err) });
  }

  // Children die with us. We cannot tell `bun test` (safe to orphan) from `docker compose up -d`
  // (meant to outlive us), and a daemon that leaves unknown processes behind is worse than one that
  // stops them. Their rows become `interrupted` on the next boot.
  //
  // Marks the store closed as well as killing the children, so a completion that lands after the
  // database closes is a logged no-op instead of an unhandled rejection during shutdown.
  progress.step = "stopping background jobs";
  const stopped = await jobs.killAll();
  if (stopped > 0) log.info("stopped background jobs", { count: stopped });

  // Same reasoning one line up, and the same answer: a held process must not outlive the daemon that
  // is holding it. An interactive session has nobody left to type into it once we are gone.
  const closedSessions = closeAllSessions();
  if (closedSessions > 0) log.info("closed interactive sessions", { count: closedSessions });

  // After the drain, before the database closes. An approval timeout is measured in minutes and the
  // timer outlives everything else — firing against a closed database is an unhandled rejection with
  // nobody to catch it, which is how one shutdown poisons a log with an error from nowhere.
  approvals.shutDown();

  // Last write before the database closes.
  audit.record({ action: "daemon_stopped", actor: "system" });
  audit.stop();
  logs?.stop();

  const ended = streams?.closeAll() ?? 0;
  if (ended > 0) log.info("closed open event streams", { count: ended });
  progress.step = "closing the control server";
  if (server) await stopServer(server);
  /**
   * After the control plane, before the lock.
   *
   * A turn that is still draining may be mid-stream against this gateway, so stopping it earlier
   * would fail the very work the drain is waiting for. Nothing reaches it once the drain is done and
   * the control plane is closed. Awaited: the gateway writes what its heartbeat holds as it stops, and
   * the process ends right after this returns.
   */
  progress.step = "stopping the model gateway";
  await nougate?.stop();
  lock.release();
  // The planner's statistics, refreshed where a day of writes made them stale — cheap when they are not.
  try {
    db.optimize();
  } catch {
    // A shutdown is not where to report a statistics refresh that did not happen.
  }
  db.close();
  // Last: only a run that got this far stopped cleanly, and the next boot may skip its check (`boot/integrity.ts`).
  markCleanShutdown(ctx.config.daemon.dataDir, ctx.integrity);
  return "clean";
}

/** How long the server's graceful stop may wait on a request before the connections are closed under it. */
const SERVER_GRACE_MS = 2_000;

/**
 * The server stopped gracefully, then — for a request still open after `SERVER_GRACE_MS` — not.
 *
 * Everything that matters was flushed before this: what is left open is a reader, and none of it is going to
 * finish for a shutdown. The event streams are ended before this is called; the grace is the net for whatever
 * else holds a connection — and it keeps the lock's release, the database's close and the clean-shutdown mark,
 * which a forced exit at the deadline skips, from waiting on it.
 */
async function stopServer(server: { stop(closeActive?: boolean): Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = await Promise.race([
    server.stop(false).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), SERVER_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!late) return;
  log.warn("requests still open after the grace: closing them", { grace_ms: SERVER_GRACE_MS });
  await server.stop(true);
}
