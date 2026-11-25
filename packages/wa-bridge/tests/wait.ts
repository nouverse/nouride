/**
 * Waiting in a test: for a condition with `eventually`, and with `sleep` only where there is no condition to wait for.
 *
 * A fixed sleep followed by an `expect` is a bet on how late a timer fires, and on a machine shared with other work it
 * loses. `eventually` returns as soon as the thing is true, so its deadline can be generous without making a fast
 * machine wait; the default sits inside bun:test's five seconds, so a miss fails with what was waited for rather than a
 * bare timeout. What did *not* happen is not asserted this way: say it from state the code keeps.
 *
 * Every workspace member with tests has this file, and every copy is identical: a member's tests import only what its
 * own manifest declares, so they cannot share the engine's. `tests/contracts/test-waits.test.ts` holds the copies equal
 * and refuses a wait helper declared anywhere else.
 */

/** A plain timer, not `Bun.sleep`: `lint:arch` keeps `Bun.*` in `packages/runtime`. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check` holds, polling; throw if it has not within `timeoutMs`. */
export async function eventually(check: () => boolean, timeoutMs = 4_000, what = "the condition"): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !check(); ) {
    if (Date.now() > deadline) throw new Error(`${what} did not hold within ${timeoutMs}ms`);
    await sleep(10);
  }
}
