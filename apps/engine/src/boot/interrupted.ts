/**
 * Telling somebody what happened to their turn when the daemon stopped under it.
 *
 * The gap this first closed, reported as "progress agent jadi nyangkut selamanya": stop the daemon
 * while an agent is mid-`web_search` and the person waiting is told **nothing, ever**. Two mechanisms
 * produce that one symptom, and they are worse than they look.
 *
 * `drain()` stops the gateways *before* it waits for in-flight turns. After a gateway's `stop()` its
 * status is `disconnected`, and `send()` in `packages/gateways/src/commons/resilience.ts` answers a disconnected
 * gateway by putting the message in a 100-entry in-memory ring and returning `[]`. That ring has no
 * table. So a turn that *finishes* inside the shutdown window has its reply buffered and then lost
 * with the process — and a turn that does not finish leaves a `running` row that only the next boot
 * turns into `interrupted`. Either way: silence.
 *
 * ## Two paths, because there are two ways a daemon stops
 *
 * **On a signal** — `systemctl stop`, `systemctl restart`, `nouride stop`, and every upgrade, since
 * the installer stops the daemon. A handler runs, the gateways are still connected, and there is
 * time: the unit allows `TimeoutStopSec=45` against the daemon's own 30s deadline. So every turn is
 * asked to stop at its next step (`stopTurns`), the ones that do not are aborted, and each closes with
 * what it did and says so in its own chat — before anything is torn down.
 *
 * **Without one** — `kill -9`, the OOM killer, a lost power supply. No handler runs and nothing can
 * be sent, so the only honest moment is the *next boot*: a turn with a journal is closed with
 * everything it did and its person told exactly what happened (`boot/durable.ts`); a row left
 * `running` without one — a build from before the journal — gets the notice below. If the daemon
 * never comes back, nobody can be told anything, and no amount of code changes that.
 *
 * ## Why the wording is careful
 *
 * The daemon cannot tell a stop from a restart — it receives the same signal for both. So what it
 * says is what is true (this turn was cut off, its work is kept) and not what it cannot know.
 */

import { createLogger } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import { RESTARTING, type ActiveTurn } from "@/modules/pipeline/turn-context.ts";

const log = createLogger("daemon");

/** One conversation, which is all either notice needs to address. */
export interface Conversation {
  chatId: string;
  gatewayId: string;
}

/**
 * Sent at the next boot, for a turn that died without a signal.
 *
 * Past tense, and it says the daemon is back: by the time anybody reads this it is, so "send it
 * again" is advice they can act on immediately.
 */
const INTERRUPTED_NOTICE =
  "\u26a0\ufe0f I was in the middle of something when the daemon stopped unexpectedly. That turn is gone. I am back now, so send it again if you still need it.";

/**
 * A chat nothing can deliver to.
 *
 * A cron or webhook job with `session: "isolated"` runs against `cron:<jobId>`, which is not an
 * address on any platform — `job-turns.ts` says so where it explains why a hardline approval in
 * such a session fails closed. Sending there is a guaranteed failure and a log line for every
 * scheduled job that happened to be running, so it is skipped rather than attempted.
 */
function undeliverable(chatId: string): boolean {
  return chatId.startsWith("cron:");
}

/** Distinct conversations, so two agents busy in one room produce one message rather than two. */
function conversations(turns: Conversation[]): Conversation[] {
  const seen = new Map<string, Conversation>();
  for (const turn of turns) {
    if (undeliverable(turn.chatId)) continue;
    seen.set(`${turn.gatewayId} ${turn.chatId}`, { chatId: turn.chatId, gatewayId: turn.gatewayId });
  }
  return [...seen.values()];
}

/**
 * Stop the turns in flight, while the gateways still work.
 *
 * Asked first, not aborted: every turn stops at its next step boundary, so a turn a few seconds from done
 * finishes the step it is on and closes with all of it. What is still running after `pauseMs` is aborted
 * as a restart, and closes the same way with the call in flight marked cut off. Either way the turn tells
 * its own chat what it had done — that is why this runs before the gateways stop, and why it waits for
 * the closing to finish rather than racing it.
 *
 * Both waits are bounded: the daemon has 30 seconds to drain and systemd allows 45.
 */
export async function stopTurns(input: {
  pipeline: { pause(): void; runningTurns(): ActiveTurn[] };
  pauseMs?: number;
  abortMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ paused: number; aborted: number }> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = async (done: () => boolean, ms: number) => {
    for (let waited = 0; !done() && waited < ms; waited += 50) await sleep(50);
  };
  const running = input.pipeline.runningTurns().length;
  input.pipeline.pause();
  await until(() => input.pipeline.runningTurns().length === 0, input.pauseMs ?? 15_000);
  const left = input.pipeline.runningTurns();
  for (const turn of left) turn.controller.abort(RESTARTING);
  await until(() => input.pipeline.runningTurns().length === 0, input.abortMs ?? 5_000);
  if (running > 0) log.info("stopped turns that were in flight", { at_a_boundary: running - left.length, aborted: left.length });
  return { paused: running - left.length, aborted: left.length };
}

/**
 * Tell the conversations whose turns died with the last process.
 *
 * Split from the sweep that finds them because the two happen at different moments: the rows are
 * marked `interrupted` before anything else boots — a dashboard polling one must not be told "still
 * working" for a second longer than necessary — and the gateways that can carry the message are not
 * connected until much later.
 */
export async function announceInterrupted(input: {
  conversations: Conversation[];
  notifier: Pick<Notifier, "toChat">;
}): Promise<number> {
  const targets = conversations(input.conversations);
  if (targets.length === 0) return 0;

  await Promise.all(targets.map((target) => input.notifier.toChat(target, INTERRUPTED_NOTICE))).catch(
    (err: unknown) => log.warn("could not report interrupted turns", { error: String(err) }),
  );
  log.info("reported turns interrupted by a restart", { conversations: targets.length });
  return targets.length;
}
