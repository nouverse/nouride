/**
 * An ask that does not hold the asking turn hostage (0.7.19): `ask_agent` waits for the answer, then moves the other
 * agent's turn to the background.
 *
 * Its turn is the peer turn it always was (`peer-turn.ts`), started so it can leave the asking turn: until the tool's
 * wait runs out it is waited on, steps and all; then it becomes a job of the asking agent's — the same row, limit, log,
 * stop and wake-up a helper in the background has (0.7.15, `jobs/helper-jobs.ts`) — and the asking turn ends while it
 * carries on (`background-move.ts`, the road a helper waited on takes too). Its answer wakes the asking agent in this
 * chat, through the road every job's end takes (`job-wakes.ts`), and says what it is the answer to
 * (`jobs/ask-wake-text.ts`).
 *
 * The job is the asking agent's, never the asked one's: the asking agent's one limit, `[delegate] max_background`,
 * counts it with its helpers; its `/stop` in this chat stops it; its chat is where the answer goes, in its voice. The
 * work is the asked agent's — its persona, its tools, its permissions, its approvals asked here in its name, as an ask's
 * always were.
 */

import type { AskStart, PeerTurnRequest } from "@/modules/tools/builtins/ask-agent.ts";
import { moveToBackground, roomFor } from "./background-move.ts";
import { startPeerTurn } from "./peer-turn.ts";
import type { TurnContext } from "./turn-context.ts";

/**
 * Start an ask so it can move to the background — at once when `background` is asked for, and then only if there is
 * room for it (nothing runs otherwise); else waited on, until the tool's wait runs out and it calls `detach`.
 */
export function startAsk(ctx: TurnContext, request: PeerTurnRequest, background: boolean): AskStart {
  const asker = ctx.deps.registry.get(request.from);
  if (background) {
    const refused = roomFor(ctx, request.ctx, asker);
    if (refused) return { refused };
  }
  const turn = startPeerTurn(ctx, request, { detachable: true });
  return {
    run: {
      answer: turn.ended.then((outcome) => outcome.report),
      // The asking agent's row, with the asked agent's turn in it, working in the asked agent's own workspace.
      detach: () =>
        moveToBackground(ctx, request.ctx, asker, turn, (jobs, adopted) =>
          jobs.startAsk({ ...adopted, cwd: ctx.workspaceFor(request.to).shared, ask: { agent: request.to, task: request.task } }),
        ),
    },
  };
}
