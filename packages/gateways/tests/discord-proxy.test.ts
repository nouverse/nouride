/**
 * Discord's gateway socket goes through the proxy the environment names — `createGateways` (`src/index.ts`).
 *
 * Under Bun discord.js builds its gateway socket with the global `WebSocket`, which reads no proxy variable, while its REST
 * goes by `fetch`, which does: a pod that may only leave through its egress proxy got the gateway's address and then
 * dialled it directly. Here the REST API and the gateway are the test's own; the gateway
 * says hello and refuses the token with 4004, as Discord's does. The REST API sits on `localhost`, listed in NO_PROXY, so
 * only the socket is asked to take the proxy.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { serveHttp, serveWebSocket, startConnectProxy, type ConnectProxy } from "../../runtime/tests/fixtures/proxy-rig.ts";

const run = promisify(execFile);

const identified: string[] = [];
const gateway = serveWebSocket({
  open: (ws) => ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 }, s: null, t: null })),
  message: (ws, data) => {
    const payload = JSON.parse(String(data)) as { op: number };
    if (payload.op !== 2) return;
    identified.push("identify");
    ws.close(4004, "Authentication failed.");
  },
});
const api = serveHttp("localhost", (req) =>
  new URL(req.url).pathname.endsWith("/gateway/bot")
    ? Response.json({
        url: `ws://127.0.0.1:${gateway.port}`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      })
    : Response.json({ message: "Not Found", code: 0 }, { status: 404 }),
);
let proxy: ConnectProxy;
beforeAll(async () => {
  proxy = await startConnectProxy();
});
afterAll(() => {
  proxy.close();
  gateway.stop(true);
  api.stop(true);
});

test("the gateway socket opens through HTTP(S)_PROXY, and the refusal is Discord's own", async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|no)_proxy$/i.test(name)));
  // Not `spawnSync`: the proxy and both servers answer from this process, which must keep running meanwhile.
  const { stdout } = await run(process.execPath, [join(import.meta.dir, "fixtures/discord-through-proxy.ts"), `http://localhost:${api.port}/api`], {
    timeout: 30_000,
    env: { ...env, HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "localhost" },
  });
  const { ended } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { ended: string };
  expect(proxy.targets).toEqual([`127.0.0.1:${gateway.port}`]);
  expect(identified).toEqual(["identify"]);
  expect(ended).toBe("Error: Authentication failed");
});
