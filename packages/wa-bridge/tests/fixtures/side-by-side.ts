/**
 * Two connections in one process, as a daemon with two WhatsApp numbers holds them: run as its own process by
 * `connection.test.ts`, because it stands Baileys in for the whole module graph and a test run is one process.
 *
 * Each socket Baileys would have opened is a stand-in whose events the script fires by hand: signed in, a message, a
 * photo, a close that asks for a restart, a 401, a save of its credentials. Each connection speaks to a stand-in of its
 * own too, which keeps its events and what it says of each reconnect. One number is put through each of them, then
 * unlinked and stopped, and after each the other is looked at: still signed in, its socket not ended, its listeners
 * still counting, its login still on disk, and its channel holding only its own events.
 *
 * Prints what was seen at each step, as JSON on the last line.
 */

import { mock } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import * as baileys from "@whiskeysockets/baileys";

interface StandIn {
  listeners: Map<string, (payload: unknown) => void>;
  auth: unknown;
  ended: boolean;
  loggedOut: boolean;
  fire(name: string, payload: unknown): void;
}

const sockets: StandIn[] = [];
/** Where a step holds the network's answer for the version, as a slow network does: open until it is let go. */
let versionHeld: Promise<void> | null = null;
mock.module("@whiskeysockets/baileys", () => ({
  ...baileys,
  fetchLatestBaileysVersion: async () => {
    if (versionHeld) await versionHeld;
    return { version: [2, 3000, 1], isLatest: true };
  },
  // A photo's bytes, as Baileys would have fetched them.
  downloadMediaMessage: async () => Buffer.from("a photo's bytes"),
  default: (config: { auth: unknown }) => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const standIn: StandIn = { listeners, auth: config.auth, ended: false, loggedOut: false, fire: (name, payload) => listeners.get(name)?.(payload) };
    sockets.push(standIn);
    return {
      ev: { on: (name: string, listener: (payload: unknown) => void) => listeners.set(name, listener), removeAllListeners: (name: string) => listeners.delete(name) },
      end: () => void (standIn.ended = true),
      logout: async () => void (standIn.loggedOut = true),
      user: { id: `62800000000${sockets.length}:1@s.whatsapp.net` },
    };
  },
}));

const { Connection } = await import("../../src/connection.ts");
const { eventually } = await import("../wait.ts");

const [shopDir, homeDir] = [process.argv[2]!, process.argv[3]!];
const key = "a".repeat(64);

/** A connection with the events it handed up, by type, and what it noted of its reconnects. */
function number() {
  const events: { type: string; status?: string; text?: string; reason?: string; media?: { path: string } }[] = [];
  const waits: { in_ms: number; attempt: number }[] = [];
  const connection = new Connection({
    emit: (event) => void events.push(event as (typeof events)[number]),
    note: (said, detail) => void (said === "reconnecting" && waits.push(detail as (typeof waits)[number])),
    exit: (code) => {
      throw new Error(`a connection asked to exit with ${code}`);
    },
  });
  const said = () => events.splice(0).map((event) => (event.type === "status" ? `status:${event.status}` : event.type === "message" ? `message:${event.text}` : event.type));
  return { connection, events, said, waited: () => waits.splice(0).map((wait) => `try ${wait.attempt} in ${wait.in_ms} ms`) };
}

const message = (text: string) => ({ type: "notify", messages: [{ key: { remoteJid: "628111@s.whatsapp.net", id: `m-${text}`, fromMe: false }, message: { conversation: text }, messageTimestamp: 1, pushName: "Budi" }] });
/** Whether it came to hold in time: a step that does not is written down as one, and the run goes on to its end. */
const came = (holds: () => boolean) => eventually(holds, 10_000).then(() => true, () => false);
/** A message is forwarded off the socket's own event, a step later: waited for by what it leaves on the channel. */
const heard = (of: ReturnType<typeof number>) => came(() => of.events.some((event) => event.type === "message"));
const saved = (dir: string) => existsSync(dir) && readdirSync(dir).some((name) => name === "creds.enc");
const photo = { type: "notify", messages: [{ key: { remoteJid: "628111@s.whatsapp.net", id: "m-photo", fromMe: false }, message: { imageMessage: { mimetype: "image/jpeg", caption: "a photo" } }, messageTimestamp: 2, pushName: "Budi" }] };
const closedToRestart = { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } };
/** The newest socket opened on a login: a number's own, whichever order the two reconnected in. */
const newestOn = (auth: unknown) => sockets.findLast((socket) => socket.auth === auth)!;

// ── two started in the same moment each open a socket: one's connect in progress does not hold the other's back
const [first, second] = [number(), number()];
await Promise.all([first.connection.start(`${shopDir}-together`, key), second.connection.start(`${homeDir}-together`, key)]);
const seen: Record<string, unknown> = { startedTogether: sockets.length };
first.connection.stop();
second.connection.stop();
sockets.length = 0;

