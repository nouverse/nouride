/**
 * `nouride chat` on the event stream (0.7.11), and what it needed from it.
 *
 * Its progress was a poll of `/activity`, an in-memory window of sixty lines per chat with a counter of its own. Now:
 * - `thinking` — a model call under way — is a frame of the stream (1.2) to a reader that asks for frames, in order with
 *   the rows and kept nowhere, and only to whoever follows that turn's conversation;
 * - the chat follows its own conversation, draws a helper's and a peer's lines, and settles its turns before it prints
 *   their answer;
 * - `/activity`, kept through 0.7.x for a 0.7.10 CLI pointed at a newer daemon, is gone: 0.8.0 upgrades only from
 *   0.7.28, whose CLI follows the stream.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { parseSse } from "@nouride/shared";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { TurnRecorder, stepsInto } from "@/modules/turns/recorder.ts";
import { followChat, type FollowedLine } from "@/cli/chat-follow.ts";
import { eventually, sleep } from "../wait.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let events: EventStore;
let turns: EventedTurnStore;
let app: Hono;

type Frame = { event?: string; data: Record<string, unknown> };
/** The streams the test read, cancelled after it: one left open keeps its keep-alive ticking into the next tests. */
const readers: { cancel(): Promise<void> }[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-thinking-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  events = new EventStore(db, Date.now, { strict: true });
  turns = new EventedTurnStore(db, events);
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    events,
    local: { id: "web:dashboard" },
  } as unknown as ControlDeps);
});
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
  db.close();
  removePath(dir);
});

const get = (path: string) => app.request(`/api/control${path}`, { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });
const begin = (chatId: string, gatewayId = "web:dashboard") => TurnRecorder.begin(turns, { sessionId: "s", agentId: "nouva", gatewayId, chatId, prompt: "check it" })!;

/** A reader of the stream at `path`: every frame it has had so far, as each arrives, until the test ends. */
async function reading(path: string): Promise<Frame[]> {
  const got: Frame[] = [];
  const reader = (await get(path)).body!.getReader();
  readers.push(reader);
  // Through a stream of its own, which cancelling the reader ends: the parser holds what it reads locked.
  const source = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
  void (async () => {
    for await (const frame of parseSse(source)) got.push({ ...(frame.event ? { event: frame.event } : {}), data: JSON.parse(frame.data) as Record<string, unknown> });
  })().catch(() => {});
  return got;
}

/**
 * Until a turn of the reader's own conversation has reached it: then it is past its replay, and a frame for it is sent —
 * a frame is now or never, and not while the past is replayed.
 */
const live = (got: Frame[]) => eventually(() => got.some((frame) => frame.data.kind === "turn"), 2_000, "a turn of the reader's conversation");

describe("the `thinking` frame", () => {
  test("reaches a reader of that conversation that asked for frames, in order with the rows, and is written nowhere", async () => {
    const got = await reading("/events/stream?chat=c1&gateway=web:dashboard&tail=1&frames=1");
    const record = begin("c1");
    await live(got);
    record.step("thinking", "thinking");
    record.step("tool", "exec ls", { callId: "a", name: "exec" });
    record.step("thinking", "generating · 2 KB");
    record.step("tool_done", "exec ok · 3ms", { callId: "a", name: "exec", error: false, outcome: "ok" });
    await eventually(() => got.some((frame) => frame.data.kind === "tool_done"), 2_000, "the call's result");
    const read = got.filter((frame) => frame.event !== "hello");
    expect(read.map((frame) => frame.event ?? frame.data.kind)).toEqual(["turn", "thinking", "tool", "thinking", "tool_done"]);
    expect(read[3]).toEqual({ event: "thinking", data: { turnId: record.id, text: "generating · 2 KB" } });
    expect(events.list({ limit: 100 }).map((row) => row.kind)).toEqual(["turn", "tool", "tool_done"]);
  });

  test("a helper's says whose it is", async () => {
    const got = await reading("/events/stream?chat=c1&gateway=web:dashboard&tail=1&frames=1");
    const record = begin("c1");
    await live(got);
    stepsInto(turns, record.id, { via: "delegate", by: "nouva" })!("thinking", "thinking");
    await eventually(() => got.some((frame) => frame.event === "thinking"), 2_000, "the helper's thinking");
    expect(got.find((frame) => frame.event === "thinking")?.data.text).toBe("↳ thinking");
  });

  test("not to a reader of another conversation, nor to one that did not ask for frames", async () => {
    const other = await reading("/events/stream?chat=c2&gateway=web:dashboard&tail=1&frames=1");
    const elsewhere = await reading("/events/stream?chat=c1&gateway=telegram:main&tail=1&frames=1");
    const plain = await reading("/events/stream?chat=c1&gateway=web:dashboard&tail=1");
    const mine = begin("c1");
    const theirs = begin("c2");
    const away = begin("c1", "telegram:main");
    for (const got of [other, elsewhere, plain]) await live(got);
    mine.step("thinking", "thinking");
    // Then a row each of them is sent. The stream is in order, so a frame sent to one would be in before that row.
    mine.step("tool", "exec ls", { callId: "a", name: "exec" });
    theirs.step("tool", "exec ls", { callId: "b", name: "exec" });
    away.step("tool", "exec ls", { callId: "c", name: "exec" });
    for (const got of [other, elsewhere, plain]) await eventually(() => got.some((frame) => frame.data.kind === "tool"), 2_000, "the row after the frame");
    for (const got of [other, elsewhere, plain]) expect(got.some((frame) => frame.event === "thinking")).toBe(false);
    // Nor a row of a conversation it does not follow.
    expect(other.filter((frame) => !frame.event).map((frame) => frame.data.chatId)).toEqual(["c2", "c2"]);
    expect(elsewhere.filter((frame) => !frame.event).map((frame) => frame.data.gatewayId)).toEqual(["telegram:main", "telegram:main"]);
  });
});

