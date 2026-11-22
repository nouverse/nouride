/**
 * What makes a Telegram connect wait, in words for a person.
 *
 * grammY's start asks who the bot is and retries by itself, behind its own debug logger: a 429 is waited out for as
 * long as Telegram names, a 5xx and a network failure are tried again with a growing pause, up to twenty minutes
 * between two tries (`withRetries`). On a live box a connection stayed "connecting" for thirty minutes to the second,
 * after five installs in a row, while fourteen others connected in two seconds; a restart of it changed nothing, and
 * nothing was logged. The time fits a wait Telegram named, which nobody was shown.
 *
 * And its pause is not the one it means (grammY 1.45.1, read and then timed against a stand-in for Telegram): it
 * counts the pause in milliseconds, 50 doubling, and sleeps that many seconds. The second failure in a row waits a
 * hundred seconds, the third two hundred, the fourth four hundred: three tries in two minutes where it meant three in
 * a fifth of a second, after one bad minute of a network.
 *
 * So a start's wait is taken from the library. What Telegram answered is read where every call of the bot being
 * started passes (`gateway.ts`, a transformer): it is said, and thrown past the library as a `StartWait`, which the
 * library does not retry. The adapter waits what Telegram named, or its own backoff, and asks again
 * (`untilStarted`).
 */

import type { Transformer } from "grammy";
import { waitWords } from "../../commons/waits.ts";

/** Telegram's answer to a call, as far as this reads it: grammY's `ApiResponse`. */
export interface TelegramAnswer {
  ok: boolean;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * Why a connect waits on this answer, and until when where Telegram named it; null for an answer the start does not
 * wait on: a success, or a refusal it gives up at (a wrong token).
 */
export function telegramWait(answer: TelegramAnswer, now: number): { reason: string; until?: number } | null {
  if (answer.ok) return null;
  if (answer.error_code === 429) {
    const seconds = answer.parameters?.retry_after;
    if (typeof seconds !== "number") return { reason: "Telegram asked this bot to wait before it connects: too many requests in a short time. It is being tried again." };
    return {
      reason: `Telegram asked this bot to wait ${waitWords(seconds)} before it connects: too many requests in a short time, as after several restarts close together. It connects by itself once the wait is over.`,
      until: now + seconds * 1_000,
    };
  }
  if (answer.error_code !== undefined && answer.error_code >= 500) return { reason: `Telegram answered with an error of its own (${answer.error_code}). It is being tried again.` };
  return null;
}

/** A call that got no answer at all: the network, a proxy, a name that does not resolve. */
export const TELEGRAM_UNREACHABLE = "Telegram could not be reached from this machine. It is being tried again.";

/**
 * A start's call the adapter waits out and makes again itself: `waitMs` where Telegram named how long. Not an error of
 * the library's own kinds, so its retry lets it through.
 */
export class StartWait extends Error {
  override name = "StartWait";
  constructor(
    readonly reason: string,
    readonly waitMs?: number,
  ) {
    super(reason);
  }
}

/**
 * The transformer that says it and takes it: every call of a bot that is still starting passes here, and an answer
 * its start waits on, or no answer at all, is said through `say` and thrown as a `StartWait`. Any other answer, and
 * every call of a bot that has started, goes on to the library unchanged.
 */
export function sayingWhyItWaits(starting: () => boolean, say: (reason: string, until?: number) => void, now: () => number = Date.now): Transformer {
  return async (prev, method, payload, signal) => {
    let result: Awaited<ReturnType<typeof prev>>;
    try {
      result = await prev(method, payload, signal);
    } catch (err) {
      if (!starting()) throw err;
      say(TELEGRAM_UNREACHABLE);
      throw new StartWait(TELEGRAM_UNREACHABLE);
    }
    const at = now();
    const wait = starting() ? telegramWait(result, at) : null;
    if (!wait) return result;
    say(wait.reason, wait.until);
    throw new StartWait(wait.reason, wait.until === undefined ? undefined : wait.until - at);
  };
}

/** A wait that can be cut short: a start's, ended at once when its connect is given up. */
export class CutPause {
  private cut?: () => void;

  wait(ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(done, ms);
      this.cut = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  end(): void {
    this.cut?.();
  }
}

/**
 * A bot's start (`init`), asked again where it has to wait: for as long as Telegram named, or `backoff` for the try
 * it is, a reconnect's own from a second to a minute. It goes on until Telegram answers, as the library's retry did:
 * a machine whose network comes back connects by itself. Over at once, with a failure, when the connect is given up
 * (`still` says no): while it waited, or by the time an answer came.
 */
export async function untilStarted(init: () => Promise<void>, still: () => boolean, pause: Pick<CutPause, "wait">, backoff: (attempt: number) => number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await init();
    } catch (err) {
      if (!(err instanceof StartWait) || !still()) throw err;
      await pause.wait(err.waitMs ?? backoff(attempt));
      if (!still()) throw new Error("the connect was given up while it waited");
    }
  }
}