const shop = number();
const home = number();
await shop.connection.start(shopDir, key);
await home.connection.start(homeDir, key);
const [shopFirst, homeSocket] = [sockets[0]!, sockets[1]!];
Object.assign(seen, { ownLogins: shopFirst.auth !== homeSocket.auth, socketsAtStart: sockets.length });

// ── signed in, one after the other
shopFirst.fire("connection.update", { connection: "open" });
seen.shopSignedIn = { shop: shop.said(), home: home.said(), linked: [shop.connection.isLinked(), home.connection.isLinked()] };
homeSocket.fire("connection.update", { connection: "open" });
home.said();

// ── a message for one
shopFirst.fire("messages.upsert", message("for the shop"));
await heard(shop);
seen.aMessage = { shop: shop.said(), home: home.said() };

// ── each saves its own credentials
shopFirst.fire("creds.update", {});
homeSocket.fire("creds.update", {});
await came(() => saved(shopDir) && saved(homeDir));
seen.bothSaved = [saved(shopDir), saved(homeDir)];

// ── one is told to restart, and reconnects: the other's socket and listeners are as they were
shopFirst.fire("connection.update", closedToRestart);
const reconnected = await came(() => sockets.length === 3);
homeSocket.fire("messages.upsert", message("for the home, after the shop reconnected"));
await heard(home);
seen.aReconnect = { reconnected, shop: shop.said(), home: home.said(), shopsOldSocketEnded: shopFirst.ended, homesSocketEnded: homeSocket.ended, homeLinked: home.connection.isLinked() };

// ── a photo for the one that reconnected is kept in its own folder
newestOn(shopFirst.auth).fire("connection.update", { connection: "open" });
shop.said();
newestOn(shopFirst.auth).fire("messages.upsert", photo);
await heard(shop);
homeSocket.fire("messages.upsert", photo);
await heard(home);
const keptIn = (events: typeof shop.events) => {
  const path = events.splice(0).find((event) => event.type === "message")?.media?.path ?? "";
  return path.startsWith(`${shopDir}/`) ? "the shop's folder" : path.startsWith(`${homeDir}/`) ? "the home's folder" : `elsewhere: ${path}`;
};
seen.aPhotoEach = { shops: keptIn(shop.events), homes: keptIn(home.events) };
shop.waited();

// ── both are told to restart at once: each reconnects, on its own timer
newestOn(shopFirst.auth).fire("connection.update", closedToRestart);
homeSocket.fire("connection.update", closedToRestart);
const bothReconnected = await came(() => sockets.length === 5);
const [shopNow, homeNow] = [newestOn(shopFirst.auth), newestOn(homeSocket.auth)];
seen.bothAtOnce = { bothReconnected, aSocketEach: shopNow !== homeNow && sockets.indexOf(shopNow) >= 3 && sockets.indexOf(homeNow) >= 3, shopWaited: shop.waited(), homeWaited: home.waited() };
shopNow.fire("connection.update", { connection: "open" });
homeNow.fire("connection.update", { connection: "open" });
shop.said();
home.said();

// ── one is refused by WhatsApp (401): it says so and stops alone
shopNow.fire("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
seen.aRefusal = { shop: shop.said(), home: home.said(), homeLinked: home.connection.isLinked(), homesSocketEnded: homeNow.ended, shopsLoginKept: saved(shopDir) };

// ── one is unlinked: its login is deleted, the other's is not
await shop.connection.logout();
seen.aLogout = { shopsLogin: saved(shopDir), homesLogin: saved(homeDir), homeLinked: home.connection.isLinked() };

// ── one is stopped: the other still takes a message, and still reconnects when it is told to
shop.connection.stop();
homeNow.fire("messages.upsert", message("for the home, after the shop stopped"));
await heard(home);
const before = sockets.length;
homeNow.fire("connection.update", closedToRestart);
const homeReconnected = await came(() => sockets.length === before + 1);
seen.aStop = { home: home.said(), homeReconnected, onItsOwnLogin: newestOn(homeSocket.auth) === sockets.at(-1), sockets: sockets.length };

home.connection.stop();

// ── stopped while its connect waits on the network for the version: once the answer comes, no socket is opened
const late = number();
let answer!: () => void;
versionHeld = new Promise<void>((resolve) => (answer = resolve));
const countBefore = sockets.length;
const connecting = late.connection.start(`${homeDir}-late`, key);
await came(() => existsSync(`${homeDir}-late`));
late.connection.stop();
answer();
await connecting;
versionHeld = null;
// A turn of the loop for anything the connect would still do once resumed.
await new Promise((resolve) => setImmediate(resolve));
seen.stoppedWhileConnecting = { socketsOpened: sockets.length - countBefore, linked: late.connection.isLinked(), said: late.said() };
console.log(JSON.stringify(seen));
process.exit(0);
