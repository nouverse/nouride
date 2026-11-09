/**
 * A tool call the turn stops waiting for once the turn itself is stopped.
 *
 * `/stop` and the turn's clock only abort the turn's signal. A tool that does not listen to it — an MCP server that
 * never answers, a library call with no way to cancel it — held the turn, and every later message in its chat queued
 * behind it, until the daemon restarted. So the call is raced against the signal: once it aborts, the tool has a grace
 * to stop by itself, and past that the call is answered as stopped and the turn ends as any stopped turn does.
 *
 * Only a stop ends the wait. There is deliberately no deadline per call: an approval or a question waits for a person
 * on purpose, and a long build is a long build.
 */

import { contained, createLogger, type ToolResult } from "@nouride/shared";

const log = createLogger("llm.executor");

/** How long a tool has, once its turn is stopped, to stop by itself. */
export const STOPPED_CALL_GRACE_MS = 5_000;

/** Who the call was, for the log lines about it — never what it was given. */
interface CallOf {
  tool: string;
  agentId: string;
  turnId?: string;
}

/**
 * The call's own result, or — when `signal` aborts and the call has not settled `graceMs` later — a result that says it
 * was stopped and may still be running. A call left running is not cancelled (nothing here can): when it does settle,
 * that is logged, and its failure is caught rather than left unhandled.
 */
export async function untilStopped(run: Promise<ToolResult>, signal: AbortSignal | undefined, graceMs: number, call: CallOf): Promise<ToolResult> {
  if (!signal) return await run;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<"stopped">((resolve) => {
    const wait = contained(log, "could not start waiting out a stopped call", () => {
      timer = setTimeout(() => resolve("stopped"), graceMs);
    });
    onAbort = wait;
    if (signal.aborted) wait();
    else signal.addEventListener("abort", wait, { once: true });
  });
  try {
    const first = await Promise.race([run, stopped]);
    if (first !== "stopped") return first;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }

  const fields = { agent_id: call.agentId, turn_id: call.turnId, tool: call.tool, grace_ms: graceMs };
  log.warn("a tool did not stop with its turn; the turn goes on without it", fields);
  run.then(
    () => log.info("a tool left running after its turn was stopped has finished", fields),
    (err: unknown) => log.warn("a tool left running after its turn was stopped has failed", { ...fields, error: String(err) }),
  );
  return {
    content:
      `Stopped: this turn was stopped while ${call.tool} was running, and it did not stop within ${Math.round(graceMs / 1000)}s. ` +
      `It may still be running in the background. Check what it did before running it again.`,
    isError: true,
  };
}
