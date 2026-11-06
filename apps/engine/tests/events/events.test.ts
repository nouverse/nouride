/**
 * What turns do, as one stream (`069_baseline.sql`; why one, in `apps/engine/src/modules/events/events.store.ts`).
 *
 * The property everything rests on is the cursor: a reader that has row N and asks for what comes after misses
 * nothing and sees nothing twice — read a page, follow the stream, drop, come back. The writers are tested where
 * they write — a turn's steps and answer, a tool call as audited, a model call as metered — because a stream that
 * misses one of them is a stream an editor cannot trust, and none of them may fail the turn it watches.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { EventStore, type EventInput, type EventRow } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { eventLine, readFrames } from "@/cli/commands/events.ts";

/** The rows of a stream, its control frames left out — what `nouride events` prints a line for. */
async function* readStream(body: ReadableStream<Uint8Array>) {
  for await (const item of readFrames(body)) if (item.row) yield item.row;
}
import { EVENT_EXAMPLES } from "@nouride/shared";
import { durableStores } from "@/boot/durable.ts";
import { countingDb, turnStore } from "../helpers.ts";
import { sleep } from "../wait.ts";

/** A tool call's step and its result, as the contract has them — the stores in these tests are strict. */
const CALL = { callId: "call_1", name: "exec" };
const DONE = { callId: "call_1", name: "exec", error: false };

const WHERE = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
const SESSION = "ses_nouva:web:dashboard:web-1";
let dir = "";
let db: SqliteDb;
let events: EventStore;
let turns: EventedTurnStore;
let clock = 1_000_000;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-events-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  clock = 1_000_000;
  events = new EventStore(db, () => clock, { strict: true });
  turns = new EventedTurnStore(db, events);
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const kinds = (rows: EventRow[]) => rows.map((row) => row.kind);

describe("a turn, written down as it runs", () => {
  test("its start, each step, the answer as it grows — only what is new — and its end, in order, each saying where", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "check the build" });
    turns.step(id, "tool", "exec bun test", CALL);
    turns.setReply(id, "All ");
    turns.setReply(id, "All green.");
    turns.step(id, "tool_done", "exec bun test (2.1s)", DONE);
    turns.finish(id, { status: "done", reply: "All green.", model: "m", toolCalls: 1 });

    const rows = events.list({ turnId: id });
    expect(kinds(rows)).toEqual(["turn", "tool", "reply", "reply", "tool_done", "turn"]);
    expect(rows[0]).toMatchObject({ agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1", data: { phase: "start", prompt: "check the build" } });
    expect(rows[1]?.data).toEqual({ step: 1, text: "exec bun test", ...CALL });
    expect(rows.filter((row) => row.kind === "reply").map((row) => row.data)).toEqual([{ from: 0, text: "All " }, { from: 4, text: "green." }]);
    expect(rows.at(-1)?.data).toMatchObject({ phase: "end", status: "done", reply: "All green.", toolCalls: 1 });
    // One cursor, rising.
    expect(rows.map((row) => row.seq)).toEqual([...rows.map((row) => row.seq)].sort((a, b) => a - b));
  });

  test("a turn taken up after a restart still says whose it is, read from its record", () => {
    // Begun by another store — the last process — so this one has no live entry for it.
    const id = turnStore(db).begin({ sessionId: SESSION, ...WHERE, prompt: "begun by the last process" });
    turns.step(id, "note", "carried on");
    expect(events.list({ turnId: id, kinds: ["note"] })[0]).toMatchObject({ kind: "note", agentId: "nouva", chatId: "web-1", data: { step: 1 } });
  });

  test("a step taken back is said to be", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "x" });
    const seq = turns.step(id, "steer", "also check lint");
    turns.unstep(id, [seq]);
    expect(events.list({ turnId: id, kinds: ["unstep"] })[0]?.data).toEqual({ steps: [seq] });
  });

  test("swept with the turns, on their retention", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "old" });
    clock += 40 * 24 * 60 * 60_000;
    turns.step(id, "note", "recent");
    turns.sweep(30, clock);
    expect(kinds(events.list({}))).toEqual(["note"]);
  });
});

