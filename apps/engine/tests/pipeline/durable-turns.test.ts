/**
 * Durable turns.
 *
 * The claim is that nothing a turn did is lost to however it ends, and that nothing it did runs again.
 * Pinned from three sides:
 *
 * - **Every boundary, without killing anything.** The journal is append-only, so a crash after the k-th
 *   commit leaves exactly its first k rows. Closing every prefix of a scripted turn's journal is the
 *   crash at every boundary, and each result has to be a conversation a provider accepts.
 * - **Real turns** that end early — a provider failing after a tool ran, a shutdown arriving mid-turn —
 *   with a tool that counts its own runs.
 * - **The boot** closing a journal a dead process left behind.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { ChatMessage, Gateway, MessageEnvelope, Tool } from "@nouride/shared";
import { durableStores, recoverTurns, resumeAfterBoot } from "@/boot/durable.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { deliverUndelivered } from "@/boot/delivery.ts";
import { openAndMigrate } from "@/db/index.ts";
import { parseConfig } from "@/modules/config/global/index.ts";
import { Pipeline } from "@/modules/pipeline/index.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { closeTurn, interruptionReport } from "@/modules/turns/close.ts";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { TurnJournalStore, type JournalEntry } from "@/modules/turns/journal.store.ts";
import { TurnStore } from "@/modules/turns/turns.store.ts";
import { DeliveryStore } from "@/modules/turns/delivery.store.ts";
import { InboxStore, inboxIds } from "@/modules/pipeline/inbox.store.ts";
import { InboxDesk } from "@/modules/pipeline/inbox-desk.ts";
import { Batcher } from "@/modules/pipeline/batcher.ts";
import { mergeEnvelopes } from "@/modules/pipeline/messages.ts";
import { RESTARTING } from "@/modules/pipeline/turn-context.ts";
import { envelope, FakeGateway, scriptedOpenAI, tempDir, turnStore } from "../helpers.ts";
import { sleep } from "../wait.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
const QUESTION: ChatMessage = { role: "user", content: "deploy the site", timestamp: 1 };

/**
 * A turn with every shape a round can take: two reads run together, a build that fails, a write after
 * it, a picture a tool opened, and the answer.
 */
const SCRIPTED: JournalEntry[] = [
  { message: QUESTION },
  { message: { role: "assistant", content: "", toolCalls: [call("r1", "read", { path: "site.toml" }), call("r2", "grep", { pattern: "deploy" })] } },
  { started: ["r1", "r2"] },
  { message: { role: "tool", toolCallId: "r1", content: "[site] name = x" } },
  { message: { role: "tool", toolCallId: "r2", content: "deploy.sh:1" } },
  { message: { role: "assistant", content: "building", toolCalls: [call("e1", "exec", { command: "./build.sh" }), call("w1", "write", { path: "out.txt" })] } },
  { started: ["e1"] },
  { message: { role: "tool", toolCallId: "e1", content: "exit 1: missing key" } },
  { started: ["w1"] },
  { message: { role: "tool", toolCallId: "w1", content: "wrote out.txt" } },
  { message: { role: "user", content: [{ type: "text", text: "[harness] The file(s) you opened are below, as pictures." }] } },
  { message: { role: "assistant", content: "The build failed on a missing key; I wrote the log to out.txt." } },
];

/** What every closed turn must satisfy for a provider to accept it — and for nothing to be lost. */
function expectWellFormed(messages: ChatMessage[], prefix: readonly JournalEntry[]): void {
  expect(messages[0]).toEqual(QUESTION);
  const last = messages.at(-1)!;
  expect(last.role).toBe("assistant");
  expect(last.toolCalls ?? []).toHaveLength(0);

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "tool") {
      // A result answers a call of the assistant message before it, and nothing else.
      const asker = messages.slice(0, i).findLast((m) => m.role === "assistant");
      expect(asker?.toolCalls?.some((c) => c.id === message.toolCallId)).toBe(true);
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const results: string[] = [];
    for (let j = i + 1; j < messages.length && messages[j]!.role !== "assistant"; j += 1) {
      if (messages[j]!.role === "tool") results.push(messages[j]!.toolCallId!);
    }
    // Every call, exactly one result.
    expect(results.toSorted()).toEqual(message.toolCalls.map((c) => c.id).toSorted());
  }
  // Every real result the prefix committed is still there, word for word.
  for (const entry of prefix) {
    if ("message" in entry && entry.message.role === "tool") expect(messages).toContainEqual(entry.message);
  }
}

