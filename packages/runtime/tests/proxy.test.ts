/**
 * The proxy the environment names, for websockets — `src/proxy.ts`.
 *
 * Bun's `fetch` reads `HTTPS_PROXY`; its `WebSocket` and its `ws` do not, so a pod that may only leave through its egress
 * proxy never reached WhatsApp or Discord. The rules are checked against the way `fetch` reads the same variables
 * (measured on Bun 1.4.4), and the global socket against a CONNECT proxy and a websocket server of the test's own on
 * 127.0.0.1: a socket that went around the proxy reaches the server and leaves no CONNECT behind. That the agent takes
 * Bun's `ws` through the proxy is proven through Baileys itself, in `packages/wa-bridge/tests/proxy.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { proxyAgentFor, proxyFor } from "../src/index.ts";
import { startConnectProxy, startHelloServer, type ConnectProxy } from "./fixtures/proxy-rig.ts";

const run = promisify(execFile);

/** The environment with none of the proxy variables, whatever the machine running the tests has set. */
function withoutProxies(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(https?|no)_proxy$/i.test(name)));
}

describe("proxyFor, read as fetch reads it", () => {
  const P = "http://proxy.test:8888";

  test("a secure URL takes the HTTPS variables, lower case first, and never HTTP_PROXY", () => {
    expect(proxyFor("wss://web.whatsapp.com/ws/chat", { HTTPS_PROXY: P })).toBe(P);
    expect(proxyFor("https://example.com", { https_proxy: P, HTTPS_PROXY: "http://other:1" })).toBe(P);
    expect(proxyFor("wss://gateway.discord.gg", { HTTP_PROXY: P })).toBeNull();
    expect(proxyFor("wss://gateway.discord.gg", { HTTPS_PROXY: "" })).toBeNull();
  });

  test("a plain URL takes the HTTP variables", () => {
    expect(proxyFor("ws://example.com/", { HTTP_PROXY: P })).toBe(P);
    expect(proxyFor("http://example.com/", { http_proxy: P, HTTP_PROXY: "http://other:1" })).toBe(P);
    expect(proxyFor("ws://example.com/", { HTTPS_PROXY: P })).toBeNull();
  });

  test("a proxy written without a scheme is an HTTP one", () => {
    expect(proxyFor("wss://web.whatsapp.com", { HTTPS_PROXY: "egress-proxy:8888" })).toBe("http://egress-proxy:8888");
  });

  test("NO_PROXY: everything, a name and the names under it, a leading dot or star, a port", () => {
    const via = (noProxy: string, url = "wss://web.whatsapp.com/ws/chat") => proxyFor(url, { HTTPS_PROXY: P, NO_PROXY: noProxy });
    expect(via("*")).toBeNull();
    expect(via("web.whatsapp.com")).toBeNull();
    expect(via("whatsapp.com")).toBeNull();
    expect(via(".whatsapp.com")).toBeNull();
    expect(via("*.whatsapp.com")).toBeNull();
    expect(via("localhost, WhatsApp.com")).toBeNull();
    expect(via("web.whatsapp.com:443")).toBeNull();
    expect(via("web.whatsapp.com:8443")).toBe(P);
    expect(via("hatsapp.com")).toBe(P);
    expect(via("discord.gg")).toBe(P);
    expect(proxyFor("wss://web.whatsapp.com", { HTTPS_PROXY: P, no_proxy: "whatsapp.com" })).toBeNull();
  });

  test("proxyAgentFor carries the proxy for Bun's ws, and is not there for a direct connection", () => {
    const agent = proxyAgentFor("wss://web.whatsapp.com/ws/chat", { HTTPS_PROXY: P }) as unknown as { options: { proxy?: string } };
    expect(agent.options.proxy).toBe(P);
    expect(proxyAgentFor("wss://web.whatsapp.com/ws/chat", {})).toBeUndefined();
    expect(proxyAgentFor("wss://web.whatsapp.com/ws/chat", { HTTPS_PROXY: P, NO_PROXY: "whatsapp.com" })).toBeUndefined();
  });
});

/** The global class is the process's own, so it is replaced in a process of its own (`fixtures/proxied-websocket.ts`). */
describe("proxyWebSockets", () => {
  let proxy: ConnectProxy;
  const server = startHelloServer();
  beforeAll(async () => {
    proxy = await startConnectProxy();
  });
  afterAll(() => {
    proxy.close();
    server.stop(true);
  });

  test("the global WebSocket then opens through the proxy the environment names, with the protocols asked for, wrapped once", async () => {
    // Not `spawnSync`: the proxy and the server answer from this process, which must keep running meanwhile.
    const { stdout } = await run(process.execPath, [join(import.meta.dir, "fixtures/proxied-websocket.ts"), server.url], {
      timeout: 20_000,
      env: { ...withoutProxies(process.env), HTTP_PROXY: proxy.url },
    });
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({ said: "hello", protocol: "chat", wrappedOnce: true });
    expect(proxy.targets).toEqual([`127.0.0.1:${server.port}`]);
  });
});
