/**
 * A connection started again after a stop, and two connections side by side — `src/connection.ts`.
 *
 * In the daemon the bridge is a module that stays loaded, and the gateway restarts a bridge that gave up with
 * `shutdown` and a new `hello`. `shutdown` set `stopping`, and `start` never cleared it, so the restarted bridge opened
 * nothing: live, WhatsApp took no message from an internet drop until the daemon restarted (2026-10-21).
 *
 * Run in its own process (`fixtures/restart.ts`): it stands Baileys in for the whole module graph.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-restart-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a bridge started after a stop opens a socket again", () => {
  const run = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/restart.ts"), dir], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(run.status).toBe(0);
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  const { first, total } = JSON.parse(last) as { first: number; total: number };
  expect(first).toBe(1);
  expect(total).toBe(2);
});

/**
 * Two numbers in one daemon. The connection's state was the module's, so a second number would have shared the
 * socket, the login and the count that says which socket's events still matter: one number reconnecting would have
 * left the other deaf, and one unlinked would have deleted nothing or the wrong thing. Run in its own process
 * (`fixtures/side-by-side.ts`), with a stand-in for each socket Baileys would have opened.
 */
test("two connections side by side: a message, a photo, a reconnect, a refusal, a logout and a stop of one leave the other as it was", () => {
  const [shop, home] = [join(dir, "shop"), join(dir, "home")];
  const run = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/side-by-side.ts"), shop, home], { encoding: "utf8", timeout: 30_000 });
  expect(run.status).toBe(0);
  const seen = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  expect(seen).toEqual({
    // Started in the same moment, each opens its socket.
    startedTogether: 2,
    // A login each, and a socket each.
    ownLogins: true,
    socketsAtStart: 2,
    // One signs in: its channel says so, the other's says nothing and it is not signed in for it.
    shopSignedIn: { shop: ["ready", "status:connected"], home: [], linked: [true, false] },
    aMessage: { shop: ["message:for the shop"], home: [] },
    bothSaved: [true, true],
    // One reconnects on a socket of its own; the other's socket is not ended and still hands its messages up.
    aReconnect: { reconnected: true, shop: ["status:connecting"], home: ["message:for the home, after the shop reconnected"], shopsOldSocketEnded: true, homesSocketEnded: false, homeLinked: true },
    // A photo for each is kept under its own login's folder, whichever connected last.
    // Held, not downloaded, until asked for; then saved in its own number's folder, and once only.
    aPhotoEach: {
      shops: { before: "", where: "the shop's folder", again: "that file is no longer held: ask the sender to send it again" },
      homes: { before: "", where: "the home's folder", again: "that file is no longer held: ask the sender to send it again" },
    },
    // Both told to restart in the same moment: each reconnects, on a timer and a count of tries of its own.
    bothAtOnce: { bothReconnected: true, aSocketEach: true, shopWaited: ["try 1 in 1000 ms"], homeWaited: ["try 1 in 1000 ms"] },
    // One is refused by WhatsApp: it says so and stops, its login kept; the other is as it was.
    aRefusal: { shop: ["session_expired", "status:disconnected"], home: [], homeLinked: true, homesSocketEnded: false, shopsLoginKept: true },
    // One is unlinked: its own login is deleted, and no other's.
    aLogout: { shopsLogin: false, homesLogin: true, homeLinked: true },
    // One is stopped: the other still takes a message, and still reconnects when it is told to.
    aStop: { home: ["message:for the home, after the shop stopped", "status:connecting"], homeReconnected: true, onItsOwnLogin: true, sockets: 6 },
    // Stopped while its connect waits for the version: nothing is opened once the answer comes, and nothing is said.
    stoppedWhileConnecting: { socketsOpened: 0, linked: false, said: [] },
    // The groups it is in, asked once it is linked; then one joined and one it was removed from, each said whole. A
    // change to another's place in a group says nothing.
    itsGroups: {
      fetched: ["groups:g-family@g.us,g-shop@g.us"],
      after: ["groups:g-family@g.us,g-new@g.us,g-shop@g.us", "groups:g-new@g.us,g-shop@g.us"],
    },
  });
});
