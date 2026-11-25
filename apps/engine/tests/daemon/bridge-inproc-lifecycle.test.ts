/**
 * The in-process WhatsApp bridge, closed the way the adapter closes it on every reconnect: a
 * `shutdown` queued, then the channel closed straight after.
 *
 * Found in a real container: the queued `shutdown` ran after `close` had restored the bridge's
 * standalone io, so its `exit(0)` was `process.exit(0)` — the daemon, every gateway and the dashboard
 * went down with code 0 on each reconnect, and a supervisor restarted it into the same loop.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../wait.ts";

// The package name is the build's to resolve; here it is pointed at the plugin's own source, so the
// bridge under test is the real one.
const PLUGIN = join(import.meta.dir, "../../../../packages/wa-bridge/src");
mock.module("nouride-wa-bridge", () => import(join(PLUGIN, "index.ts")));
mock.module("nouride-wa-bridge/io", () => import(join(PLUGIN, "io.ts")));
const { openInProcess } = await import("@/modules/gateways/bridge-inproc.ts");

const dirs: string[] = [];
const context = () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-wa-inproc-"));
  dirs.push(dir);
  return { sessionDir: dir, encryptionKey: "a".repeat(64) };
};
const settle = () => sleep(50);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The next event a channel hands up. One reader for each channel: its lines are a queue, read once. */
function reader(channel: { lines(): AsyncIterable<string> }): () => Promise<Record<string, unknown>> {
  const lines = channel.lines()[Symbol.asyncIterator]();
  return async () => JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
}

describe("a bridge for each WhatsApp connection", () => {
  test("two are hosted side by side, each on its own channel: what one is told and what ends it are its own", async () => {
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const shop = await openInProcess("shop", context());
      const home = await openInProcess("home", context());
      const [fromShop, fromHome] = [reader(shop), reader(home)];
      // Each is answered on the channel it was written to. Were one's events handed up the other's, the first
      // thing the second read would be the first one's answer.
      shop.writeLine("not a command");
      expect(await fromShop()).toMatchObject({ type: "error", message: expect.stringContaining("malformed command") });
      home.writeLine(JSON.stringify({ type: "typing", chatId: "628@s.whatsapp.net" }));
      expect(await fromHome()).toEqual({ type: "error", message: "no hello received" });

      // One is closed, as the adapter closes it: the other stays open and still answers.
      let homeClosed = false;
      void home.closed.then(() => (homeClosed = true));
      shop.writeLine(JSON.stringify({ type: "shutdown" }));
      shop.close();
      await shop.closed;
      home.writeLine("not a command either");
      expect(await fromHome()).toMatchObject({ type: "error", message: expect.stringContaining("malformed command") });
      expect(homeClosed).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      home.close();
      await home.closed;
    } finally {
      exit.mockRestore();
    }
  });

  test("a bridge that ends itself ends alone: another number's protocol mismatch closes no other channel", async () => {
    const shop = await openInProcess("shop", context());
    const home = await openInProcess("home", context());
    let homeClosed = false;
    void home.closed.then(() => (homeClosed = true));
    shop.writeLine(JSON.stringify({ type: "hello", version: -1, sessionDir: "" }));
    await shop.closed;
    // Still answering, after the other's end has run its course.
    const fromHome = reader(home);
    home.writeLine("not a command");
    expect(await fromHome()).toMatchObject({ type: "error" });
    expect(homeClosed).toBe(false);
    home.close();
    await home.closed;
  });

  test("never two for one connection: a second while the first is open is refused, and taken once it has closed", async () => {
    const first = await openInProcess("shop", context());
    await expect(openInProcess("shop", context())).rejects.toThrow("[gateways.whatsapp.shop] cannot start: this connection's WhatsApp bridge is already open in this daemon");
    first.close();
    await first.closed;
    const again = await openInProcess("shop", context());
    again.close();
    await again.closed;
  });
});

describe("closing the in-process bridge", () => {
  test("a shutdown queued before close does not exit the daemon", async () => {
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const channel = await openInProcess("main", context());
      channel.writeLine(JSON.stringify({ type: "shutdown" }));
      channel.close();
      await channel.closed;
      await settle();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  test("and does not close the channel a reconnect opened after it", async () => {
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const first = await openInProcess("main", context());
      first.writeLine(JSON.stringify({ type: "shutdown" }));
      first.close();
      const second = await openInProcess("main", context());
      let secondClosed = false;
      void second.closed.then(() => {
        secondClosed = true;
      });
      await settle();
      expect(secondClosed).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      second.close();
      await second.closed;
    } finally {
      exit.mockRestore();
    }
  });
});