describe("a tool call and a model call of a turn", () => {
  test("a result's audit row is written with its tool_done — first, in the same commit, paired by the call's id", () => {
    const counted = countingDb(db);
    const stream = new EventStore(counted.db, () => clock);
    const store = new EventedTurnStore(counted.db, stream);
    const id = store.begin({ sessionId: SESSION, ...WHERE, prompt: "list it" });
    const watched: string[] = [];
    stream.subscribe({ turnId: id }, (row) => watched.push(row.kind));
    const before = counted.commits.length;
    const audit = { callId: "call_1", tool: "exec", args: { command: "ls" }, error: false, ms: 3 };
    store.step(id, "tool_done", "exec ok · 3ms", { callId: "call_1", name: "exec", error: false, audit });

    expect(counted.commits.slice(before)).toEqual([["INSERT events:audit", "INSERT events:tool_done"]]);
    const [written, done] = stream.list({ turnId: id, kinds: ["audit", "tool_done"] });
    expect(written).toMatchObject({ kind: "audit", chatId: "web-1", data: audit });
    expect(done).toMatchObject({ seq: written!.seq + 1, data: { step: 1, text: "exec ok · 3ms", callId: "call_1", name: "exec", error: false } });
    expect(done?.data).not.toHaveProperty("audit");
    expect(watched).toEqual(["audit", "tool_done"]);
  });

  test("the audit log writes no event of its own — only the table row, as it always did", () => {
    const log = new AuditLog(db, () => clock);
    log.record({ action: "tool_exec", ...WHERE, turnId: "turn_x", details: { tool: "exec", args: {}, ms: 1 } });
    log.flush();
    expect(events.list({})).toEqual([]);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log").get()?.n).toBe(1);
  });

  test("a metered call carries its model, its counts and its cost; one no turn made carries nothing", () => {
    const usage = new UsageStore(db, () => clock, events);
    usage.record({ agentId: "nouva", model: "claude-sonnet-4-6", provider: "anthropic", turnId: "turn_x", inputTokens: 1_000, outputTokens: 200, latencyMs: 900 });
    usage.record({ agentId: "nouva", model: "bge-m3", provider: "ollama", inputTokens: 10, outputTokens: 0 });
    const rows = events.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "usage", turnId: "turn_x", data: { model: "claude-sonnet-4-6", inputTokens: 1_000, outputTokens: 200, latencyMs: 900 } });
  });
});

describe("the store", () => {
  test("pages after a cursor — by turn, by conversation on one connection or any, by kind", () => {
    for (const [turnId, chatId, kind] of [["t1", "c1", "tool"], ["t2", "c2", "note"], ["t1", "c1", "note"], ["t3", "c1", "tool"]] as const) {
      events.append({ kind, turnId, agentId: "nouva", gatewayId: turnId === "t3" ? "telegram:main" : "web:dashboard", chatId, data: kind === "tool" ? { step: 1, text: "", callId: "c1", name: "exec" } : { step: 1, text: "" } } as EventInput);
    }
    expect(events.list({ turnId: "t1" }).map((row) => row.seq)).toEqual([1, 3]);
    expect(events.list({ gatewayId: "web:dashboard", chatId: "c1" }).map((row) => row.seq)).toEqual([1, 3]);
    expect(events.list({ chatId: "c1" }).map((row) => row.seq)).toEqual([1, 3, 4]);
    expect(events.list({ kinds: ["note"] }).map((row) => row.seq)).toEqual([2, 3]);
    expect(events.list({ since: 2, limit: 1 }).map((row) => row.seq)).toEqual([3]);
    expect(events.latest()).toBe(4);
  });

  test("a row too large is cut to fit and says so — each value keeping its type, the keys a reader pairs by whole", () => {
    events.append({ kind: "audit", turnId: "t", data: { callId: "call_1", tool: "write", args: { path: "a.txt", content: "x".repeat(20_000) }, ms: 3 } });
    const [row] = events.list({});
    expect(row?.data).toMatchObject({ truncated: true, cut: ["args"], callId: "call_1", tool: "write", ms: 3 });
    expect(row?.data.args).toEqual({ path: "a.txt", content: `${"x".repeat(2_000)}…` });

    // A line of escaped control characters — six characters each in JSON — used to lose its step number.
    events.append({ kind: "tool_done", turnId: "t", data: { step: 7, text: "\u0001".repeat(1_900), callId: "call_1", name: "exec", error: false } });
    expect(events.list({ kinds: ["tool_done"] })[0]?.data).toMatchObject({ step: 7, callId: "call_1", name: "exec", error: false, truncated: true, cut: ["text"] });
  });

  test("a watcher is handed what matches, once it is written — and one that throws costs nobody else", () => {
    const seen: number[] = [];
    events.subscribe({}, () => {
      throw new Error("a broken watcher");
    });
    const stop = events.subscribe({ chatId: "c1" }, (row) => seen.push(row.seq));
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "" } });
    events.append({ kind: "note", turnId: "t", chatId: "c2", data: { step: 1, text: "" } });
    stop();
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "" } });
    expect(seen).toEqual([1]);
    expect(events.latest()).toBe(3);
  });

  test("a write that fails costs the stream a row, never the turn", () => {
    db.exec("DROP TABLE events");
    expect(() => events.append({ kind: "note", turnId: "t", data: { step: 1, text: "" } })).not.toThrow();
    expect(() => turns.begin({ sessionId: SESSION, ...WHERE, prompt: "still answered" })).not.toThrow();
  });
});