describe("closing a turn, at every boundary", () => {
  test("every prefix of the journal closes into a conversation a provider accepts", () => {
    for (let k = 1; k <= SCRIPTED.length; k += 1) {
      const prefix = SCRIPTED.slice(0, k);
      const closed = closeTurn(prefix, { kind: "restart" });
      expectWellFormed(closed.messages, prefix);
    }
  });

  test("a call cut off while it ran is told apart from one that never started", () => {
    // The crash lands after the build was started and before it returned: the write never began.
    const closed = closeTurn(SCRIPTED.slice(0, 7), { kind: "restart" });
    expect(closed.done).toEqual(["read site.toml", "grep deploy"]);
    expect(closed.cut).toEqual(["exec ./build.sh"]);
    expect(closed.notStarted).toEqual(["write out.txt"]);
    const results = closed.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results.at(-2)).toContain("may have partly run");
    expect(results.at(-1)).toContain("Nothing happened");
    expect(String(closed.messages.at(-1)!.content)).toContain("asked to continue, I pick up from there");
  });

  test("a journal that already holds the answer is a turn that finished: nothing to close", () => {
    const closed = closeTurn(SCRIPTED, { kind: "restart" });
    expect(closed.answer).toBe("The build failed on a missing key; I wrote the log to out.txt.");
    expect(closed.messages.at(-1)!.content).toBe(closed.answer!);
  });

  test("the report says what finished and what was cut off, in the person's own words", () => {
    const closed = closeTurn(SCRIPTED.slice(0, 7), { kind: "restart" });
    const report = interruptionReport(closed, "deploy the site");
    expect(report).toContain('while working on "deploy the site"');
    expect(report).toContain("Done: `read site.toml`, `grep deploy`.");
    expect(report).toContain("Cut off: `exec ./build.sh` (it may have partly run).");
    expect(report).toContain('say "continue"');
  });

  test("/stop keeps the words it always left", () => {
    const closed = closeTurn([{ message: QUESTION }], { kind: "stopped" });
    expect(closed.messages).toHaveLength(2);
    expect(String(closed.messages[1]!.content)).toBe("[harness] They stopped me here, before I answered. The request above still stands unless they say otherwise.");
  });
});

// ── Real turns ───────────────────────────────────────────────────────────────

interface Rig {
  db: SqliteDb;
  inbox: InboxStore;
  /** What the daemon said in its own voice — the stale-message notice. */
  notices: string[];
  pipeline: Pipeline;
  gateway: FakeGateway;
  sessions: SessionStore;
  turns: TurnStore;
  journal: TurnJournalStore;
  requests: unknown[];
  /** How many times the tool ran — never more than the model asked. */
  runs: () => number;
  /** What the journal held each time the tool started. */
  seenAtStart: JournalEntry[][];
  history: () => ChatMessage[];
}

async function rig(options: {
  turns: Parameters<typeof scriptedOpenAI>[0];
  /** Answer the n-th provider request and every one after it with this error. */
  failFrom?: number;
  /** Called inside the tool, before it returns. */
  duringTool?: (pipeline: Pipeline) => void;
  agentToml?: string;
  /** Where the files that come with a message are kept — a turn with none configured does not download them. */
  attachments?: boolean;
  /** `[daemon] timezone`, as the file says it. */
  timezone?: string;
}): Promise<Rig> {
  const notices: string[] = [];
  const notifier = {
    toChat: async (_target: unknown, text: string) => {
      notices.push(text);
      return true;
    },
    alert: async () => true,
    isOwnerChat: () => false,
  } as unknown as ConstructorParameters<typeof Pipeline>[0]["notifier"];
  let n = 0;
  const bench = await pipelineBench({
    turns: options.turns,
    agentToml: options.agentToml ?? '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\n',
    fetch: (scripted) =>
      (async (...args: Parameters<typeof fetch>) => {
        n += 1;
        if (options.failFrom !== undefined && n >= options.failFrom) {
          return new Response(JSON.stringify({ error: { message: "invalid request" } }), { status: 400, headers: { "content-type": "application/json" } });
        }
        return scripted(...args);
      }) as unknown as typeof fetch,
    configure: (config) => {
      if (options.timezone) config.daemon.timezone = options.timezone;
    },
    deps: ({ dataDir }) => ({
      notifier,
      ...(options.attachments ? { attachments: new AttachmentStore({ rootDir: join(dataDir, "attachments"), maxBytes: 1_000_000 }) } : {}),
    }),
  });
  cleanup.push(bench.dispose);
  const { db, pipeline, gateway, sessions, turns, journal, inbox, requests } = bench;

  let runs = 0;
  const seenAtStart: JournalEntry[][] = [];
  const probe: Tool = {
    requiresApproval: false,
    definition: { name: "probe", description: "checks a thing", parameters: { type: "object", properties: {} } },
    async execute() {
      runs += 1;
      seenAtStart.push(journal.unsettled()[0]?.entries ?? []);
      options.duringTool?.(pipeline);
      return { content: `probe ${runs} ok`, isError: false };
    },
  };
  pipeline.setTools(new Map([["probe", probe]]));
  pipeline.attach();

  return {
    db,
    inbox,
    notices,
    pipeline,
    gateway,
    sessions,
    turns,
    journal,
    requests,
    runs: () => runs,
    seenAtStart,
    history: () => sessions.load({ agentId: "nouva", chatId: "chat-1", gatewayId: gateway.id }).messages,
  };
}

async function ask(r: Rig, text: string, id = `m-${Math.random()}`): Promise<void> {
  r.gateway.receive(envelope({ id, chatType: "dm", chatId: "chat-1", text, timestamp: Date.now() }));
  await r.pipeline.idle();
}

const statusOf = (r: Rig, messageId: string) =>
  r.db.prepare<{ status: string; reason: string | null }>("SELECT status, reason FROM inbox WHERE id = ?").get(`${r.gateway.id}:chat-1:${messageId}`);


