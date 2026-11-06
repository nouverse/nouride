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
 * This file wires the bridge and is what the engine imports. The rest is on its seams:
 *
 * - `handler.ts` carries out the engine's commands, one protocol line at a time, through a `Link` to the connection;
 * - `connection.ts` keeps one Baileys socket open, reconnects it, and forwards what arrives on it;
 * - `message.ts` reads a message — its text, quote, mentions and media — without a socket;
 * - `say.ts` is how the bridge speaks: protocol events up, notes to stderr.
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

import { currentSocket, isLinked, logout, phoneForLid, start, stop } from "./connection.ts";
import { Handler } from "./handler.ts";

/**
 * stdout belongs to the protocol, so nothing else may write to it.
 *
 * `libsignal-node`, deep inside Baileys, calls `console.log('Closing session:', …)` and dumps a whole
 * session record — straight into the middle of this process's JSON stream. The engine logged sixteen
 * "unparseable line from the bridge" warnings per occurrence, and a frame that happened to be split
 * by one of those writes would have been corrupted rather than merely noisy: an `ack` lost that way
 * is a reply that hangs for thirty seconds and is then dropped.
 *
 * Redirected rather than tolerated. A dependency cannot be asked not to print, and the protocol
 * cannot afford to share the channel.
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

/** The bridge's one handler, over the bridge's one connection — and the environment, for a bridge run on its own. */
const handler = new Handler(
  { currentSocket, isLinked, start, stop, logout, phoneForLid },
  {
    sessionDir: process.env.NOURIDE_WA_SESSION_DIR ?? "",
    sessionKey: process.env.NOURIDE_WA_SESSION_KEY ?? "",
  },
);

/**
 * Supply what the environment would have carried, for a bridge running inside another process.
 *
 * The in-process host calls this; without it the environment is read. The session
 * directory still arrives over the protocol in `hello` and still wins over this — the engine holds
 * the config — so this is really about the key.
 */
export function configure(input: { sessionDir?: string; encryptionKey: string }): void {
  handler.configure(input);
}

/**
 * Feed one protocol line in. The engine's in-process host calls this, one line at a time.
 *
 * Commands are handled one at a time by the caller, and that is load-bearing: `send` awaits the
 * network, and processing the next line concurrently would let two replies to the same chat race
 * into the wrong order.
 */
export async function handleLine(line: string): Promise<void> {
  await handler.handleLine(line);
}

/**
 * Tear the connection down without ending the host.
 *
 * The daemon may drop a WhatsApp gateway and keep running, so ending the bridge cannot mean ending the
 * process — and a socket left open would fight the next bridge for the same credentials.
 */
export function stopBridge(): void {
  stop();
}
