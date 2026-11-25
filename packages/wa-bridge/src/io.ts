/**
 * Where one bridge's protocol goes, and how that bridge ends.
 *
 * ## Why this file exists
 *
 * The bridge was only ever a process: it wrote newline JSON to `stdout`, read commands from `stdin`,
 * and called `process.exit` when it was done. All three are wrong inside the daemon — stdout belongs to
 * its logs, stdin to whatever started it, and exiting would take the whole daemon with it. So the two
 * things the rest of the bridge does to the outside, a line up and an end, go through a `BridgeIo` its
 * host hands it (`apps/engine/src/modules/gateways/bridge-inproc.ts`).
 *
 * ## One for each bridge
 *
 * It was one for the module, attached and restored, while a daemon held one WhatsApp number. A daemon
 * holds a bridge for each number now, so each is given its own when it is opened (`openBridge`) and
 * keeps it: one number's events cannot go up another's channel, and one number ending ends itself.
 *
 * ## This is the seam
 *
 * Nothing else in the bridge knows where it is running, and the wire protocol is the same newline
 * JSON either way — which is the point: the whole coupling to the engine is that protocol, described
 * in `packages/wa-bridge/README.md`.
 */

export interface BridgeIo {
  /** One protocol line, without the trailing newline. */
  write(line: string): void;
  /**
   * End this bridge.
   *
   * It closes the channel and unwinds, because a daemon hosting the bridge must outlive it — a
   * protocol mismatch or a missing session key is that bridge's problem, not a reason to drop every
   * other gateway, another WhatsApp number among them.
   */
  exit(code: number): void;
}

/** Thrown after a bridge's `exit`, so the host can tell a deliberate stop from a crash. */
export class BridgeExit extends Error {
  constructor(readonly code: number) {
    super(`bridge exited with code ${code}`);
    this.name = "BridgeExit";
  }
}
