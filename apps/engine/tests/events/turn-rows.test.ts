/**
 * A turn's rows add up to the turn (`turn-events.store.ts`, `turns/recorder.ts`): the answer's rows are the answer —
 * its tail included, a long chunk whole — every turn ends in the stream, a restart's too, and text cut before the size
 * bound says it was. And the stream's writers are held to the contract as they write (`EventStore`'s `strict`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { EventStore, type EventInput, type EventRow } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { TurnRecorder } from "@/modules/turns/recorder.ts";
import { eventually } from "../wait.ts";
import { toolOutcome } from "@/commons/activity.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const WHERE = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
const SESSION = "ses_nouva:web:dashboard:web-1";
let dir = "";
let db: SqliteDb;
let events: EventStore;
let turns: EventedTurnStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-turn-rows-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  events = new EventStore(db, Date.now, { strict: true });
  turns = new EventedTurnStore(db, events);
});
afterEach(() => {
  db.close();
  removePath(dir);
});

/** The answer as a reader of the stream puts it together: each row spliced in at its `from`. */
const answerOf = (rows: EventRow[]) =>
  rows.filter((row) => row.kind === "reply").reduce((text, row) => text.slice(0, row.data.from as number) + (row.data.text as string), "");

describe("the answer's rows", () => {
  test("add up to what was streamed — the tail written after the last flush included", () => {
    const recorder = TurnRecorder.begin(turns, { sessionId: SESSION, ...WHERE, prompt: "hi" })!;
    // Under a flush's worth of characters and time: before, these never reached the stream.
    recorder.delta("Hello ");
    recorder.delta("there.");
    recorder.finish({ status: "done", reply: "Hello there." });
    const rows = events.list({});
    expect(answerOf(rows)).toBe("Hello there.");
  });

  test("text held by the throttle is written when the interval is up, though nothing more comes (0.8.1)", async () => {
    // A coding CLI said a line and then worked for a minute in silence: the line's first letter, flushed alone, was all
    // the dashboard showed the whole while — "NIX / L" on the live box.
    const recorder = TurnRecorder.begin(turns, { sessionId: SESSION, ...WHERE, prompt: "audit" }, { chars: 1_000, ms: 40 })!;
    recorder.delta("L");
    recorder.delta("agi bongkar source Nouride.");
    expect(answerOf(events.list({}))).toBe("L");
    await eventually(() => answerOf(events.list({})) === "Lagi bongkar source Nouride.", 2_000, "the held text written");
    recorder.finish({ status: "done", reply: "Lagi bongkar source Nouride." });
  });

  test("a chunk larger than a row is split across rows, each with its own offset — none cut", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "write a lot" });
    const long = Array.from({ length: 10_000 }, (_, n) => String.fromCharCode(97 + (n % 26))).join("");
    turns.setReply(id, long);
    const replies = events.list({ kinds: ["reply"] });
    expect(replies.length).toBe(5);
    expect(replies.map((row) => row.data.from)).toEqual([0, 2_000, 4_000, 6_000, 8_000]);
    expect(replies.every((row) => row.data.truncated === undefined)).toBe(true);
    expect(answerOf(replies)).toBe(long);
  });
});

describe("every turn ends in the stream", () => {
  test("one a restart cut off ends as it does in its record: interrupted", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "a long job" });
    const done = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "a short one" });
    turns.finish(done, { status: "done", reply: "ok" });
    turns.interruptOrphaned();
    const ends = events.list({ kinds: ["turn"] }).filter((row) => row.data.phase === "end");
    expect(ends.map((row) => [row.turnId, row.data.status])).toEqual([
      [done, "done"],
      [id, "interrupted"],
    ]);
    expect(ends[1]).toMatchObject({ agentId: "nouva", chatId: "web-1" });
  });
});

