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
