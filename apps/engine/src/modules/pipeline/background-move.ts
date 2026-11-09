/**
 * Work that outlasted the wait a tool gave it, moved behind the turn that waited (`tools/builtins/wait-then-move.ts`):
 * the one road into the background for another agent's turn an `ask_agent` started (`background-ask.ts`) and for a
 * helper `delegate` started in the foreground (`background-helper.ts`).
 *
 * The turn keeps running and becomes a job of the agent whose turn started it — the same row, limit, log, stop and
 * wake-up as one started in the background from the first (`jobs/helper-jobs.ts`): that agent's one limit,
 * `[delegate] max_background`, counts it; its `/stop` in this chat stops it; its chat is woken with the result. With no
 * room for it — the limit full, the day's spend reached, no jobs in this process — it stays where it was, waited on to
 * the end.
 */

import { resolveMaxBackground, type LoadedAgent, type ToolContext } from "@nouride/shared";
import type { MoveRefusal, Moved } from "@/modules/tools/builtins/wait-then-move.ts";
import type { HelperView } from "@/modules/tools/builtins/delegate.ts";
import { goalLine } from "@/modules/tools/builtins/delegate-brief.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import type { HelperOutcome, HelperStart, RunningHelper, StartAsk } from "@/modules/jobs/helper-jobs.ts";
import type { JobRecord, JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { TurnContext } from "./turn-context.ts";

/** A turn under way that may leave the turn waiting on it: how it ends, and how it goes. */
export interface MovableTurn {
  /** When it began — what its job, once it has one, says it started at. */
  startedAt: number;
  /** How it ended: its handoff, and whether a shutdown stopped it at a step — then the next boot reports it. */
  ended: Promise<HelperOutcome>;
  /** Over already: its answer is in hand, or it was refused before it began. */
  done(): boolean;
  /**
   * Behind the waiting turn from now on: stopped by its job — not by that turn, which ends without it — its steps the
   * job's log, a question it puts to a person saying whose work it is. False when it has already ended.
   */
  detach(job: RunningHelper): boolean;
  /** Waited on to the end after all — it could not move: what it does stays the waiting turn's, and no log is gathered for it. */
  stay(): void;
}

/** A turn that is over before it began. */
export function endedAlready(startedAt: number, report: SubAgentHandoff): MovableTurn {
  return { startedAt, ended: Promise.resolve({ report }), done: () => true, detach: () => false, stay: () => {} };
}

/** What every job a turn moves to is given; what kind of work it is — a brief, an ask — and where it works are the caller's. */
type Adopted = Omit<StartAsk, "ask" | "cwd">;

/**
 * Move it to the background as a job of `owner`'s, or say why it stays: answered already, or no room. Read now, so a
 * limit changed from the dashboard applies to this one. `start` writes the job of its kind (`JobStore.startHelper`,
 * `JobStore.startAsk`), adopting the running turn.
 */
export function moveToBackground(
  ctx: TurnContext,
  at: ToolContext,
  owner: LoadedAgent | undefined,
  turn: MovableTurn,
  start: (jobs: JobsPort, adopted: Adopted) => HelperStart,
): Moved {
  if (turn.done()) return { answered: true };
  const refused = roomFor(ctx, at, owner);
  const jobs = ctx.deps.jobs;
  if (refused || !jobs || !owner) {
    turn.stay();
    return { refused: refused ?? UNAVAILABLE };
  }
  const outcome = start(jobs, {
    agentId: owner.config.id,
    gatewayId: at.gatewayId,
    chatId: at.chatId,
    ...(at.turnId ? { turnId: at.turnId } : {}),
    senderId: at.senderId,
    limit: limitOf(ctx, owner),
    startedAt: turn.startedAt,
    // Adopted: the turn is running already, and from here it is the job's.
    run: (job) => {
      turn.detach(job);
      return turn.ended;
    },
  });
  if ("started" in outcome) return { job: outcome.started.id };
  turn.stay();
  return { refused: { why: "limit", limit: "limit" in outcome ? outcome.limit : limitOf(ctx, owner), running: views(ctx, at, owner) } };
}

const UNAVAILABLE: MoveRefusal = { why: "unavailable", reason: "This process cannot run work in the background." };

/** Room for one more of `owner`'s turns in the background — or why not. */
export function roomFor(ctx: TurnContext, at: ToolContext, owner: LoadedAgent | undefined): MoveRefusal | null {
  const jobs = ctx.deps.jobs;
  if (!jobs || !owner) return UNAVAILABLE;
  // Counted against the day's caps like any turn: refused before it moves rather than discovered after it spent.
  const budget = ctx.checkSpend();
  if (budget.action === "refuse") return { why: "unavailable", reason: budget.message };
  const limit = limitOf(ctx, owner);
  return jobs.backgroundTurns(owner.config.id).length >= limit ? { why: "limit", limit, running: views(ctx, at, owner) } : null;
}

/** The agent's limit — helpers and asks together — read as it is needed. */
function limitOf(ctx: TurnContext, owner: LoadedAgent): number {
  return resolveMaxBackground(owner.config.maxBackgroundHelpers, ctx.deps.config.delegate.maxBackground);
}

/** What it has running in the background, as a refusal names it: here by id and goal, elsewhere counted. */
function views(ctx: TurnContext, at: ToolContext, owner: LoadedAgent | undefined): HelperView[] {
  return (owner ? (ctx.deps.jobs?.backgroundTurns(owner.config.id) ?? []) : []).map((job) => helperView(job, at));
}

/**
 * A running helper — or an ask in the background, by its job line — as a tool says it, and whether it was started from
 * the conversation asking: `delegate`'s list and refusals, and `ask_agent`'s.
 */
export function helperView(job: JobRecord, at: Pick<ToolContext, "gatewayId" | "chatId">): HelperView {
  return { id: job.id, goal: job.brief ? goalLine(job.brief) : job.command, startedAt: job.startedAt, here: job.gatewayId === at.gatewayId && job.chatId === at.chatId };
}
