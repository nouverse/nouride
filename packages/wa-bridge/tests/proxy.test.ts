/**
 * The bridge's websocket goes through the proxy the environment names — `src/connection.ts`.
 *
 * Bun's `ws` reads no proxy variable, so Baileys dialled WhatsApp directly, and a hosted pod that may only leave through
 * its egress proxy closed every attempt with 408. Here Baileys' socket is pointed at a websocket server of
 * the test's own and the proxy is the test's too: a socket that went around the proxy still opens, and leaves no CONNECT.
 */

import { afterAll, beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startConnectProxy, startHelloServer, type ConnectProxy } from "../../runtime/tests/fixtures/proxy-rig.ts";

const run = promisify(execFile);
const server = startHelloServer();
let proxy: ConnectProxy;
let dir: string;
beforeAll(async () => {
  proxy = await startConnectProxy();
});
afterAll(() => {
  proxy.close();
  server.stop(true);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-proxy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The bridge in a process of its own, with these proxy variables and no others; what its socket did, and the CONNECTs. */
async function connectWith(proxies: Record<string, string>): Promise<{ opened: boolean; targets: string[] }> {
  const before = proxy.targets.length;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|no)_proxy$/i.test(name)));
  // Not `spawnSync`: the proxy and the server answer from this process, which must keep running meanwhile.
  const { stdout } = await run(process.execPath, [join(import.meta.dir, "fixtures/through-proxy.ts"), dir, server.url], {
    timeout: 20_000,
    env: { ...env, ...proxies },
  });
  const { opened } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { opened: boolean };
  return { opened, targets: proxy.targets.slice(before) };
}

test("with HTTPS_PROXY set, the socket opens through the proxy", async () => {
  expect(await connectWith({ HTTPS_PROXY: proxy.url })).toEqual({ opened: true, targets: [`127.0.0.1:${server.port}`] });
});

test("with WhatsApp in NO_PROXY, or no proxy named, it goes direct", async () => {
  expect(await connectWith({ HTTPS_PROXY: proxy.url, NO_PROXY: "whatsapp.com" })).toEqual({ opened: true, targets: [] });
  expect(await connectWith({})).toEqual({ opened: true, targets: [] });
});