describe("one transaction, one announcement", () => {
  /** A second connection: what it can count is what is committed. */
  const committed = (): number => {
    const reader = openDatabase(join(dir, "t.db"));
    try {
      return reader.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
    } finally {
      reader.close();
    }
  };

  test("a batch's rows reach a watcher after the commit, in the order they were written", () => {
    const seen: { text: unknown; visible: number }[] = [];
    events.subscribe({}, (row) => seen.push({ text: row.data.text, visible: committed() }));
    events.batch(() => {
      events.append({ kind: "note", turnId: "t1", data: { step: 1, text: "a" } });
      events.append({ kind: "note", turnId: "t1", data: { step: 2, text: "b" } });
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([{ text: "a", visible: 2 }, { text: "b", visible: 2 }]);
  });

  test("a batch that throws is rolled back and announced to nobody", () => {
    const seen: string[] = [];
    events.subscribe({}, (row) => seen.push(row.kind));
    expect(() => events.batch(() => {
      events.append({ kind: "note", turnId: "t1", data: { step: 1, text: "a" } });
      throw new Error("no");
    })).toThrow("no");
    expect(seen).toEqual([]);
    expect(events.list({})).toEqual([]);
  });

  test("a batch inside a batch joins it, and one that throws inside takes back only its own rows", () => {
    const seen: unknown[] = [];
    events.subscribe({}, (row) => seen.push(row.data.text));
    events.batch(() => {
      events.append({ kind: "note", turnId: "t1", data: { step: 1, text: "outer" } });
      events.batch(() => events.append({ kind: "note", turnId: "t1", data: { step: 1, text: "joined" } }));
      try {
        events.batch(() => {
          events.append({ kind: "note", turnId: "t1", data: { step: 1, text: "taken back" } });
          throw new Error("inner");
        });
      } catch {
        // The outer goes on.
      }
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(["outer", "joined"]);
    expect(events.list({}).map((row) => row.data.text)).toEqual(["outer", "joined"]);
  });

  test("a turn's end written in the settle is announced once committed — never after a rollback", () => {
    const { atomically } = durableStores(db, events);
    const phases: unknown[] = [];
    events.subscribe({ kinds: ["turn"] }, (row) => phases.push(row.data.phase));
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "deploy" });
    expect(() => atomically(() => {
      turns.finish(id, { status: "done", reply: "ok" });
      throw new Error("the write after it failed");
    })).toThrow();
    expect(phases).toEqual(["start"]);
    expect(turns.get(id)?.status).toBe("running");
    atomically(() => turns.finish(id, { status: "done", reply: "ok" }));
    expect(phases).toEqual(["start", "end"]);
  });

  test("a COMMIT that fails costs the rows, not the work: the batch returns, and nobody is told", () => {
    // Transactions that run and then fail to commit, as a full disk does.
    const full: SqliteDb = { ...db, transaction: <T>(fn: () => T): T => (db.transaction(fn), (() => { throw new Error("database or disk is full"); })()) };
    const store = new EventStore(full, () => clock);
    const seen: string[] = [];
    store.subscribe({}, (row) => seen.push(row.kind));
    expect(store.batch(() => (store.append({ kind: "note", turnId: "t1", data: { step: 1, text: "" } }), "answered"))).toBe("answered");
    expect(seen).toEqual([]);
  });

  test("a batch refuses work that would hold its transaction across an await", () => {
    expect(() => events.batch(() => Promise.resolve("later"))).toThrow("must not span an await");
    expect(db.inTransaction()).toBe(false);
  });

  test("a turn's start, each flush of its answer, its end, a command's answer and a metered call are one commit each", () => {
    const counted = countingDb(db);
    const stream = new EventStore(counted.db, () => clock);
    const store = new EventedTurnStore(counted.db, stream);
    const id = store.begin({ sessionId: SESSION, ...WHERE, prompt: "x" });
    store.setReply(id, "All ");
    store.finish(id, { status: "done", reply: "All green." });
    store.note({ sessionId: SESSION, ...WHERE, prompt: "/status", reply: "ok" });
    new UsageStore(counted.db, () => clock, stream).record({ agentId: "nouva", turnId: id, model: "m", provider: "p", inputTokens: 1, outputTokens: 1 });
    expect(counted.commits).toEqual([
      ["INSERT turn_records", "INSERT events:turn"],
      ["UPDATE turn_records", "INSERT events:reply"],
      ["UPDATE turn_records", "INSERT events:turn"],
      ["INSERT turn_records", "INSERT events:turn"],
      ["INSERT llm_usage", "INSERT events:usage"],
    ]);
  });
});

describe("the cursor only moves forward", () => {
  const OTHER = { sessionId: "ses_nox:web:dashboard:web-2", agentId: "nox", gatewayId: "web:dashboard", chatId: "web-2" };

  test("forgetting the newest conversation does not hand its numbers out again", () => {
    const kept = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "kept" });
    const gone = turns.begin({ ...OTHER, prompt: "deleted" });
    turns.step(gone, "note", "the newest row");
    const highest = events.latest();

    turns.deleteForSession(OTHER.sessionId);
    expect(events.list({ turnId: gone })).toEqual([]);
    turns.step(kept, "note", "written after");
    expect(events.list({ turnId: kept }).at(-1)!.seq).toBeGreaterThan(highest);
    // The newest row is blanked, not deleted, and no read is shown it.
    expect(kinds(events.list({}))).not.toContain("forgotten");
  });

  test("a sweep of every row does not start counting from 1 again", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "old" });
    turns.step(id, "note", "old too");
    const highest = events.latest();
    clock += 60_000;
    events.sweep(clock);
    expect(events.list({ turnId: id })).toEqual([]);
    expect(events.append({ kind: "note", turnId: id, data: { step: 9, text: "new" } })).toBeGreaterThan(highest);
  });
});

