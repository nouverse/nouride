/**
 * The bridge's connection hosted the way the daemon hosts it: one module, started, stopped, and started again —
 * run as its own process by `connection.test.ts`, because it replaces Baileys for the whole module graph and a test
 * run is one process.
 *
 * Prints the sockets opened, as JSON on the last line.
 */

import { mock } from "bun:test";
import * as baileys from "@whiskeysockets/baileys";

let opened = 0;
mock.module("@whiskeysockets/baileys", () => ({
  ...baileys,
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
  default: () => {
    opened += 1;
    return { ev: { on: () => {}, removeAllListeners: () => {} }, end: () => {}, user: undefined };
  },
}));

const io = await import("../../src/io.ts");
io.attach({ write: () => {}, exit: () => {} });
const connection = await import("../../src/connection.ts");

const dir = process.argv[2]!;
const key = "a".repeat(64);

await connection.start(dir, key);
const first = opened;
// What the in-process host does when the gateway restarts a bridge: `shutdown`, then a new `hello`.
connection.stop();
await connection.start(dir, key);
connection.stop();

console.log(JSON.stringify({ first, total: opened }));
