/**
 * The event stream's protocol 1.1 (`routes/events.ts`, `docs/EVENTS.md`): what the wire carries and when, read as
 * bytes — the route's other tests read rows through the CLI's parser, which drops every `id:`, so nothing failed if a
 * row stopped carrying the line a browser resumes from.
 *
 * A reader is told what 1.0 left it to guess: a cursor past the newest row (a database restored), rows gone with their
 * turns' retention, more than one stream replays. It is read at its own pace — a page per pull, a bounded queue, a
 * slow reader closed and resumed from the table — and what it is sent is the contract's row, nothing beside it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EVENT_PROTOCOL_VERSION, STREAM_ROW_KEYS, addLogSink, parseSse, type LogEntry } from "@nouride/shared";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import { backupDatabase, restoreDatabase } from "@/db/backup.ts";
import { databaseEpoch } from "@/db/epoch.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { EventStore, type EventFilter, type EventRow } from "@/modules/events/events.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import { wireRow } from "@/modules/web/control/routes/events.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { buildHealth } from "@/modules/web/health.ts";
import { controlLine } from "../../../cli/src/commands/events.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { sleep } from "../wait.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let events: EventStore;
let app: Hono;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-stream-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  events = new EventStore(db, Date.now, { epoch: "epoch-one" });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    events,
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`/api/control${path}`, { headers: { "x-nouride-token": TOKEN, ...headers } }, { clientAddress: "203.0.113.10" });
const note = (text: string, chatId = "c1") => events.append({ kind: "note", turnId: "t", chatId, data: { step: 1, text } });
const tick = () => sleep(10);

/** The stream's bytes until `done` says so, or a second passes. */
async function bytes(body: ReadableStream<Uint8Array>, done: (text: string) => boolean): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = Date.now() + 1_000;
  while (!done(text) && Date.now() < until) {
    const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))]);
    if (next === null) continue;
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

/** Every frame of a stream, rows and control frames alike, until `count` of them have come. */
async function framesOf(body: ReadableStream<Uint8Array>, count: number): Promise<{ event?: string; id?: string; data: Record<string, unknown> }[]> {
  const got: { event?: string; id?: string; data: Record<string, unknown> }[] = [];
  for await (const frame of parseSse(body)) {
    got.push({ ...(frame.event ? { event: frame.event } : {}), ...(frame.id ? { id: frame.id } : {}), data: JSON.parse(frame.data) as Record<string, unknown> });
    if (got.length >= count) break;
  }
  return got;
}

describe("the stream's framing", () => {
  test("it opens with `retry:` and the cursor it starts from, and every row carries its seq as `id:`", async () => {
    note("one");
    note("two");
    const text = await bytes((await get("/events/stream?chat=c1&since=1")).body!, (seen) => seen.includes('"two"'));
    // An id-only block right after `retry:` — a drop before the first row resumes from 1, not from what the URL said.
    expect(text.startsWith("retry: 3000\n\nid: 1\n\n")).toBe(true);
    expect(text).toContain('id: 2\ndata: {"seq":2,');
  });

  test("a row on the wire is the contract's envelope — its keys, and nothing the store keeps beside them", async () => {
    note("one");
    const page = (await (await get("/events")).json()) as { events: Record<string, unknown>[] };
    expect(Object.keys(page.events[0]!)).toEqual([...STREAM_ROW_KEYS]);
    const stored = { ...events.list({})[0]!, internal: "never on the wire" } as EventRow;
    expect(Object.keys(wireRow(stored))).toEqual([...STREAM_ROW_KEYS]);
  });

  test("the page says the oldest and newest rows there are, and the protocol", async () => {
    note("one");
    note("two");
    const page = (await (await get("/events?since=1")).json()) as { version: string; oldest: number; latest: number; next: number };
    expect(page).toMatchObject({ version: EVENT_PROTOCOL_VERSION, oldest: 1, latest: 2, next: 2 });
  });
});

