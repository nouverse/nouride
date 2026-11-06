/**
 * Whether anyone could actually answer an approval right now.
 *
 * `canAsk` used to be "is any gateway connected", and the local gateway reports `connected`
 * unconditionally — it is an in-process object, so there is nothing for it to be disconnected from.
 * With the CLI or the dashboard enabled, which is every install, the answer was therefore always yes.
 *
 * What that cost: the refusal for want of anyone to ask never fired. On an unattended daemon at three in the
 * morning, a tool call needing approval did not get refused — it **parked for the full five-minute
 * timeout** and then expired as a denial anyway. Same verdict, five minutes later, with the turn dead
 * in between. On the always-on server this daemon is built for, that is the normal case rather than
 * the edge one.
 *
 * The fix is to measure the thing instead of inferring it. A person is reachable when either:
 *
 * - a real chat gateway is connected, so a prompt would land in front of somebody; or
 * - something has polled `/approvals` recently, which is exactly what a CLI or an open dashboard does
 *   while a turn is in flight.
 *
 * The second is the honest signal: it is not "a client exists", it is "a client asked, just now".
 */

import { createLogger } from "@nouride/shared";

const log = createLogger("approvals.reach");

/**
 * How stale a poll may be and still count.
 *
 * Both clients poll every second while a turn runs, so anything above a few seconds is generous.
 * Thirty covers a slow network and a browser that throttled a background tab, and is still far short
 * of the five-minute timeout it exists to avoid burning.
 */
const WATCHER_WINDOW_MS = 30_000;

export class ApprovalReach {
  /**
   * Negative infinity, not zero.
   *
   * Zero is a real timestamp, and "never polled" must not read as "polled at the epoch" — under a
   * clock that also starts near zero, that difference is inside the window and a fresh instance would
   * claim somebody is watching. Caught by the test that asserts it.
   */
  private lastPollAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** Called whenever a client asks for pending approvals. */
  notePoll(): void {
    this.lastPollAt = this.now();
  }

  /** True when a client asked recently enough that it would see a new prompt. */
  hasWatcher(): boolean {
    return this.now() - this.lastPollAt <= WATCHER_WINDOW_MS;
  }

  /**
   * Whether a human could answer.
   *
   * `chatConnected` is the caller's answer about *real* gateways — a Telegram or Discord connection
   * that would deliver a prompt to a person. The local gateway is deliberately not one of those: it is
   * a loopback for the CLI, and whether anyone is watching it is what `hasWatcher` measures.
   */
  canAsk(chatConnected: boolean): boolean {
    if (chatConnected) return true;
    const watching = this.hasWatcher();
    if (!watching) {
      log.debug("nobody is watching for approvals, so what would ask is refused");
    }
    return watching;
  }
}