describe("text cut before the size bound", () => {
  test("a step's text and a prompt say they were cut; a command's answer carries its whole length", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "p".repeat(2_500) });
    turns.step(id, "note", "n".repeat(2_500));
    turns.note({ sessionId: SESSION, ...WHERE, prompt: "/status", reply: "r".repeat(5_000) });
    const [start, step, note] = events.list({});
    expect(start?.data).toMatchObject({ truncated: true, cut: ["prompt"] });
    expect((start?.data.prompt as string).length).toBe(2_000);
    expect(step?.data).toMatchObject({ truncated: true, cut: ["text"] });
    expect(note?.data).toMatchObject({ phase: "note", replyChars: 5_000 });
    expect((note?.data.reply as string).length).toBe(4_000);
  });

  test("and text that fits says nothing of the kind", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "short" });
    turns.step(id, "note", "fine");
    expect(events.list({}).every((row) => row.data.truncated === undefined)).toBe(true);
  });
});

describe("the writers, held to the contract", () => {
  const drifted = { kind: "turn", turnId: "t", data: { phase: 1 } } as unknown as EventInput;

  test("a strict store refuses a row the contract does not describe — so a writer that drifts fails its tests", () => {
    expect(() => events.append(drifted)).toThrow(/turn\.phase is number, not string/);
  });

  test("in production the row is written, and each problem said once at warn", () => {
    const relaxed = new EventStore(db);
    const said: LogEntry[] = [];
    addLogSink((entry) => void (entry.message.includes("contract does not describe") && said.push(entry)));
    expect(relaxed.append(drifted)).toBeGreaterThan(0);
    relaxed.append(drifted);
    expect(said.map((entry) => entry.data?.problem)).toEqual(["turn.phase is number, not string"]);
  });
});

describe("the newest page", () => {
  test("`newest=1` answers the last rows there are, still oldest first — what a bare `nouride events` shows", async () => {
    for (let n = 1; n <= 5; n += 1) events.append({ kind: "note", turnId: "t", data: { step: n, text: `n${n}` } });
    const app = new Hono();
    mountControlRoutes(app, {
      ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
      token: "control-token-for-tests-0000000000",
      audit: new AuditLog(db),
      users: new UserStore({ db }),
      files: {},
      events,
    } as unknown as ControlDeps);
    const page = (await (
      await app.request("/api/control/events?newest=1&limit=2", { headers: { "x-nouride-token": "control-token-for-tests-0000000000" } }, { clientAddress: "203.0.113.10" })
    ).json()) as { events: EventRow[]; next: number };
    expect(page.events.map((row) => row.seq)).toEqual([4, 5]);
    expect(page.next).toBe(5);
  });
});

describe("a call's steps, read back", () => {
  test("carry what a reader pairs them by and reads a result off — the call, the tool, how it ended", () => {
    const id = turns.begin({ sessionId: SESSION, ...WHERE, prompt: "look" });
    turns.step(id, "tool", "exec which chromium", { callId: "call_9", name: "exec" });
    turns.step(id, "tool_done", "exec exit 1 · 3ms", { callId: "call_9", name: "exec", error: true, outcome: "exit" });
    expect(turns.stepsSince(id).map(({ kind, callId, name, error, outcome }) => ({ kind, callId, name, error, outcome }))).toEqual([
      { kind: "tool", callId: "call_9", name: "exec", error: undefined, outcome: undefined },
      { kind: "tool_done", callId: "call_9", name: "exec", error: true, outcome: "exit" },
    ]);
  });

  test("how a call ended, from its result: a non-zero exit is an answer, a timeout or a kill is not the call doing its job", () => {
    expect(toolOutcome({ isError: false })).toBe("ok");
    expect(toolOutcome({ isError: true, metadata: { exitCode: 1 } })).toBe("exit");
    expect(toolOutcome({ isError: true, metadata: { exitCode: 143, timedOut: true } })).toBe("timed_out");
    expect(toolOutcome({ isError: true, metadata: { exitCode: 137, aborted: true } })).toBe("killed");
    expect(toolOutcome({ isError: true })).toBe("failed");
  });
});
