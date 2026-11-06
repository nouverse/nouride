/**
 * A turn its model provider ended is tried again once, a few minutes on.
 *
 * The request itself is retried for half a minute (`packages/llm/src/http.ts`), which rides out a rate limit
 * or a gateway restarting. A provider down for longer ended the turn, kept its work, and waited for somebody
 * to say "continue" — for a turn left working overnight, the morning. Now the daemon says it for them, once,
 * like a turn a restart cut off (`restart-resume.ts`), and on the same terms:
 *
 * - **Only for a provider that failed for a while**: a rate limit, an overload, a timeout, a 5xx. Not an
 *   expired key, an empty balance or a bad request, which no amount of waiting fixes.
 * - **Once**: the turn that takes it up is `resume:<turn>`, and that is never taken up again, whatever
 *   ends it.
 * - **Not if somebody moved on**: a turn started in the chat since the failure — the person said something —
 *   and it is theirs again.
 *
 * In memory, on purpose. A restart inside the few minutes drops it: the person was told the turn failed and
 * can say "continue", which is where every turn stood before this.
 */

import { createLogger } from "@nouride/shared";
import { isResumption } from "./restart-resume.ts";

const log = createLogger("pipeline");

/** How long a provider is given before the turn is tried again, plus up to a minute so a burst spreads out. */
const PROVIDER_RESUME_MS = 3 * 60_000;
const SPREAD_MS = 60_000;

export interface ResumableTurn {
  id: string;
  agentId: string;
  gatewayId: string;
  chatId: string;
  prompt: string;
  messageId?: string;
}

/** Schedule it, or say why not — false when it is not a turn this takes up. */
export function scheduleProviderResume(
  turn: ResumableTurn,
  deps: {
    resume: (turn: ResumableTurn) => boolean;
    /** Whether a turn has started in this chat since `since`. */
    movedOn: (turn: ResumableTurn, since: number) => boolean;
    /** Whether the daemon is going down — a turn taken up now would only be cut off again. */
    stopping: () => boolean;
    delayMs?: number;
  },
): boolean {
  if (turn.chatId.startsWith("cron:") || isResumption(turn.messageId)) return false;
  const failedAt = Date.now();
  const delay = deps.delayMs ?? PROVIDER_RESUME_MS + Math.floor(Math.random() * SPREAD_MS);
  const timer = setTimeout(() => {
    // A throw out of a timer is an uncaught exception, and the daemon shuts down on one (`boot/shutdown.ts`): a
    // database busy at the wrong moment would have taken every conversation down to retry one.
    try {
      if (deps.stopping() || deps.movedOn(turn, failedAt)) return;
      if (deps.resume(turn)) log.info("taking up a turn its provider ended", { turn_id: turn.id, agent_id: turn.agentId });
    } catch (err) {
      log.warn("could not take up a turn its provider ended", { turn_id: turn.id, agent_id: turn.agentId, error: String(err) });
    }
  }, delay);
  timer.unref?.();
  return true;
}