describe("`/activity`, the 0.7.10 CLI's poll", () => {
  test("is gone: a conversation with steps on the stream is not answered there", async () => {
    begin("cli-1").step("tool", "exec ls", { callId: "a", name: "exec" });
    expect((await get("/activity?chat=cli-1&since=0")).status).toBe(404);
  });
});

describe("`nouride chat`'s follower", () => {
  /** A stream the test writes frames into, and a follower reading it while `drawing`. */
  function follower(options: { refuse?: number } = {}) {
    const drawn: FollowedLine[] = [];
    const notices: string[] = [];
    let push: (text: string) => void = () => {};
    const opened: string[] = [];
    let seq = 0;
    const encoder = new TextEncoder();
    const follow = followChat({
      open: async (path) => {
        opened.push(path);
        if (options.refuse) throw Object.assign(new Error("refused"), { status: options.refuse });
        return new ReadableStream<Uint8Array>({ start: (controller) => void (push = (text) => controller.enqueue(encoder.encode(text))) });
      },
      gatewayId: "web:dashboard",
      chatId: "cli-1",
      draw: (line) => void drawn.push(line),
      drawing: () => true,
      notice: (line) => void notices.push(line),
      sleep: () => new Promise(() => {}),
    });
    const row = (turnId: string, kind: string, data: Record<string, unknown>) => push(`id: ${++seq}\ndata: ${JSON.stringify({ seq, at: 1, turnId, agentId: "nouva", gatewayId: "web:dashboard", chatId: "cli-1", kind, data })}\n\n`);
    const frame = (event: string, data: Record<string, unknown>) => push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return { follow, drawn, notices, opened, row, frame };
  }

  test("draws the turn's steps — a helper's and a peer's marked — and its thinking, and settles once the turn ends", async () => {
    const f = follower();
    await eventually(() => f.opened.length === 1, 2_000, "the stream opened");
    f.row("t1", "turn", { phase: "start", prompt: "hi" });
    f.frame("thinking", { turnId: "t1", text: "thinking" });
    f.row("t1", "tool", { step: 1, text: "delegate 1 task", callId: "a", name: "delegate" });
    f.row("t1", "tool", { step: 2, text: "↳ exec ls", callId: "b", name: "exec", via: "delegate", by: "nouva" });
    f.row("t1", "tool", { step: 3, text: "[nox] exec df", callId: "c", name: "exec", via: "ask_agent", by: "nox" });
    f.row("t1", "usage", { model: "m", provider: "p", inputTokens: 1, outputTokens: 1 });
    await eventually(() => f.drawn.length === 4, 2_000, "the turn's lines drawn");
    const settled = f.follow.settle();
    let done = false;
    void settled.then(() => (done = true));
    // Time is the point here: `settle` looks every 20 ms, and outwaiting a few looks is what shows it holds for the end.
    await sleep(60);
    expect(done).toBe(false);
    f.row("t1", "turn", { phase: "end", status: "done" });
    await settled;
    expect(f.drawn).toEqual([
      { kind: "thinking", text: "thinking" },
      { kind: "tool", text: "delegate 1 task" },
      { kind: "tool", text: "↳ exec ls" },
      { kind: "tool", text: "[nox] exec df" },
    ]);
    f.follow.stop();
  });

  test("a delegate's own turn in the chat (1.4) is neither waited on nor drawn — the conversation's turn is", async () => {
    const f = follower();
    await eventually(() => f.opened.length === 1, 2_000, "the stream opened");
    // A helper working in the background, its turn of its own still running…
    f.row("h1", "turn", { phase: "start", prompt: "GOAL\nFind every broken link", via: "delegate", by: "nouva" });
    f.row("h1", "tool", { step: 1, text: "probe /srv/docs", callId: "x", name: "probe" });
    // …while the person's next message is answered.
    f.row("t2", "turn", { phase: "start", prompt: "jam berapa?" });
    f.row("t2", "tool", { step: 1, text: "exec date", callId: "a", name: "exec" });
    f.row("t2", "turn", { phase: "end", status: "done" });
    await f.follow.settle();
    expect(f.drawn).toEqual([{ kind: "tool", text: "exec date" }]);
    f.follow.stop();
  });

  test("a stream the daemon refuses is said once, and not asked again", async () => {
    const f = follower({ refuse: 501 });
    await eventually(() => f.notices.length > 0, 2_000, "the refusal said");
    expect(f.opened).toHaveLength(1);
    expect(f.notices).toEqual([expect.stringContaining("no progress feed")]);
    f.follow.stop();
  });
});