describe("a turn that ends early keeps what it did", () => {
  test("the model's call is committed before the tool runs", async () => {
    const r = await rig({ turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "all good" }] });
    await ask(r, "check it");
    const atStart = r.seenAtStart[0]!;
    // The question, the assistant message naming the call, and the call marked as started — all before it ran.
    expect(atStart.some((e) => "message" in e && e.message.role === "assistant" && e.message.toolCalls?.[0]?.id === "c1")).toBe(true);
    expect(atStart.some((e) => "started" in e && e.started.includes("c1"))).toBe(true);
    // Settled: the conversation holds the turn, and the journal is gone in the same transaction.
    expect(r.journal.count()).toBe(0);
    expect(r.history().at(-1)?.content).toBe("all good");
  });

  test("a provider failing after a tool ran: the result is kept, the tool is not run again", async () => {
    const r = await rig({ turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }], failFrom: 2 });
    await ask(r, "check it");

    expect(r.runs()).toBe(1);
    const history = r.history();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(history[2]!.content).toBe("probe 1 ok");
    expect(String(history[3]!.content)).toContain("What I did so far is above");
    expect(r.journal.count()).toBe(0);
    expect(r.gateway.sent.at(-1)?.text).toContain('What I did so far is kept: say "continue"');
  });

  test("a shutdown mid-turn stops it at the next step boundary, closes it, and says what it did", async () => {
    const r = await rig({
      turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "never asked for" }],
      duringTool: (pipeline) => pipeline.pause(),
    });
    await ask(r, "check it");

    // No model call after the pause: the boundary is where it stopped.
    expect(r.requests).toHaveLength(1);
    const history = r.history();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(String(history[3]!.content)).toContain("interrupted here by a restart");
    expect(r.journal.count()).toBe(0);
    const sent = r.gateway.sent.at(-1)?.text ?? "";
    expect(sent).toContain("I was interrupted by a restart");
    expect(sent).toContain("Done: `probe`.");
    // Tracked like an answer, so a report that never landed would be sent after the restart.
    const row = r.db.prepare<{ status: string; delivered_at: number | null }>("SELECT status, delivered_at FROM turn_records").get();
    expect(row).toMatchObject({ status: "interrupted" });
    expect(row?.delivered_at).toBeGreaterThan(0);
  });

  test("a shutdown that has to abort a running call closes the turn as a restart, the call cut off", async () => {
    // Found on the box: a call longer than the shutdown's wait was aborted, and the turn answered as one
    // that ran out of time — no report, no note, and the kill kept as though it were the call's result.
    const r = await rig({
      turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "never asked for" }],
      duringTool: (pipeline) => {
        pipeline.pause();
        for (const turn of pipeline.runningTurns()) turn.controller.abort(RESTARTING);
      },
    });
    await ask(r, "check it");

    expect(r.requests).toHaveLength(1);
    expect(r.runs()).toBe(1);
    const history = r.history();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(String(history[2]!.content)).toContain("Cut off by a restart");
    expect(String(history[2]!.content)).not.toContain("probe 1 ok");
    const sent = r.gateway.sent.at(-1)?.text ?? "";
    expect(sent).toContain("I was interrupted by a restart");
    expect(sent).toContain("Cut off: `probe`");
    expect(r.db.prepare<{ status: string }>("SELECT status FROM turn_records").get()?.status).toBe("interrupted");
  });

  test("a journal write lost mid-turn: the live close does not say a call it cannot see start did nothing (P8)", async () => {
    const r = await rig({
      turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "never asked for" }],
      duringTool: (pipeline) => {
        pipeline.pause();
        for (const turn of pipeline.runningTurns()) turn.controller.abort(RESTARTING);
      },
    });
    r.db.exec(`CREATE TRIGGER lose_a_row BEFORE INSERT ON turn_journal WHEN NEW.entry LIKE '%"started":["c1"]%' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    await ask(r, "check it");

    expect(r.runs()).toBe(1);
    expect(String(r.history()[2]!.content)).toContain("Cut off by a restart");
    const sent = r.gateway.sent.at(-1)?.text ?? "";
    expect(sent).toContain("Cut off: `probe`");
    expect(sent).not.toContain("Not started");
    expect(sent).toContain("Part of what I did could not be recorded");
  });

  test("a wrap-up's answer is kept in the conversation", async () => {
    // The iteration cap (5, the floor) reached with work still asked for: the wrap-up writes the answer.
    const r = await rig({
      agentToml: '[llm]\nprovider = "test"\nmax_tool_iterations = 5\n\n[tools]\nenabled = ["probe"]\n',
      turns: [
        ...Array.from({ length: 5 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: "probe", args: {} }] })),
        { text: "Checked five times; it is fine." },
      ],
    });
    await ask(r, "check it until sure");
    expect(r.history().at(-1)).toMatchObject({ role: "assistant", content: "Checked five times; it is fine." });
    expect(r.gateway.sent.at(-1)?.text).toBe("Checked five times; it is fine.");
  });
});

// ── The inbox ────────────────────────────────────────────────────────────────

describe("a crash while the files that came with a message download (P6)", () => {
  test("leaves a journal with the question, closed at the next boot and taken up again, never told it is gone", async () => {
    const r = await rig({ turns: [{ text: "A photo of a cat." }], attachments: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // A download that takes its time — the thirty seconds a file may.
    (r.gateway as Gateway).fetchAttachment = async () => {
      await held;
      return new Uint8Array([1]);
    };
    r.gateway.receive(envelope({ id: "m-photo", chatType: "dm", chatId: "chat-1", text: "what is this?", attachments: [{ type: "image", mimeType: "image/png", filename: "photo.png", url: "https://files.test/photo.png" }], timestamp: Date.now() }));
    // A photo waits out the media batch window first, then its turn starts downloading.
    for (let waited = 0; r.journal.unsettled().length === 0 && waited < 5_000; waited += 25) await sleep(25);

    // What the power going now would leave: the journal is open, with the words and what was still arriving.
    const [left] = r.journal.unsettled();
    expect(left?.entries).toHaveLength(1);
    const asked = String((left!.entries[0] as { message: ChatMessage }).message.content);
    expect(asked).toStartWith("what is this?");
    expect(asked).toContain("still arriving when this was written: photo.png");

    // The next boot, on what was left behind.
    const recovered = recoverTurns({ journal: r.journal, sessions: r.sessions, turns: r.turns, atomically: (w) => r.db.transaction(w), maxTurns: 200 });
    expect(recovered[0]?.report).toContain('I was interrupted by a restart before I could answer "what is this?"');
    expect(r.turns.interruptOrphaned().conversations).toEqual([]);
    expect(r.sessions.load({ agentId: "nouva", chatId: "chat-1", gatewayId: r.gateway.id }).messages[0]?.content).toBe(asked);

    release();
    await r.pipeline.idle();
  });

  test("once the files are in, the journal holds the question as composed", async () => {
    const r = await rig({ turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "A cat." }], attachments: true });
    (r.gateway as Gateway).fetchAttachment = async () => new Uint8Array([1, 2, 3]);
    r.gateway.receive(envelope({ id: "m-doc", chatType: "dm", chatId: "chat-1", text: "read this", attachments: [{ type: "file", mimeType: "text/plain", filename: "notes.txt", url: "https://files.test/notes.txt" }], timestamp: Date.now() }));
    for (let waited = 0; r.runs() === 0 && waited < 5_000; waited += 25) await sleep(25);
    await r.pipeline.idle();

    // What the journal held when the tool ran: the question the model was asked, not the one it was opened with.
    const question = JSON.stringify((r.seenAtStart[0]![0] as { message: ChatMessage }).message.content);
    expect(question).toContain("notes.txt");
    expect(question).not.toContain("still arriving");
  });

  test("a turn left without a journal is told it is gone, unless it is taken up again", async () => {
    const r = await rig({ turns: [] });
    const recent = r.turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: r.gateway.id, chatId: "chat-1", prompt: "check the backups" });
    const old = r.turns.begin({ sessionId: "ses_y", agentId: "nouva", gatewayId: r.gateway.id, chatId: "chat-2", prompt: "an hour ago" });
    r.db.prepare("UPDATE turn_records SET started_at = ? WHERE id = ?").run(Date.now() - 3 * 3_600_000, old);
    const orphaned = r.turns.interruptOrphaned().conversations;

    const told: string[] = [];
    const resumed: string[] = [];
    const pipeline = {
      inbox: { reopen: () => ({ redelivered: 0, stale: 0, interrupted: 0 }) },
      resumeTurn: (turn: { id: string }) => (resumed.push(turn.id), true),
    } as unknown as Parameters<typeof resumeAfterBoot>[0]["pipeline"];
    const notifier = { toChat: async (target: { chatId: string }) => (told.push(target.chatId), true) };
    const durable = durableStores(r.db, new EventStore(r.db));
    await resumeAfterBoot({ recovered: [], orphaned, stores: durable, startedAt: Date.now(), pipeline, turns: r.turns, notifier, chatEvents: { record: () => null } });
    await sleep(10);

    expect(resumed).toEqual([recent]);
    expect(told).toEqual(["chat-2"]);
  });
});

describe("a message is written down before anything acts on it", () => {
  test("arriving twice — a redelivery a dead process never confirmed — it is answered once", async () => {
    const r = await rig({ turns: [{ text: "hello again" }] });
    await ask(r, "halo", "m1");
    await ask(r, "halo", "m1");
    expect(r.requests).toHaveLength(1);
    expect(statusOf(r, "m1")).toEqual({ status: "done", reason: null });
  });

  test("sent an hour ago — a backlog after downtime — it is not answered, and its chat is told once", async () => {
    const r = await rig({ turns: [{ text: "should not run" }] });
    const hourAgo = Date.now() - 3_600_000;
    r.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "are you there?", timestamp: hourAgo }));
    r.gateway.receive(envelope({ id: "m2", chatType: "dm", chatId: "chat-1", text: "hello??", timestamp: hourAgo + 60_000 }));
    await r.pipeline.idle();
    expect(r.requests).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("I was offline when you sent your message at");
    expect(statusOf(r, "m2")).toEqual({ status: "unanswered", reason: "stale" });
  });

  test("its time is said in the one clock: a zone the runtime does not know reads as UTC, not as no notice", async () => {
    // The notice built its time with its own `Intl` call, which throws on an unknown zone where the rest of the
    // daemon falls back to UTC (`commons/clock.ts`) — so the one message saying a message was missed went unsent.
    const r = await rig({ turns: [{ text: "should not run" }], timezone: "Not/AZone" });
    const hourAgo = Date.now() - 3_600_000;
    r.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "are you there?", timestamp: hourAgo }));
    await r.pipeline.idle();
    expect(r.notices).toEqual([expect.stringContaining(`sent your message at ${new Date(hourAgo).toISOString().slice(11, 16)}`)]);
  });

  test("after a restart: a fresh waiting message is answered, a stale one is told, one a dead turn took is not answered again", async () => {
    const r = await rig({ turns: [{ text: "answered after the restart" }] });
    const now = Date.now();
    r.inbox.receive(envelope({ id: "fresh", chatType: "dm", chatId: "chat-1", text: "still there?", timestamp: now - 60_000 }), now - 60_000);
    r.inbox.receive(envelope({ id: "old", chatType: "dm", chatId: "chat-1", text: "yesterday", timestamp: now - 7_200_000 }), now - 7_200_000);
    r.inbox.receive(envelope({ id: "taken", chatType: "dm", chatId: "chat-1", text: "mid-turn", timestamp: now - 30_000 }), now - 30_000);
    r.inbox.placed([`${r.gateway.id}:chat-1:taken`]);

    const reopened = r.pipeline.inbox.reopen(r.inbox.open(), now);
    await r.pipeline.idle();

    expect(reopened).toEqual({ redelivered: 1, stale: 1, interrupted: 1 });
    expect(r.requests).toHaveLength(1);
    expect(r.gateway.sent.at(-1)?.text).toBe("answered after the restart");
    expect(statusOf(r, "fresh")?.status).toBe("done");
    expect(statusOf(r, "old")).toEqual({ status: "unanswered", reason: "stale" });
    expect(statusOf(r, "taken")).toEqual({ status: "unanswered", reason: "interrupted" });
    expect(r.notices.some((n) => n.includes("I was offline"))).toBe(true);
  });

  test("after a restart: what one person sent while their chat waited is answered once, not once a message", async () => {
    // 0.8.14 under Nix's benchmark (2026-11-02): five messages left waiting in one chat were put back one by one —
    // the batcher folds only media — and after the restart the bot answered the same question five times.
    const r = await rig({ turns: [{ text: "one answer for all of it" }, { text: "a second answer" }, { text: "a third answer" }] });
    const now = Date.now();
    for (const [n, text] of ["halo?", "halo?", "kamu di sana?"].entries()) {
      const at = now - 90_000 + n * 10_000;
      r.inbox.receive(envelope({ id: `w${n}`, chatType: "dm", chatId: "chat-1", text, timestamp: at }), at);
    }

    expect(r.pipeline.inbox.reopen(r.inbox.open(), now)).toEqual({ redelivered: 3, stale: 0, interrupted: 0 });
    await r.pipeline.idle();

    expect(r.requests).toHaveLength(1);
    expect(r.gateway.sent.map((sent) => sent.text)).toEqual(["one answer for all of it"]);
    for (const id of ["w0", "w1", "w2"]) expect(statusOf(r, id)).toEqual({ status: "done", reason: null });
    const asked = JSON.stringify(r.requests[0]);
    expect(asked).toContain("halo?");
    expect(asked).toContain("kamu di sana?");
  });

  test("two people who each left something waiting in one room are each answered, each in one message", () => {
    const pushed: MessageEnvelope[] = [];
    const desk = new InboxDesk({} as ConstructorParameters<typeof InboxDesk>[0], new Batcher((e) => pushed.push(e)));
    const now = Date.now();
    const row = (id: string, senderId: string, text: string, at: number) => ({
      id: `telegram:main:room-1:${id}`,
      gatewayId: "telegram:main",
      chatId: "room-1",
      receivedAt: at,
      sentAt: at,
      status: "queued" as const,
      envelope: envelope({ id, chatType: "group", chatId: "room-1", senderId, text, timestamp: at }),
    });

    desk.reopen([row("a1", "ana", "jadwal besok?", now - 60_000), row("b1", "budi", "cuaca?", now - 50_000), row("a2", "ana", "jam berapa?", now - 40_000)], now);

    expect(pushed.map((e) => [e.senderId, e.text, inboxIds(e)])).toEqual([
      ["ana", "jadwal besok?\n\njam berapa?", ["telegram:main:room-1:a2", "telegram:main:room-1:a1"]],
      ["budi", "cuaca?", ["telegram:main:room-1:b1"]],
    ]);
  });

  test("what this process received once the gateways were up is not read as the last one's", async () => {
    // Found on a live box: a question that arrived a second after the restart was taken, then settled as
    // interrupted by the boot's reopen while it was being answered.
    const r = await rig({ turns: [{ text: "unused" }] });
    const startedAt = Date.now() - 5_000;
    r.inbox.receive(envelope({ id: "before", chatType: "dm", chatId: "chat-1", text: "left over", timestamp: startedAt - 1_000 }), startedAt - 1_000);
    r.inbox.receive(envelope({ id: "after", chatType: "dm", chatId: "chat-1", text: "just now", timestamp: startedAt + 1_000 }), startedAt + 1_000);
    r.inbox.placed([`${r.gateway.id}:chat-1:before`, `${r.gateway.id}:chat-1:after`]);

    expect(r.inbox.open(startedAt).map((row) => row.id)).toEqual([`${r.gateway.id}:chat-1:before`]);
  });

  test("a photo put back after a restart is queued at once, ahead of what the restart set off", () => {
    // The batcher holds media for its window; the boot wakes the agents of jobs the restart killed right
    // after the reopen, and a photo still held would be answered behind them.
    const pushed: unknown[] = [];
    const desk = new InboxDesk({} as ConstructorParameters<typeof InboxDesk>[0], new Batcher((e) => pushed.push(e)));
    const now = Date.now();
    const photo = envelope({ id: "p1", attachments: [{ type: "image", mimeType: "image/jpeg", url: "file:///tmp/p1.jpg" }], timestamp: now });
    desk.reopen([{ id: "telegram:main:chat-1:p1", gatewayId: "telegram:main", chatId: "chat-1", receivedAt: now, sentAt: now, status: "queued", envelope: photo }], now);
    expect(pushed).toHaveLength(1);
  });

  test("a message too old to answer is told in its chat, and on the dashboard's timeline too", async () => {
    // The dashboard's own connection hands a notice only to a request still waiting for it.
    const events: { kind: string; text: string }[] = [];
    const told: string[] = [];
    const dataDir = tempDir("stale");
    cleanup.push(() => removePath(dataDir));
    const db = await openAndMigrate(join(dataDir, "test.db"));
    cleanup.push(() => db.close());
    const inbox = new InboxStore(db);
    const desk = new InboxDesk(
      {
        inbox,
        config: parseConfig({}),
        notifier: { toChat: async (_target: unknown, text: string) => (told.push(text), true) },
        chatEvents: { record: (event: { kind: string; text: string }) => (events.push(event), null) },
      } as unknown as ConstructorParameters<typeof InboxDesk>[0],
      new Batcher(() => {}),
    );
    const now = Date.now();
    inbox.receive(envelope({ id: "old", chatType: "dm", chatId: "chat-1", text: "yesterday", timestamp: now - 7_200_000 }), now - 7_200_000);

    expect(desk.reopen(inbox.open(now), now)).toEqual({ redelivered: 0, stale: 1, interrupted: 0 });
    expect(told).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ kind: "dropped", text: told[0] })]);
  });

  test("a chat told about a late message is remembered for the quarter hour it holds the next notice back, and no longer", () => {
    // Every chat ever told stayed in the map until a restart (`memory-growth-since-0-6`).
    const told: string[] = [];
    const desk = new InboxDesk(
      {
        inbox: { receive: () => true, settle: () => {} },
        config: parseConfig({}),
        notifier: { toChat: async (_target: unknown, text: string) => (told.push(text), true) },
      } as unknown as ConstructorParameters<typeof InboxDesk>[0],
      new Batcher(() => {}),
    );
    const remembered = () => [...(desk as unknown as { staleTold: Map<string, number> }).staleTold.keys()];
    const start = Date.now();
    try {
      setSystemTime(start);
      desk.intake(envelope({ id: "a", chatId: "chat-1", timestamp: start - 7_200_000 }));
      desk.intake(envelope({ id: "b", chatId: "chat-1", timestamp: start - 7_100_000 }));
      expect(told).toHaveLength(1);
      setSystemTime(start + 16 * 60_000);
      desk.intake(envelope({ id: "c", chatId: "chat-2", timestamp: start - 7_000_000 }));
      expect(remembered()).toEqual(["telegram:main chat-2"]);
    } finally {
      setSystemTime();
    }
  });

  test("a burst of media is recorded whole: every message it folded together settles with it", () => {
    const merged = mergeEnvelopes(envelope({ id: "p1" }), envelope({ id: "p2" }));
    expect(inboxIds(mergeEnvelopes(merged, envelope({ id: "p3" })))).toEqual(["telegram:main:chat-1:p3", "telegram:main:chat-1:p1", "telegram:main:chat-1:p2"]);
  });
});

// ── Delivery ─────────────────────────────────────────────────────────────────

describe("a reply is recorded before it is sent, and marked once it lands", () => {
  test("a reply the platform took is marked delivered", async () => {
    const r = await rig({ turns: [{ text: "here you go" }] });
    await ask(r, "hi");
    const row = r.db.prepare<{ delivered_at: number | null }>("SELECT delivered_at FROM turn_records ORDER BY started_at DESC LIMIT 1").get();
    expect(row?.delivered_at).toBeGreaterThan(0);
  });

  test("a reply the last process wrote and never got out is sent at the next boot, once", async () => {
    const dataDir = tempDir("delivery");
    cleanup.push(() => removePath(dataDir));
    const db = await openAndMigrate(join(dataDir, "test.db"));
    cleanup.push(() => db.close());
    const turns = turnStore(db);
    const delivery = new DeliveryStore(db);
    const id = turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", prompt: "hi" });
    // What the settle does: the reply committed, and owed until it lands.
    db.transaction(() => {
      turns.finish(id, { status: "done", reply: "the answer you never got" });
      delivery.awaiting(id);
    });
    const sent: string[] = [];
    const notifier = { toChat: async (_target: unknown, text: string) => (sent.push(text), true) };

    expect(await deliverUndelivered({ delivery, notifier })).toBe(1);
    expect(await deliverUndelivered({ delivery, notifier })).toBe(0);
    expect(sent).toEqual(["the answer you never got"]);
  });

  test("only a reply marked on its way is sent again — never one recorded after it was sent", async () => {
    // Found on a live box: a `/reset` answered eight minutes before a restart was sent again after it. A
    // command's answer, a refusal and what a `/stop` kept are recorded with nothing owed; a report of a turn
    // cut short is owed like an answer.
    const dataDir = tempDir("delivery");
    cleanup.push(() => removePath(dataDir));
    const db = await openAndMigrate(join(dataDir, "test.db"));
    cleanup.push(() => db.close());
    const turns = turnStore(db);
    const delivery = new DeliveryStore(db);
    const ended = (status: "interrupted" | "failed" | "cancelled", reply: string, owed: boolean) => {
      const id = turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", prompt: "hi" });
      turns.finish(id, { status, reply });
      if (owed) delivery.awaiting(id);
    };
    ended("interrupted", "I was interrupted by a restart", true);
    ended("failed", "The provider failed. What I did so far is kept", true);
    ended("failed", "The daily cost cap is reached", false);
    ended("cancelled", "What I did so far is kept", false);
    turns.note({ sessionId: "ses_x", agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", messageId: "m9", prompt: "/reset", reply: "Reset. Context cleared, config reloaded." });
    const sent: string[] = [];
    const notifier = { toChat: async (_target: unknown, text: string) => (sent.push(text), true) };

    expect(await deliverUndelivered({ delivery, notifier })).toBe(2);
    // Begun in the same millisecond, so in either order.
    expect(sent.toSorted()).toEqual(["I was interrupted by a restart", "The provider failed. What I did so far is kept"]);
  });
});

// ── The boot ─────────────────────────────────────────────────────────────────

describe("a journal a dead process left behind", () => {
  async function stores() {
    const dataDir = tempDir("boot");
    cleanup.push(() => removePath(dataDir));
    const db = await openAndMigrate(join(dataDir, "test.db"));
    cleanup.push(() => db.close());
    const events = new EventStore(db, Date.now, { strict: true });
    return { db, events, sessions: new SessionStore(db), turns: new EventedTurnStore(db, events), journal: new TurnJournalStore(db) };
  }
  const KEY = { agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" };

  test("is closed into its conversation with everything it did, and its person is told", async () => {
    const s = await stores();
    s.sessions.save(KEY, [{ role: "user", content: "earlier" }, { role: "assistant", content: "earlier answer" }], 10);
    const turnId = s.turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: KEY.gatewayId, chatId: KEY.chatId, prompt: "deploy the site" });
    const j = s.journal.open(turnId, { ...KEY, kind: "chat", startedAt: 1 }, QUESTION);
    j.record({ role: "assistant", content: "", toolCalls: [call("r1", "read", { path: "site.toml" }), call("e1", "exec", { command: "./deploy.sh" })] });
    j.started(["r1"]);
    j.record({ role: "tool", toolCallId: "r1", content: "[site]" });
    j.started(["e1"]);
    // …and the power went.

    const recovered = recoverTurns({ journal: s.journal, sessions: s.sessions, turns: s.turns, atomically: (w) => s.db.transaction(w), maxTurns: 200 });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.report).toContain("Cut off: `exec ./deploy.sh` (it may have partly run).");
    expect(recovered[0]!.report).toContain('"deploy the site"');
    const history = s.sessions.load(KEY).messages;
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "tool", "tool", "assistant"]);
    expect(history[4]!.content).toBe("[site]");
    expect(s.turns.get(turnId)?.status).toBe("interrupted");
    expect(s.journal.count()).toBe(0);
  });

  test("one with a write it lost is said to be incomplete, and no call past the hole is said not to have run (P8)", async () => {
    const s = await stores();
    // The `started` row for e1 is refused, as a full disk or a locked database would refuse it; e1 then ran.
    s.db.exec(`CREATE TRIGGER lose_a_row BEFORE INSERT ON turn_journal WHEN NEW.entry LIKE '%"started":["e1"]%' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    const turnId = s.turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: KEY.gatewayId, chatId: KEY.chatId, prompt: "deploy the site" });
    const j = s.journal.open(turnId, { ...KEY, kind: "chat", startedAt: 1 }, QUESTION);
    j.record({ role: "assistant", content: "", toolCalls: [call("e1", "exec", { command: "./deploy.sh" })] });
    j.started(["e1"]);
    j.record({ role: "assistant", content: "", toolCalls: [call("e2", "exec", { command: "./notify.sh" })] });
    expect(j.complete()).toBe(false);
    expect(s.journal.failures()).toMatchObject({ count: 1, lastAt: expect.any(Number) });

    const [turn] = recoverTurns({ journal: s.journal, sessions: s.sessions, turns: s.turns, atomically: (w) => s.db.transaction(w), maxTurns: 200 });

    // e1's start was never recorded, and it ran: it is cut off, never "nothing happened".
    expect(turn!.report).toContain("Cut off: `exec ./deploy.sh`");
    expect(turn!.report).not.toContain("Not started");
    expect(turn!.report).toContain("Part of what I did could not be recorded");
    expect(JSON.stringify(s.sessions.load(KEY).messages)).not.toContain("Nothing happened");
  });

  test("a journal whose every write landed reads as complete", async () => {
    const s = await stores();
    const j = s.journal.open("turn_ok", { ...KEY, kind: "chat", startedAt: 1 }, QUESTION);
    j.record({ role: "assistant", content: "", toolCalls: [call("e1", "exec", { command: "./deploy.sh" })] });
    expect(j.complete()).toBe(true);
    expect(s.journal.unsettled()[0]).toMatchObject({ turnId: "turn_ok", complete: true });
    expect(s.journal.failures()).toEqual({ count: 0, lastAt: null });
  });

  test("its report goes out once: the pass for replies that never landed does not repeat it", async () => {
    const s = await stores();
    const turnId = s.turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: KEY.gatewayId, chatId: KEY.chatId, prompt: "deploy the site" });
    const j = s.journal.open(turnId, { ...KEY, kind: "chat", startedAt: 1 }, QUESTION);
    j.record({ role: "assistant", content: "", toolCalls: [call("e1", "exec", { command: "./deploy.sh" })] });
    j.started(["e1"]);
    const durable = durableStores(s.db, s.events);
    const recovered = recoverTurns({ ...durable, sessions: s.sessions, turns: s.turns, maxTurns: 200 });
    const sent: string[] = [];
    const notifier = { toChat: async (_target: unknown, text: string) => (sent.push(text), true) };
    const resumed: string[] = [];
    const pipeline = {
      inbox: { reopen: () => ({ redelivered: 0, stale: 0, interrupted: 0 }) },
      resumeTurn: (turn: { id: string }) => (resumed.push(turn.id), true),
    } as unknown as Parameters<typeof resumeAfterBoot>[0]["pipeline"];

    await resumeAfterBoot({ recovered, orphaned: [], stores: durable, startedAt: Date.now(), pipeline, turns: s.turns, notifier, chatEvents: { record: () => null } });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Cut off: `exec ./deploy.sh`");
    expect(sent[0]).toContain("I'll carry on once I'm back");
    expect(s.db.prepare<{ delivered_at: number | null }>("SELECT delivered_at FROM turn_records WHERE id = ?").get(turnId)?.delivered_at).toBeGreaterThan(0);
    // And it is taken up again, once the report is on its way — `restart-resume.ts`.
    expect(resumed).toEqual([turnId]);
  });

  test("cut off in a call the gate asks about, it is not taken up by itself — its chat is told to check and say (0.8.0)", async () => {
    const s = await stores();
    const turnId = s.turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: KEY.gatewayId, chatId: KEY.chatId, prompt: "clean the old site" });
    const j = s.journal.open(turnId, { ...KEY, kind: "chat", startedAt: Date.now() }, QUESTION);
    j.record({ role: "assistant", content: "", toolCalls: [call("e1", "exec", { command: "rm -rf /srv/site-old" })] });
    j.started(["e1"]);
    const durable = durableStores(s.db, s.events);
    const recovered = recoverTurns({ ...durable, sessions: s.sessions, turns: s.turns, maxTurns: 200 });
    expect(recovered[0]!.cut).toEqual([{ name: "exec", arguments: { command: "rm -rf /srv/site-old" } }]);
    const sent: string[] = [];
    const notifier = { toChat: async (_target: unknown, text: string) => (sent.push(text), true) };
    const resumed: string[] = [];
    const pipeline = {
      inbox: { reopen: () => ({ redelivered: 0, stale: 0, interrupted: 0 }) },
      resumeTurn: (turn: { id: string }) => (resumed.push(turn.id), true),
    } as unknown as Parameters<typeof resumeAfterBoot>[0]["pipeline"];

    await resumeAfterBoot({ recovered, orphaned: [], stores: durable, startedAt: Date.now(), pipeline, turns: s.turns, notifier, chatEvents: { record: () => null } });

    expect(resumed).toEqual([]);
    expect(sent.join("\n")).toContain("so I have not taken it up by myself. Check, then say continue if it should go on.");
  });

  test("whose answer was already written settles as done — the answer is delivered, not a report", async () => {
    const s = await stores();
    const turnId = s.turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: KEY.gatewayId, chatId: KEY.chatId, prompt: "hi" });
    const j = s.journal.open(turnId, { ...KEY, kind: "chat", startedAt: 1 }, QUESTION);
    j.record({ role: "assistant", content: "Deployed." });

    const delivery = new DeliveryStore(s.db);
    const [turn] = recoverTurns({ journal: s.journal, sessions: s.sessions, turns: s.turns, delivery, atomically: (w) => s.db.transaction(w), maxTurns: 200 });

    expect(turn!.report).toBeNull();
    expect(s.turns.get(turnId)).toMatchObject({ status: "done", reply: "Deployed." });
    expect(s.sessions.load(KEY).messages.at(-1)?.content).toBe("Deployed.");
    const sent: string[] = [];
    const notifier = { toChat: async (_target: unknown, text: string) => (sent.push(text), true) };
    expect(await deliverUndelivered({ delivery, notifier })).toBe(1);
    expect(sent).toEqual(["Deployed."]);
  });

  test("a job turn folds into its conversation and tells no chat", async () => {
    const s = await stores();
    const cron = { agentId: "nouva", chatId: "cron:job-1", gatewayId: "cron" };
    const j = s.journal.open("turn_job", { ...cron, kind: "job", startedAt: 1 }, QUESTION);
    j.record({ role: "assistant", content: "", toolCalls: [call("e1", "exec", { command: "backup" })] });
    j.started(["e1"]);

    const [turn] = recoverTurns({ journal: s.journal, sessions: s.sessions, turns: s.turns, atomically: (w) => s.db.transaction(w), maxTurns: 200 });

    expect(turn!.report).toBeNull();
    expect(s.sessions.load(cron).messages.at(-1)?.role).toBe("assistant");
  });
});

