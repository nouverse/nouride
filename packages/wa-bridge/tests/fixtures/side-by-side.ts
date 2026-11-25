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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as baileys from "@whiskeysockets/baileys";
import { idToSend } from "../../src/sent-here.ts";
import { sleep } from "../wait.ts";

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
/** Downloads running at once, and the most there were. */
const downloads = { live: 0, most: 0 };
/** The groups a socket's number is in, where a step says; elsewhere the ask is never answered, as a slow network's. */
let groupsOfNumber: Record<string, unknown> | null = null;
mock.module("@whiskeysockets/baileys", () => ({
  ...baileys,
  fetchLatestBaileysVersion: async () => {
    if (versionHeld) await versionHeld;
    return { version: [2, 3000, 1], isLatest: true };
  },
  // A photo's bytes, as Baileys would have fetched them: a stream of them, a step apart, counted while they run.
  downloadMediaMessage: async () =>
    (async function* () {
      downloads.live += 1;
      downloads.most = Math.max(downloads.most, downloads.live);
      await sleep(20);
      yield Buffer.from("a photo's ");
      yield Buffer.from("bytes");
      downloads.live -= 1;
    })(),
  default: (config: { auth: unknown }) => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const standIn: StandIn = { listeners, auth: config.auth, ended: false, loggedOut: false, fire: (name, payload) => listeners.get(name)?.(payload) };
    sockets.push(standIn);
    return {
      ev: { on: (name: string, listener: (payload: unknown) => void) => listeners.set(name, listener), removeAllListeners: (name: string) => listeners.delete(name) },
      end: () => void (standIn.ended = true),
      logout: async () => void (standIn.loggedOut = true),
      groupFetchAllParticipating: () => (groupsOfNumber ? Promise.resolve(groupsOfNumber) : new Promise(() => {})),
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
  const events: { type: string; status?: string; text?: string; reason?: string; media?: { path: string; held?: string }; ids?: string[] }[] = [];
  const waits: { in_ms: number; attempt: number }[] = [];
  const notes: string[] = [];
  const connection = new Connection({
    emit: (event) => void events.push(event as (typeof events)[number]),
    note: (said, detail) => void (said === "reconnecting" ? waits.push(detail as (typeof waits)[number]) : notes.push(said)),
    exit: (code) => {
      throw new Error(`a connection asked to exit with ${code}`);
    },
  });
  const said = () => events.splice(0).map((event) => (event.type === "status" ? `status:${event.status}` : event.type === "message" ? `message:${event.text}` : event.type === "groups" ? `groups:${event.ids?.join(",")}` : event.type));
  return { connection, events, said, notes, waited: () => waits.splice(0).map((wait) => `try ${wait.attempt} in ${wait.in_ms} ms`) };
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
// A file a fetch left in the media folder two days ago, nobody to read it, and one of today's.
mkdirSync(join(shopDir, "media"), { recursive: true });
writeFileSync(join(shopDir, "media", "left.jpg"), "old");
utimesSync(join(shopDir, "media", "left.jpg"), new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000));
writeFileSync(join(shopDir, "media", "today.jpg"), "new");
await shop.connection.start(shopDir, key);
seen.leftFilesSwept = { old: existsSync(join(shopDir, "media", "left.jpg")), today: existsSync(join(shopDir, "media", "today.jpg")) };
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
// The daemon's own words from another of its numbers, by the id it chose before sending (`sent-here.ts`), and a
// person's, from the same address: only the first is marked.
const ownId = idToSend();
shopFirst.fire("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "628222@s.whatsapp.net", id: ownId, fromMe: false }, message: { conversation: "from the other number" }, messageTimestamp: 3, pushName: "Nora" }] });
shopFirst.fire("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "628222@s.whatsapp.net", id: "typed-on-the-phone", fromMe: false }, message: { conversation: "typed on its phone" }, messageTimestamp: 4, pushName: "Nora" }] });
await came(() => shop.events.filter((event) => event.type === "message").length === 2);
seen.ownWords = shop.events.splice(0).filter((event) => event.type === "message").map((event) => `${event.text}:${(event as { sentHere?: boolean }).sentHere === true}`);

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
/**
 * The photo held, not downloaded, then asked for by its ref: where it lands, whether it was on disk before, whether it is
 * there for a second agent asking, and whether a connection started again on the same folder (a restart) still has it.
 */
const keptIn = async (of: typeof shop, folder: string) => {
  const media = of.events.splice(0).find((event) => event.type === "message")?.media;
  const before = media?.path ?? "";
  const path = media?.held ? await of.connection.fetchMedia(media.held) : "";
  const where = path.startsWith(`${shopDir}/`) ? "the shop's folder" : path.startsWith(`${homeDir}/`) ? "the home's folder" : `elsewhere: ${path}`;
  const again = media?.held ? await of.connection.fetchMedia(media.held).then((second) => (second !== path ? "fetched twice, to a file of its own" : "the same file"), (err: Error) => err.message) : "";
  const restarted = number().connection;
  await restarted.start(folder, key);
  const afterRestart = media?.held ? await restarted.fetchMedia(media.held).then(() => "fetched", (err: Error) => err.message) : "";
  restarted.stop();
  const onDisk = existsSync(join(folder, "held")) ? readdirSync(join(folder, "held")).filter((name) => name.endsWith(".enc")).length : 0;
  return { before, where, again, afterRestart, onDisk };
};
const shopsSockets = sockets.length;
seen.aPhotoEach = { shops: await keptIn(shop, shopDir), homes: await keptIn(home, homeDir) };
// A burst of five photos fetched together: two downloads at a time, each written whole.
for (let n = 0; n < 5; n++) newestOn(shopFirst.auth).fire("messages.upsert", { ...photo, messages: [{ ...photo.messages[0]!, key: { ...photo.messages[0]!.key, id: `m-burst-${n}` } }] });
await came(() => shop.events.filter((event) => event.type === "message").length === 5);
const refs = shop.events.splice(0).flatMap((event) => (event.type === "message" && event.media?.held ? [event.media.held] : []));
downloads.most = 0;
const burst = await Promise.all(refs.map((ref) => shop.connection.fetchMedia(ref)));
seen.aBurst = { fetched: burst.length, atOnce: downloads.most, whole: burst.every((path) => readFileSync(path, "utf8") === "a photo's bytes") };
// The two restarted connections opened sockets of their own: put away, so the count below is the run's own.
sockets.length = shopsSockets;
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

// ── the groups a number is in: asked once it is linked, then kept by the joins and leaves WhatsApp reports of it
const grouped = number();
groupsOfNumber = { "g-shop@g.us": {}, "g-family@g.us": {} };
await grouped.connection.start(`${homeDir}-groups`, key);
const groupSocket = sockets.at(-1)!;
groupSocket.fire("connection.update", { connection: "open" });
await came(() => grouped.events.some((event) => event.type === "groups"));
const fetchedGroups = grouped.said().filter((line) => line.startsWith("groups:"));
groupSocket.fire("groups.upsert", [{ id: "g-new@g.us", subject: "a new one" }]);
// Its own number removed from one, then somebody else removed from another: only the first is about it.
groupSocket.fire("group-participants.update", { id: "g-family@g.us", author: "x@s.whatsapp.net", participants: [{ id: `62800000000${sockets.length}@s.whatsapp.net` }], action: "remove" });
groupSocket.fire("group-participants.update", { id: "g-shop@g.us", author: "x@s.whatsapp.net", participants: [{ id: "628999@s.whatsapp.net" }], action: "remove" });
seen.itsGroups = { fetched: fetchedGroups, after: grouped.said() };

// ── its login cannot be written: the save's failure is said, as this number's, and nothing is left unhandled
const unhandled: string[] = [];
process.on("unhandledRejection", (err) => void unhandled.push(String(err)));
chmodSync(`${homeDir}-groups`, 0o500);
groupSocket.fire("creds.update", {});
await came(() => grouped.notes.includes("could not save the session's credentials") || unhandled.length > 0);
chmodSync(`${homeDir}-groups`, 0o700);
seen.aSaveThatFails = { said: grouped.notes.filter((line) => line.startsWith("could not save")), unhandled: unhandled.length };
grouped.connection.stop();
groupsOfNumber = null;
console.log(JSON.stringify(seen));
process.exit(0);
