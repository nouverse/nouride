/**
 * The bridge's connection with Baileys' own socket, pointed at a websocket server on 127.0.0.1 instead of WhatsApp: run as
 * its own process by `proxy.test.ts`, with the proxy variables it is given. Baileys is real but for its address and the
 * version check, so its socket goes the way the bridge sent it. Prints whether the socket opened, as JSON.
 */

import { mock } from "bun:test";
import * as baileys from "@whiskeysockets/baileys";

const [dir, serverUrl] = [process.argv[2]!, process.argv[3]!];
const real = baileys.default;
mock.module("@whiskeysockets/baileys", () => ({
  ...baileys,
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
  default: (config: Parameters<typeof real>[0]) => real({ ...config, waWebSocketUrl: serverUrl }),
}));

const io = await import("../../src/io.ts");
io.attach({ write: () => {}, exit: () => {} });
const connection = await import("../../src/connection.ts");

await connection.start(dir, "a".repeat(64));
const ws = connection.currentSocket()!.ws;
const outcome = await new Promise<{ opened: boolean; error?: string }>((resolve) => {
  ws.on("open", () => resolve({ opened: true }));
  ws.on("error", (err: unknown) => resolve({ opened: false, error: String(err) }));
});
connection.stop();
console.log(JSON.stringify(outcome));
process.exit(0);
