/**
 * Room made when a turn's own steps fill the window: its oldest are summed up in one model call, and the turn goes on
 * from the notes and its newest steps (`llm/summarize-steps.ts`).
 *
 * Asked before every request, after old tool output was cleared, and it is the summing up that decides there is
 * nothing to do: under the line that starts it, a turn that never fills the window makes no such call. What the model
 * holds afterwards is what the journal holds too, so a turn cut off by a restart is closed into one a request can
 * carry again.
 */

import { createLogger, type ChatMessage } from "@nouride/shared";
import { formatTokens } from "@/modules/hooks/format.ts";
import { sumUpOldSteps } from "@/modules/llm/summarize-steps.ts";
import type { TurnCeilings, TurnPlan } from "./prepare.ts";
import type { ExecutorDeps, TurnRequest } from "./types.ts";

const log = createLogger("llm.executor");

/** How it went: `failed` is not asked for again in the same turn. */
export type RoomInTurn = "done" | "failed" | "none";

export async function roomInTurn(o: {
  deps: Pick<ExecutorDeps, "onActivity">;
  req: TurnRequest;
  plan: Pick<TurnPlan, "summarizer">;
  /** What is sent, changed in place: the same list the loop appends to. */
  working: ChatMessage[];
  /** How many of its messages came before the turn's own. */
  turnStart: number;
  ceilings: TurnCeilings;
}): Promise<RoomInTurn> {
  const { req, plan, working, ceilings } = o;
  const say = (text: string, detail: Record<string, unknown>) => void o.deps.onActivity?.("compact", text, detail);
  try {
    const room = await sumUpOldSteps(working, o.turnStart, {
      provider: plan.summarizer.provider,
      model: plan.summarizer.model,
      summarizerWindow: ceilings.compaction.summarizerWindow,
      startTokens: ceilings.compactAt,
      fitTokens: ceilings.trimTo,
      ...(req.signal ? { signal: req.signal } : {}),
      onStart: ({ steps, tokens }) => say(`context full: summing up ${steps} earlier step(s) of this turn, ~${formatTokens(tokens)} tokens`, { phase: "start", tokens }),
    });
    if (!room) return "none";
    working.splice(0, working.length, ...room.messages);
    // The journal holds what the model now holds: closed for a restart, the turn is one a request can carry again.
    req.journal?.rewritten(working.slice(o.turnStart));
    say(`summed up ${room.steps} earlier step(s) of this turn, now ~${formatTokens(room.tokens)} tokens`, { phase: "done", tokens: room.tokens });
    return "done";
  } catch (err) {
    // A stop or a deadline cut the summary short: the loop's own check ends the turn. Anything else is said, and the
    // turn goes on as it is: it may still fit, and failing it here would be failing it for tidying up.
    if (!req.signal?.aborted) {
      log.warn("summing up a running turn's steps failed", { agent_id: req.agent.config.id, turn_id: req.turnId, error: String(err), model: plan.summarizer.model });
      say("could not sum up this turn's earlier steps: carrying on as it is", { phase: "failed" });
    }
    return "failed";
  }
}