describe("control frames, for a reader that asks", () => {
  test("`hello` first: the protocol, the oldest and newest rows, and the database's epoch", async () => {
    note("one");
    const [hello, row] = await framesOf((await get("/events/stream?frames=1")).body!, 2);
    expect(hello).toEqual({ event: "hello", data: { version: EVENT_PROTOCOL_VERSION, oldest: 1, latest: 1, epoch: "epoch-one" } });
    expect(row?.data.seq).toBe(1);
  });

  test("none for a reader that does not ask — 1.0's stream, rows only", async () => {
    note("one");
    const text = await bytes((await get("/events/stream")).body!, (seen) => seen.includes('"one"'));
    expect(text).not.toContain("event:");
  });

  test("a cursor past the newest row — a database restored — is reset, and the rows written next reach it", async () => {
    note("one");
    note("two");
    const reading = framesOf((await get("/events/stream?frames=1", { "last-event-id": "40" })).body!, 3);
    await tick();
    note("three");
    const [, reset, row] = await reading;
    expect(reset).toEqual({ event: "reset", data: { latest: 2 } });
    expect(row?.data).toMatchObject({ seq: 3, data: { text: "three" } });
  });

  test("a cursor before the oldest row is told what was swept with its turns", async () => {
    for (const text of ["a", "b", "c", "d"]) note(text);
    db.prepare("DELETE FROM events WHERE seq < 3").run();
    const [, gap, row] = await framesOf((await get("/events/stream?frames=1&since=0")).body!, 3);
    expect(gap).toEqual({ event: "gap", data: { since: 0, until: 2, reason: "swept" } });
    expect(row?.data.seq).toBe(3);
  });
});

describe("read at the reader's pace", () => {
  test("a replay longer than one page comes back whole and in order, and the live rows after it", async () => {
    events.batch(() => {
      for (let n = 1; n <= 1_200; n += 1) note(`row ${n}`);
    });
    const reading = framesOf((await get("/events/stream?since=0")).body!, 1_201);
    await tick();
    note("live");
    const rows = await reading;
    expect(rows.map((row) => row.data.seq)).toEqual(Array.from({ length: 1_201 }, (_, n) => n + 1));
    expect(rows.at(-1)?.data).toMatchObject({ data: { text: "live" } });
  });

  test("past the replay cap it stops, says where to page from, and goes on from the newest row", async () => {
    events.batch(() => {
      for (let n = 1; n <= 5_200; n += 1) note(`row ${n}`);
    });
    const reading = framesOf((await get("/events/stream?frames=1&since=0")).body!, 1 + 5_000 + 1 + 1);
    await tick();
    note("live");
    const frames = await reading;
    expect(frames.slice(1, 5_001).map((frame) => frame.data.seq)).toEqual(Array.from({ length: 5_000 }, (_, n) => n + 1));
    expect(frames[5_001]).toEqual({ event: "gap", data: { since: 5_000, until: 5_200, reason: "capped" } });
    expect(frames[5_002]?.data).toMatchObject({ seq: 5_201, data: { text: "live" } });
  });

  test("a reader that lets the queue fill is closed with `bye`, and comes back from its last id missing nothing", async () => {
    const reader = (await get("/events/stream?frames=1&tail=1")).body!.getReader();
    await reader.read();
    // It stops reading; 2,001 rows arrive meanwhile.
    events.batch(() => {
      for (let n = 1; n <= 2_001; n += 1) note(`row ${n}`);
    });
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toContain('event: bye\ndata: {"reason":"slow"}');
    // Resumed from where it was — the stream's first cursor, 0 — the table has every row.
    const resumed = await framesOf((await get("/events/stream", { "last-event-id": "0" })).body!, 2_001);
    expect(resumed.map((row) => row.data.seq)).toEqual(Array.from({ length: 2_001 }, (_, n) => n + 1));
  });
});

describe("one filter, read two ways", () => {
  test("each filter shape returns the same rows from the table as a watcher is handed them", () => {
    const shapes: EventFilter[] = [{}, { turnId: "t1" }, { chatId: "c1" }, { chatId: "c1", gatewayId: "g1" }, { gatewayId: "g1" }, { kinds: ["tool"] }, { turnId: "t1", chatId: "c2" }, { since: 3 }];
    const watched = shapes.map((shape) => {
      const seen: number[] = [];
      events.subscribe(shape, (row) => void seen.push(row.seq));
      return seen;
    });
    for (const [turnId, gatewayId, chatId, kind] of [
      ["t1", "g1", "c1", "note"],
      ["t1", "g2", "c1", "tool"],
      ["t2", "g1", "c2", "note"],
      ["t2", "g1", "c1", "tool"],
      ["t1", "g1", "c2", "note"],
    ] as const) {
      events.append(kind === "tool" ? { kind, turnId, gatewayId, chatId, data: { step: 1, text: "x", callId: "a", name: "exec" } } : { kind, turnId, gatewayId, chatId, data: { step: 1, text: "x" } });
    }
    shapes.forEach((shape, index) => {
      expect({ shape, rows: watched[index] }).toEqual({ shape, rows: events.list(shape).map((row) => row.seq) });
    });
  });
});