describe("read over the control API", () => {
  const TOKEN = "control-token-for-tests-0000000000";
  let app: Hono;
  beforeEach(() => {
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
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`/api/control${path}`, { headers: { "x-nouride-token": TOKEN, ...headers } }, { clientAddress: "203.0.113.10" });

  test("a page, with the cursor to ask from next", async () => {
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "one" } });
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "two" } });
    const page = (await (await get("/events?turn=t&limit=1")).json()) as { events: EventRow[]; next: number };
    expect(page.events.map((row) => row.data.text)).toEqual(["one"]);
    expect(page.next).toBe(1);
  });

  /** The next `count` events off an open stream. */
  async function take(body: ReadableStream<Uint8Array>, count: number): Promise<EventRow[]> {
    const got: EventRow[] = [];
    for await (const event of readStream(body)) {
      got.push(event as unknown as EventRow);
      if (got.length === count) break;
    }
    return got;
  }

  test("a stream: what was written after its cursor, then each row as it is written — for a proxy that holds nothing", async () => {
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "before" } });
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "replayed" } });
    const res = await get("/events/stream?chat=c1&since=1");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reading = take(res.body!, 2);
    await sleep(10);
    events.append({ kind: "note", turnId: "t", chatId: "c2", data: { step: 1, text: "another conversation" } });
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "live" } });
    expect((await reading).map((row) => row.data.text)).toEqual(["replayed", "live"]);
  });

  test("`tail` starts at the newest row; a reconnect's last id resumes from there instead", async () => {
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "history" } });
    const tailing = await get("/events/stream?chat=c1&tail=1");
    const fresh = take(tailing.body!, 1);
    await sleep(10);
    events.append({ kind: "note", turnId: "t", chatId: "c1", data: { step: 1, text: "new" } });
    expect((await fresh).map((row) => row.data.text)).toEqual(["new"]);

    const resumed = await get("/events/stream?chat=c1&tail=1", { "last-event-id": "1" });
    expect((await take(resumed.body!, 1)).map((row) => row.data.text)).toEqual(["new"]);
  });
});

