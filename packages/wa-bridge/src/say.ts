/**
 * The two ways the bridge speaks: an event up the protocol (`emit`), and a note on stderr (`note`).
 *
 * Kept apart on purpose. stdout is the protocol — one stray line there corrupts it — so everything that is not an
 * event goes to stderr, where the engine forwards it into the daemon's log. Where an event goes is `io.ts`'s business:
 * stdout for a bridge run as its own process, a queue for the in-process host.
 */

import * as io from "./io.ts";
import type { BridgeEvent } from "./protocol.ts";

export function emit(event: BridgeEvent): void {
  io.write(JSON.stringify(event));
}

/** Logs go to stderr. stdout is the protocol, and one stray line there corrupts it. */
export function note(message: string, detail?: unknown): void {
  process.stderr.write(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`);
}
