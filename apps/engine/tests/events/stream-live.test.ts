/**
 * A row written after a stream opened reaches its reader at once, through the real runtime server.
 *
 * Found in 0.7.11's end-to-end run: `nouride chat` drew no progress at all, though the rows were in the database and
 * the stream answered `hello`. The stream's `pull` returned from a replay that found nothing without enqueuing
 * anything, and Bun's server does not call a pull again that ended empty-handed — so the stream sat until its
 * heartbeat, fifteen seconds on, enqueued a keep-alive from outside and woke it. A turn shorter than that was over
 * before any of its rows arrived. Tests that read the route in process never saw it: there the reader's next `read()`
 * calls `pull` again whatever the last one did.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath, serveHttp, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { registerEventRoutes } from "@/modules/web/control/routes/events.ts";
import { OpenStreams } from "@/modules/web/control/streams.ts";
import type { ControlApp, ControlDeps } from "@/modules/web/control/types.ts";
import { tempDir } from "../helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function served(): Promise<{ events: EventStore; db: SqliteDb; url: string }> {
  const dir = tempDir("stream-live");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  const events = new EventStore(db);
  const app = new Hono() as unknown as ControlApp;
  registerEventRoutes(app, { events, streams: new OpenStreams() } as unknown as ControlDeps);
  const server = serveHttp({ port: 0, hostname: "127.0.0.1", fetch: (req, info) => app.fetch(req, { keepOpen: info.keepOpen }) });
  cleanup.push(() => server.stop(true));
  return { events, db, url: `http://127.0.0.1:${server.port}` };
}

/** What the reader has received, until it holds `needle` or `withinMs` passes — far below the 15 s heartbeat. */
async function readUntil(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, needle: string, withinMs: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + withinMs;
  while (!text.includes(needle) && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
    ]);
    if (next === null || next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

describe("a live row through the real server", () => {
  test("reaches a reader that opened at the newest row, before any heartbeat", async () => {
    const { events, url } = await served();
    const reader = (await fetch(`${url}/events/stream?tail=1`)).body!.getReader();
    expect(await readUntil(reader, "retry: 3000", 2_000)).toContain("retry: 3000");

    events.append({ kind: "note", turnId: "t1", gatewayId: "web:dashboard", chatId: "cli-1", data: { step: 1, text: "live-row-1" } });
    expect(await readUntil(reader, "live-row-1", 2_000)).toContain("live-row-1");
    await reader.cancel();
  }, 10_000);

  test("reaches a reader that asked for frames and one conversation, and so does the row after it", async () => {
    const { events, url } = await served();
    const reader = (await fetch(`${url}/events/stream?tail=1&frames=1&gateway=web%3Adashboard&chat=cli-2`)).body!.getReader();
    expect(await readUntil(reader, "event: hello", 2_000)).toContain("event: hello");

    events.append({ kind: "note", turnId: "t2", gatewayId: "web:dashboard", chatId: "cli-2", data: { step: 1, text: "first" } });
    expect(await readUntil(reader, "first", 2_000)).toContain("first");
    events.append({ kind: "note", turnId: "t2", gatewayId: "web:dashboard", chatId: "cli-2", data: { step: 2, text: "second" } });
    expect(await readUntil(reader, "second", 2_000)).toContain("second");
    await reader.cancel();
  }, 10_000);

  test("a reader that resumes from a cursor gets the rows after it, then the live ones", async () => {
    const { events, url } = await served();
    const seen = events.append({ kind: "note", turnId: "t3", chatId: "c3", data: { step: 1, text: "before" } });
    events.append({ kind: "note", turnId: "t3", chatId: "c3", data: { step: 2, text: "missed" } });
    const reader = (await fetch(`${url}/events/stream?since=${seen}`)).body!.getReader();
    expect(await readUntil(reader, "missed", 2_000)).toContain("missed");

    events.append({ kind: "note", turnId: "t3", chatId: "c3", data: { step: 3, text: "after" } });
    expect(await readUntil(reader, "after", 2_000)).toContain("after");
    await reader.cancel();
  }, 10_000);
});