describe("`nouride events`, as it reads the stream", () => {
  test("a frame split across chunks is read whole, and a keep-alive is not an event", async () => {
    const row = { seq: 7, at: Date.UTC(2026, 9, 16, 9, 30, 5), turnId: "turn_abcdef12", agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1", kind: "tool", data: { step: 1, text: "exec bun test" } };
    const text = `retry: 3000\n\n: keep-alive\n\nid: 7\ndata: ${JSON.stringify(row)}\n\n`;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, 40)));
        controller.enqueue(encoder.encode(text.slice(40)));
        controller.close();
      },
    });
    const seen = [];
    for await (const event of readStream(body)) seen.push(event);
    expect(seen).toEqual([row]);
    expect(eventLine(row).replace(/\x1b\[[0-9;]*m/g, "")).toBe("#7 09:30:05 tool        abcdef12 nouva exec bun test");
  });

  test("a frame it does not know — named, as a later protocol's control frames are, or not a row — is passed over", async () => {
    const row = (seq: number) => ({ seq, at: 0, turnId: "t", agentId: "nouva", gatewayId: null, chatId: null, kind: "retry", data: { step: seq, text: "asking again", reason: "provider", callId: "call_1" } });
    const text = [`id: 8\r\ndata: ${JSON.stringify(row(8))}\r\n\r\n`, `event: reset\ndata: {"latest":12}\n\n`, `event: gap\ndata: ${JSON.stringify(row(99))}\n\n`, `data: {"latest":12}\n\n`, `id: 9\ndata: ${JSON.stringify(row(9))}\n\n`].join("");
    const body = new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(new TextEncoder().encode(text)), controller.close()) });
    const seen = [];
    for await (const event of readStream(body)) seen.push(event.seq);
    expect(seen).toEqual([8, 9]);
    expect(eventLine(row(8)).replace(/\x1b\[[0-9;]*m/g, "")).toBe("#8 00:00:00 retry       t nouva asking again");
  });

  test("every kind of row prints, saying something — and a kind newer than this CLI prints its text, marked", () => {
    for (const [kind, data] of Object.entries(EVENT_EXAMPLES)) {
      const line = eventLine({ seq: 7, at: 0, turnId: "turn_x", agentId: "nouva", gatewayId: null, chatId: null, kind, data } as never);
      const said = line.replace(/\x1b\[[0-9;]*m/g, "").split(/\s+nouva\s+/)[1] ?? "";
      expect({ kind, said: said.trim().length > 0, marked: line.includes("newer than this CLI") }).toEqual({ kind, said: true, marked: false });
    }
    const newer = eventLine({ seq: 8, at: 0, turnId: null, agentId: null, gatewayId: null, chatId: null, kind: "signal", data: { text: "a new kind of row" } } as never);
    expect(newer).toContain("a new kind of row");
    expect(newer).toContain("newer than this CLI");
  });

  test("a person's edit is said in a word: a turn answering one, and a message edited while a turn worked, its ✎ left off (stream 1.3)", () => {
    const line = (kind: string, data: Record<string, unknown>) => eventLine({ seq: 1, at: 0, turnId: "t", agentId: "nouva", gatewayId: null, chatId: null, kind, data } as never).replace(/\x1b\[[0-9;]*m/g, "");
    expect(line("turn", { phase: "start", sessionId: "s", prompt: "make it Bandung", messageId: "m2", editOf: "m2" })).toEndWith("start: make it Bandung (edited)");
    expect(line("turn", { phase: "start", sessionId: "s", prompt: "what time is it?" })).toEndWith("start: what time is it?");
    expect(line("steer", { step: 3, text: "✎ deploy to staging", editOf: "m1" })).toEndWith("nouva deploy to staging (edited)");
    expect(line("steer", { step: 3, text: "also check the logs" })).toEndWith("nouva also check the logs");
  });

  test("a tool call, its result and its audit row are printed with the call they pair by", () => {
    const at = 0;
    const line = (kind: string, data: Record<string, unknown>) => eventLine({ seq: 1, at, turnId: "t", agentId: "nouva", gatewayId: null, chatId: null, kind, data }).replace(/\x1b\[[0-9;]*m/g, "");
    expect(line("tool", { step: 1, text: "exec ls", callId: "call_7", name: "exec" })).toEndWith("exec ls call_7");
    expect(line("audit", { callId: "call_7", tool: "exec", args: { command: "ls" }, threw: "boom", ms: 1 })).toEndWith('exec {"command":"ls"} (failed) call_7');
  });
});
