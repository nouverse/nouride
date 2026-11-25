#!/usr/bin/env bun
/**
 * WhatsApp bridge — the only code in this repo that talks to Baileys.
 *
 * It runs inside the daemon (`apps/engine/src/modules/gateways/bridge-inproc.ts`), and it is still
 * kept apart: the engine imports nothing of it but this module's entry points, and the whole interface
 * is newline-delimited JSON, carried by `io.ts` and declared twice by hand (`src/protocol.ts` here,
 * `packages/shared/src/types/bridge.ts` there) with a version field so a drift fails the handshake
 * instead of surfacing as a mystery three hours later. It was its own process until 2026-09-16;
 * `packages/wa-bridge/README.md` says why the GPL-3.0 `libsignal` Baileys depends on no longer
 * reaches it.
 *
 * This file makes a bridge and is what the engine imports: one bridge for each WhatsApp number a daemon holds
 * (`openBridge`), each with its own connection, its own channel and its own login. The rest is on its seams:
 *
 * - `handler.ts` carries out the engine's commands, one protocol line at a time, through a `Link` to the connection;
 * - `connection.ts` keeps one Baileys socket open, reconnects it, and forwards what arrives on it;
 * - `message.ts` reads a message — its text, quote, mentions and media — without a socket;
 * - `say.ts` is how a bridge speaks: protocol events up its own channel, notes to stderr.
 *
 * Two things it is careful about:
 *
 * **The QR is emitted, never printed.** WhatsApp has no bot token — pairing is a phone scanning a
 * code — and the person holding the phone is not the person reading the server's stdout. So the code
 * goes up the protocol and the engine serves it to whoever is looking at the dashboard.
 *
 * **Credentials survive a restart, encrypted.** That is the whole point of the session directory: a
 * bridge that asks for a new scan on every boot is a bridge nobody will keep running. `auth.ts` holds
 * the reason it is encrypted rather than plain.
 */

import { Connection } from "./connection.ts";
import { Handler } from "./handler.ts";
import type { BridgeIo } from "./io.ts";
import { speaker } from "./say.ts";

/**
 * `console` is the whole process's, and so is this redirect: the one thing here that is not a bridge's own.
 *
 * `libsignal-node`, deep inside Baileys, calls `console.log('Closing session:', …)` and dumps a whole
 * session record. When the bridge was its own process that went straight into the middle of its JSON
 * stream: the engine logged sixteen "unparseable line from the bridge" warnings per occurrence, and a
 * frame split by one of those writes would have been corrupted rather than merely noisy. Inside the
 * daemon it would land in the daemon's own output as it is.
 *
 * Redirected rather than tolerated. A dependency cannot be asked not to print, and a library that
 * prints cannot say which number it printed for: every bridge's dependency writes through here.
 */
for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
  console[level] = (...args: unknown[]) => {
    try {
      process.stderr.write(
        `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
      );
    } catch {
      // A value that will not stringify is not worth crashing the bridge over.
    }
  };
}

/** One WhatsApp number's bridge, as its host holds it. */
export interface Bridge {
  /**
   * Feed one protocol line in, one at a time.
   *
   * Commands are handled one at a time by the caller, and that is load-bearing: `send` awaits the
   * network, and processing the next line concurrently would let two replies to the same chat race
   * into the wrong order.
   */
  handleLine(line: string): Promise<void>;
  /**
   * Tear the connection down without ending the host.
   *
   * The daemon may drop a WhatsApp gateway and keep running, so ending a bridge cannot mean ending the
   * process — and a socket left open would fight the next bridge of the same number for its credentials.
   */
  stop(): void;
}

/**
 * A bridge for one number: its own connection, its own handler, speaking on the channel given here.
 *
 * `name` is the connection's, for the notes it writes. The key is handed over directly, never through the
 * environment (`handler.ts` says why); the session's folder still arrives over the protocol in `hello` and wins over
 * the one given here, since the engine holds the config.
 */
export function openBridge(input: { name: string; sessionDir?: string; encryptionKey: string; io: BridgeIo }): Bridge {
  const say = speaker(input.io, input.name);
  const connection = new Connection(say);
  const handler = new Handler(connection, { sessionDir: input.sessionDir ?? "", sessionKey: input.encryptionKey }, say);
  return { handleLine: (line) => handler.handleLine(line), stop: () => connection.stop() };
}
