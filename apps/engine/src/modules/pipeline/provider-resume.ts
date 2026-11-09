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
 * The timer is in memory, and the promise is not: the person was told "I'll try again in a few minutes", and that is
 * the turn's stored reply. A restart inside those minutes used to drop it, with the turn closed `failed` where the
 * boot's own resume looks only at `interrupted` ones. So at boot the turns that failed within the timer's window and
 * promised it are set again, from when they failed (`providerResumesOwed`) — once each, by the same mark.
 */

import { createLogger } from "@nouride/shared";
import { promisedRetry } from "@/modules/turns/close.ts";
import type { TurnRecord, TurnsPort } from "@/modules/turns/turns.store.ts";
import { isResumption, resumptionId } from "./restart-resume.ts";

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

/**
 * Schedule it, or say why not — false when it is not a turn this takes up. `failedAt` is when the turn failed: now, or
 * for a turn a restart found, before the restart, and the wait is what is left of it.
 */
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
  failedAt: number = Date.now(),
): boolean {
  if (turn.chatId.startsWith("cron:") || isResumption(turn.messageId)) return false;
  const wait = deps.delayMs ?? PROVIDER_RESUME_MS + Math.floor(Math.random() * SPREAD_MS);
  const delay = Math.max(0, failedAt + wait - Date.now());
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

/**
 * The turns a restart left with a promise to try again: failed within the timer's window — the most it waits — with
 * the promise as their reply, and not taken up already, by the last process's timer or a boot before this one.
 */
export function providerResumesOwed(turns: Pick<TurnsPort, "failedSince" | "startedFor">, now: number): TurnRecord[] {
  const since = now - PROVIDER_RESUME_MS - SPREAD_MS;
  return turns.failedSince(since).filter((turn) => promisedRetry(turn.reply) && !turns.startedFor(resumptionId(turn.id), since));
}
