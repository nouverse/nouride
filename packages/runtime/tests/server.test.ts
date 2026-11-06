/**
 * A request that works before it answers may keep its connection past the idle timeout.
 *
 * Found on a Raspberry Pi: the memory pass took about ninety seconds, the server's idle timeout closed
 * the socket at sixty, and `nouride memory pass` reported the daemon unreachable while the pass went on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { serveHttp, type HttpServer } from "../src/index.ts";
import { sleep } from "./wait.ts";

let servers: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
  servers = [];
});

const silentFor = (ms: number) => sleep(ms);
/** Past the one-second idle timeout by more than Bun's check interval, which is about four seconds. */
const SILENT_MS = 6_000;

describe("keepOpen", () => {
  /**
   * Both halves at once, on two servers: the one without it is the control that says the silence really is past the
   * timeout, and run one after the other they took ten seconds of the suite for six seconds' worth of waiting.
   */
  test("with it a request silent past the idle timeout is answered; without it, the same request loses its connection", async () => {
    const without = serveHttp({ port: 0, hostname: "127.0.0.1", idleTimeoutSeconds: 1, fetch: async () => (await silentFor(SILENT_MS), new Response("done")) });
    const kept = serveHttp({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeoutSeconds: 1,
      fetch: async (_req, info) => {
        info.keepOpen(0);
        await silentFor(SILENT_MS);
        return new Response("done");
      },
    });
    servers = [without, kept];
    const [lost, answered] = await Promise.allSettled([
      fetch(`http://127.0.0.1:${without.port}/`).then((r) => r.text()),
      fetch(`http://127.0.0.1:${kept.port}/`).then((r) => r.text()),
    ]);
    expect(lost.status === "rejected" ? String(lost.reason) : `answered: ${String(lost.value)}`).toContain("closed unexpectedly");
    expect(answered).toEqual({ status: "fulfilled", value: "done" });
  }, 15_000);
});
