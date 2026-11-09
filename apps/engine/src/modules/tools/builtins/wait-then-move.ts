/**
 * Waited on for a minute, then moved behind the turn: what `ask_agent` and `delegate` in the foreground do with work they
 * handed over that runs long.
 *
 * The call waits for the answer as it always did, up to `FOREGROUND_WAIT_MS`. Past that, the work carries on as a job of
 * the calling agent's (`pipeline/background-move.ts`): the call returns saying so, the turn ends so the person can talk
 * to the agent meanwhile, and the result wakes the agent in this chat when it comes. A deploy, an audit or a long check
 * used to hold the turn — its time budget, and the person with it — for as long as it took.
 *
 * Where there is no room for one more job — the limit full, the day's spend reached, no jobs in this process — the work
 * stays where it was and is waited on to the end, and the result says why it took so long.
 *
 * Only a turn that may hold work in the background moves any: its own chat turn, with `[delegate] max_background` above
 * 0. A helper's turn, a peer's, a scheduled one, and an agent whose limit is 0 are offered each tool's waiting form
 * (`waitingForm`), which never moves anything and offers no `background`.
 */

import { plural, type Tool } from "@nouride/shared";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { duration } from "@/modules/jobs/wake-text.ts";
import type { HelperView } from "./delegate.ts";

/**
 * How long a call waits for work it handed over before that work moves to the background.
 *
 * Long enough for an answer given from what the worker knows, or from a command or two, to come back inside the turn as
 * it always did. Short enough that long work does not hold the turn, its time budget and the person with it: past this,
 * the person hears that the work is under way, and can talk to the agent meanwhile.
 *
 * And well under a minute, because an external agent's CLI reaches these tools over MCP, whose clients give one call
 * 60 seconds by default: at exactly a minute the CLI gave up first, and the agent read "The operation timed out."
 * where the tool had just said its helper moved.
 */
export const FOREGROUND_WAIT_MS = 45_000;

/** Why work did not move to the background: no room under the calling agent's limit, or no way to run one here. */
export type MoveRefusal = { why: "limit"; limit: number; running: HelperView[] } | { why: "unavailable"; reason: string };

/** Moving one to the background: the job it now runs as — or it stays waited on, answered already or refused. */
export type Moved = { job: string } | { answered: true } | { refused: MoveRefusal };

/** Work under way that need not hold the turn: its answer, and its way out (`pipeline/background-move.ts`). */
export interface MovableRun {
  answer: Promise<SubAgentHandoff>;
  detach(): Moved;
}

/** The answer, or null once `ms` have passed without one — the wait a call gives before what it waits on moves. */
export async function within<T>(answer: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waited on past the wait because it could not move: said, so the time it took is not taken for a stuck worker. */
export function stayed(refused: MoveRefusal, waitMs: number): string {
  const why = refused.why === "limit" ? limitReached(refused) : refused.reason.replace(/\.$/, "");
  return `(This took longer than ${duration(waitMs)} and stayed in the foreground: ${why}.)`;
}

/** The limit, named — the one helpers and asks share. */
export function limitReached(refused: Extract<MoveRefusal, { why: "limit" }>): string {
  const n = refused.running.length;
  return (
    `you already have ${n} ${plural(n, "job")} working in the background (helpers and asks), the most this ` +
    `agent may have (\`[delegate] max_background = ${refused.limit}\`)`
  );
}

/** Each tool's waiting form, by the form every other turn is offered. */
const WAITING = new WeakMap<Tool, Tool>();

/** `tool`, with the form a turn that may hold no work in the background is offered in its place. */
export function withWaiting(tool: Tool, waiting: Tool): Tool {
  WAITING.set(tool, waiting);
  return tool;
}

/**
 * The form a turn that may hold no work in the background is offered: no `background`, and every answer waited for
 * however long it takes. `resolveToolset` gives it to a helper's turn, a peer's, a scheduled one and wherever
 * `[delegate] max_background` is 0. A tool with no such form is itself.
 *
 * Not ping-pong, said where it is decided: a helper working in the background that could move work behind itself would
 * leave a turn nobody watches waiting on nothing, with a second job's result bound for a conversation the helper is
 * not in.
 */
export function waitingForm(tool: Tool): Tool {
  return WAITING.get(tool) ?? tool;
}

/**
 * `wrap` applied to a tool and to its waiting form alike. A wrapper is a new tool, which the form is not kept by: the
 * registry's audit wrapped every built-in, and a helper's turn was offered the `ask_agent` that moves, `background` and
 * all, in place of the one that waits.
 */
export function wrapBoth(tool: Tool, wrap: (tool: Tool) => Tool): Tool {
  const waiting = WAITING.get(tool);
  const wrapped = wrap(tool);
  return waiting ? withWaiting(wrapped, wrap(waiting)) : wrapped;
}
