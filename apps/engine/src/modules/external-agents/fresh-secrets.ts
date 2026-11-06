/**
 * Which secrets a running CLI did not start with, and the wait for it to be free to start again with them (0.8.15).
 *
 * A CLI's shell has the environment its process started with, and the process cannot start again while a turn works
 * in it. A mission an agent started in the turn that kept its keys opened twelve seconds before that turn ended, on the
 * process without them, and asked the person for keys already kept (2026-11-02). `ExternalAgents.forTurn` waits for
 * the turn at work, up to `FRESH_WAIT_MS`, and past that tells the turn which variables its shell does not have yet.
 */

import { sha256Text } from "@nouride/runtime";
import { contained, createLogger } from "@nouride/shared";

const log = createLogger("external-agents");

/** How long a turn waits for its CLI to be free to start again with changed secrets — a starting value. */
export const FRESH_WAIT_MS = 120_000;
/** How often it looks. */
export const FRESH_POLL_MS = 500;

/** Each variable's value as a hash: what a CLI started with, kept to compare — never the value. */
export function hashedEach(secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, sha256Text(value)]));
}

/** The variables bound now that a CLI started with `started` does not have as they are: kept or changed since. */
export function notStartedWith(started: Record<string, string>, now: Record<string, string>): string[] {
  return Object.keys(now)
    .filter((name) => started[name] !== sha256Text(now[name]!))
    .sort();
}

/** A wait that ends early when `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // The timer and the abort listener are one contained function, so the listener taken off is the one put on.
    const finish = contained(log, "a wait for a CLI to be free could not end", done);
    const timer = setTimeout(finish, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