describe("a row that could not be written", () => {
  test("is counted, said at warn — once a minute however many — and named on /health", () => {
    let clock = 1_000_000;
    const broken = { prepare: () => { throw new Error("disk full"); }, inTransaction: () => false } as unknown as SqliteDb;
    const store = new EventStore(broken, () => clock);
    const said: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "events" && entry.level === "warn" && said.push(entry)));
    expect(store.append({ kind: "note", turnId: "t", data: { step: 1, text: "lost" } })).toBe(0);
    store.append({ kind: "note", turnId: "t", data: { step: 1, text: "lost" } });
    expect(store.dropped()).toBe(2);
    expect(said).toHaveLength(1);
    clock += 61_000;
    store.append({ kind: "note", turnId: "t", data: { step: 1, text: "lost" } });
    expect(said).toHaveLength(2);
    expect(said[1]?.data).toMatchObject({ lost: 2, total: 3 });

    const health = buildHealth({ config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map(), events: store } as unknown as DaemonContext);
    expect(health.payload.issues).toContain("event stream: 3 row(s) not recorded since start");
    expect(health.payload.eventProtocol).toBe(EVENT_PROTOCOL_VERSION);
  });
});

describe("the database's epoch", () => {
  test("is the same each time it is asked, and new once the database is restored to an older state", async () => {
    const dbPath = join(dir, "t.db");
    const first = databaseEpoch(dbPath);
    expect(databaseEpoch(dbPath)).toBe(first);
    const taken = backupDatabase({ db, dataDir: dir, keep: 1 });
    expect(taken.path).not.toBeNull();
    expect(restoreDatabase({ from: taken.path!, dbPath }).ok).toBe(true);
    expect(databaseEpoch(dbPath)).not.toBe(first);
  });
});

describe("`nouride events`, told by a control frame", () => {
  test("another major is said; this one is not", () => {
    expect(controlLine({ event: "hello", data: { version: "2.0", oldest: 1, latest: 9, epoch: "e" } }, null).line).toContain("event protocol 2.0");
    expect(controlLine({ event: "hello", data: { version: "1.9", oldest: 1, latest: 9, epoch: "e" } }, null)).toEqual({});
  });

  test("rows too many to replay: where to page from, and the follow goes on past them; a reset follows from the newest", () => {
    expect(controlLine({ event: "gap", data: { since: 10, until: 99, reason: "capped" } }, 10)).toEqual({
      line: expect.stringContaining("nouride events --since 10"),
      from: 99,
    });
    expect(controlLine({ event: "reset", data: { latest: 7 } }, 40)).toMatchObject({ from: 7 });
  });
});

describe("a reader that goes", () => {
  test("takes its subscription, its heartbeat and its place among the open streams with it", async () => {
    const subscribed = { now: 0 };
    const counted = new Proxy(events, {
      get(target, key, receiver) {
        if (key !== "subscribe") return Reflect.get(target, key, receiver);
        return (filter: EventFilter, listener: (row: EventRow) => void) => {
          subscribed.now += 1;
          const stop = target.subscribe(filter, listener);
          return () => {
            subscribed.now -= 1;
            stop();
          };
        };
      },
    });
    const open = { now: 0 };
    const streams = { add: () => ((open.now += 1), () => void (open.now -= 1)) };
    const app = new Hono();
    mountControlRoutes(app, {
      ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
      token: TOKEN,
      audit: new AuditLog(db),
      users: new UserStore({ db }),
      files: {},
      events: counted,
      streams,
    } as unknown as ControlDeps);
    const res = await app.request("/api/control/events/stream?tail=1", { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });
    const reader = res.body!.getReader();
    await reader.read();
    expect({ subscribed: subscribed.now, open: open.now }).toEqual({ subscribed: 1, open: 1 });
    await reader.cancel();
    await tick();
    expect({ subscribed: subscribed.now, open: open.now }).toEqual({ subscribed: 0, open: 0 });
  });
});
