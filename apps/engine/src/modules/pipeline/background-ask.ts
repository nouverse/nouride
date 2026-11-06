/**
 * An ask that does not hold the asking turn hostage (0.7.19): `ask_agent` waits for the answer, then moves the other
 * agent's turn to the background.
 *
 * Its turn is the peer turn it always was (`peer-turn.ts`), started so it can leave the asking turn: until the tool's
 * wait runs out it is waited on, steps and all; then it becomes a job of the asking agent's — the same row, limit, log,
 * stop and wake-up a helper in the background has (0.7.15, `jobs/helper-jobs.ts`) — and the asking turn ends while it
 * carries on. Its answer wakes the asking agent in this chat, through the road every job's end takes (`job-wakes.ts`),
 * and says what it is the answer to (`jobs/ask-wake-text.ts`).
 *
 * The job is the asking agent's, never the asked one's: the asking agent's one limit, `[delegate] max_background`,
 * counts it with its helpers; its `/stop` in this chat stops it; its chat is where the answer goes, in its voice. The
 * work is the asked agent's — its persona, its tools, its permissions, its approvals asked here in its name, as an ask's
 * always were.
 */

import { resolveMaxBackground, type LoadedAgent } from "@nouride/shared";
import type { AskDetached, AskRefusal, AskStart, PeerTurnRequest } from "@/modules/tools/builtins/ask-agent.ts";
import type { HelperView } from "@/modules/tools/builtins/delegate.ts";
import { helperView } from "./background-helper.ts";
import { startPeerTurn, type PeerTurn } from "./peer-turn.ts";
import type { TurnContext } from "./turn-context.ts";

/**
 * Start an ask so it can move to the background — at once when `background` is asked for, and then only if there is
 * room for it (nothing runs otherwise); else waited on, until the tool's wait runs out and it calls `detach`.
 */
export function startAsk(ctx: TurnContext, request: PeerTurnRequest, background: boolean): AskStart {
  const asker = ctx.deps.registry.get(request.from);
  if (background) {
    const refused = room(ctx, request, asker);
    if (refused) return { refused };
  }
  const turn = startPeerTurn(ctx, request, { detachable: true });
  return { run: { answer: turn.ended.then((outcome) => outcome.report), detach: () => detach(ctx, request, asker, turn) } };
}

/**
 * Move it to the background, or say why it stays: answered already, or no room — the limit full, the day's spend
 * reached, or no jobs in this process. Read now, so a limit changed from the dashboard applies to this one.
 */
function detach(ctx: TurnContext, request: PeerTurnRequest, asker: LoadedAgent | undefined, turn: PeerTurn): AskDetached {
  if (turn.done()) return { answered: true };
  const refused = room(ctx, request, asker);
  const jobs = ctx.deps.jobs;
  if (refused || !jobs || !asker) {
    turn.stay();
    return { refused: refused ?? UNAVAILABLE };
  }
  const outcome = jobs.startAsk({
    agentId: asker.config.id,
    gatewayId: request.ctx.gatewayId,
    chatId: request.ctx.chatId,
    cwd: ctx.workspaceFor(request.to).shared,
    ask: { agent: request.to, task: request.task },
    ...(request.ctx.turnId ? { turnId: request.ctx.turnId } : {}),
    senderId: request.ctx.senderId,
    limit: limitOf(ctx, asker),
    startedAt: turn.startedAt,
    // Adopted: the turn is running already, and from here it is the job's.
    run: (job) => {
      turn.detach(job);
      return turn.ended;
    },
  });
  if ("started" in outcome) return { job: outcome.started.id };
  turn.stay();
  return { refused: { why: "limit", limit: "limit" in outcome ? outcome.limit : limitOf(ctx, asker), running: views(ctx, request, asker) } };
}

const UNAVAILABLE: AskRefusal = { why: "unavailable", reason: "This process cannot run work in the background." };

/** Room for one more of the asking agent's turns in the background — or why not. */
function room(ctx: TurnContext, request: PeerTurnRequest, asker: LoadedAgent | undefined): AskRefusal | null {
  const jobs = ctx.deps.jobs;
  if (!jobs || !asker) return UNAVAILABLE;
  // Counted against the day's caps like any turn: refused before it moves rather than discovered after it spent.
  const budget = ctx.checkSpend();
  if (budget.action === "refuse") return { why: "unavailable", reason: budget.message };
  const limit = limitOf(ctx, asker);
  return jobs.backgroundTurns(asker.config.id).length >= limit ? { why: "limit", limit, running: views(ctx, request, asker) } : null;
}

/** The asking agent's limit — helpers and asks together — read as it is needed. */
function limitOf(ctx: TurnContext, asker: LoadedAgent): number {
  return resolveMaxBackground(asker.config.maxBackgroundHelpers, ctx.deps.config.delegate.maxBackground);
}

/** What it has running in the background, as a refusal names it: here by id and goal, elsewhere counted. */
function views(ctx: TurnContext, request: PeerTurnRequest, asker: LoadedAgent | undefined): HelperView[] {
  return (asker ? (ctx.deps.jobs?.backgroundTurns(asker.config.id) ?? []) : []).map((job) => helperView(job, request.ctx));
}
