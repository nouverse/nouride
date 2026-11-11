/**
 * An open event stream does not hold the shutdown.
 *
 * A stream never finishes on its own, and the server's graceful stop waits for every response to: one dashboard tab
 * on a conversation, or `nouride events -f`, held each restart to the thirty-second deadline — seen in the 0.7.6
 * end-to-end run as `shutdown timed out — forcing exit`, a forced exit past the lock's release, the database's close
 * and the clean-shutdown mark. Through the real runtime server and the real stream route.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath, serveHttp, type HttpServer, type SqliteDb } from "@nouride/runtime";
import { drain } from "@/boot/shutdown.ts";
import { openAndMigrate } from "@/db/index.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { registerEventRoutes } from "@/modules/web/control/routes/events.ts";
import { OpenStreams } from "@/modules/web/control/streams.ts";
import type { ControlApp, ControlDeps } from "@/modules/web/control/types.ts";
import { tempDir } from "../helpers.ts";
import { sleep } from "../wait.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function served(): Promise<{ server: HttpServer; streams: OpenStreams; db: SqliteDb; url: string }> {
  const dir = tempDir("shutdown-streams");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  const streams = new OpenStreams();
  const app = new Hono() as unknown as ControlApp;
  // The command line's token, as `nouride` asks: it reads every conversation (`whose.ts`).
  app.use("*", async (c, next) => {
    c.set("principal" as never, { kind: "token", actor: "cli", role: "admin" } as never);
    await next();
  });
  registerEventRoutes(app, { events: new EventStore(db), streams, ctx: { config: { people: [] } } } as unknown as ControlDeps);
  // A request that never answers, which is not a stream anybody registered: what the grace is a net for.
  app.get("/never", () => new Promise<Response>(() => {}));
  const server = serveHttp({ port: 0, hostname: "127.0.0.1", fetch: (req, info) => app.fetch(req, { keepOpen: info.keepOpen }) });
  cleanup.push(() => server.stop(true));
  return { server, streams, db, url: `http://127.0.0.1:${server.port}` };
}

/** Everything `drain` needs besides the server and the streams, doing nothing. */
function quiet() {
  return {
    ctx: { gateways: new Map(), backgroundTimers: [], config: { daemon: { shutdownTimeoutMs: 30_000 } } },
    pipeline: { pause: () => {}, runningTurns: () => [], drain: async () => {} },
    audit: { record: () => {}, stop: () => {} },
    approvals: { handOver: () => 0, shutDown: () => {} },
    jobs: { killAll: async () => 0 },
    lock: { release: () => {} },
    db: { close: () => {}, optimize: () => {} },
  };
}

async function shutDown(server: HttpServer, streams?: OpenStreams): Promise<number> {
  const q = quiet();
  const started = Date.now();
  const outcome = await drain(q.ctx as never, q.db as never, q.pipeline as never, q.audit as never, q.approvals as never, q.jobs as never, server, q.lock, undefined, undefined, undefined, streams);
  expect(outcome).toBe("clean");
  return Date.now() - started;
}

describe("shutting down with readers attached", () => {
  test("an open event stream is ended, and the shutdown does not wait on it", async () => {
    const { server, streams, url } = await served();
    const response = await fetch(`${url}/events/stream?tail=1`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("retry: 3000");

    expect(await shutDown(server, streams)).toBeLessThan(1_000);
    // The reader sees its stream end — and, being a reader, reconnects to the next daemon from its cursor.
    let ended = false;
    for (let i = 0; i < 10 && !ended; i += 1) ended = (await reader.read()).done;
    expect(ended).toBe(true);
  }, 10_000);

  test("whatever else holds a connection is closed after a short grace, not at the deadline", async () => {
    const { server, url } = await served();
    void fetch(`${url}/never`).catch(() => {});
    await sleep(100);
    const took = await shutDown(server);
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(6_000);
  }, 15_000);
});
