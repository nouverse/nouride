/**
 * The ways one bridge speaks: an event up its protocol (`emit`), a note on stderr (`note`), and its own end (`exit`).
 *
 * Kept apart on purpose. The protocol's channel carries events and nothing else — one stray line there corrupts it —
 * so everything that is not an event goes to stderr, which is the daemon's own. Each bridge has a `Speaker` of its
 * own over the channel its host gave it (`io.ts`), and a note says which connection it is from: with two numbers in
 * one daemon, "reconnecting" alone names neither.
 */

import { BridgeExit, type BridgeIo } from "./io.ts";
import type { BridgeEvent } from "./protocol.ts";

export interface Speaker {
  emit(event: BridgeEvent): void;
  /** Logs go to stderr. The channel is the protocol, and one stray line there corrupts it. */
  note(message: string, detail?: unknown): void;
  /**
   * End this bridge, through its host. The host's `exit` returns, and every caller was written expecting
   * `process.exit` never to — so the throw keeps that shape rather than letting execution fall into code that
   * assumes it is still connected.
   */
  exit(code: number): never;
}

/** A bridge's own voice: its events to `io`, its notes marked with `name` where it has one. */
export function speaker(io: BridgeIo, name: string): Speaker {
  const from = name ? `[${name}] ` : "";
  return {
    emit: (event) => io.write(JSON.stringify(event)),
    note: (message, detail) => {
      process.stderr.write(`${from}${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`);
    },
    exit: (code) => {
      io.exit(code);
      throw new BridgeExit(code);
    },
  };
}
