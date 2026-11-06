/**
 * What a turn wrote down, and what a client can read back.
 *
 * The three bugs this table exists for were all the same bug — the turn belonged to the browser — and
 * each of them is pinned here from the store's side: a turn is readable *while it runs* (which is what
 * lets a refreshed page rejoin one instead of re-sending the message), the steps and the clock survive
 * the process (which is what stopped every reload showing `1 step · 1s`), and deleting a conversation
 * takes its turns with it (which is what "delete" has to mean to be worth offering).
 */

import { sessionIdFor } from "@nouride/shared";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { TurnStore } from "@/modules/turns/turns.store.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import {
  historyOf,
  messagesToTranscript,
  resolveCursor,
  toTurnPayload,
} from "@/modules/turns/transcript.ts";
import { tempDir, turnStore } from "../helpers.ts";
import { sleep } from "../wait.ts";

/** A tool call's step and its result, as the contract has them — the stores in these tests are strict. */
const CALL = { callId: "call_1", name: "exec" };
const DONE = { callId: "call_1", name: "exec", error: false };

let db: SqliteDb;
let dataDir: string;
let turns: TurnStore;

const SESSION = "ses_nouva:web:dashboard:web-1";

const begin = (over: Partial<Parameters<TurnStore["begin"]>[0]> = {}) =>
  turns.begin({
    sessionId: SESSION,
    agentId: "nouva",
    gatewayId: "web:dashboard",
    chatId: "web-1",
    prompt: "fix the build",
    ...over,
  });

beforeEach(async () => {
  dataDir = tempDir("turns");
  db = await openAndMigrate(join(dataDir, "test.db"));
  turns = turnStore(db);
});

afterEach(() => {
  db.close();
  removePath(dataDir);
});

describe("a turn the daemon started", () => {
  test("keeps why — the job and how it ended — and hands it to the transcript, so the chat heads it by that", () => {
    const id = begin({ senderId: "nouride", prompt: "Background job job_1 failed with exit code 2", cause: { via: "job completion", job: "job_1", outcome: "failed" } });
    turns.finish(id, { status: "done", reply: "it failed on the lint step" });
    const [turn] = turns.forSession(SESSION);
    expect(turn?.cause).toEqual({ via: "job completion", job: "job_1", outcome: "failed" });
    expect(toTurnPayload(turn!).cause).toEqual({ via: "job completion", job: "job_1", outcome: "failed" });
    // A person's has none, and says nothing of one.
    const typed = begin();
    expect(turns.get(typed)?.cause).toBeUndefined();
  });
});

describe("a turn while it is still running", () => {
  test("is readable, with the steps it has taken so far", () => {
    const id = begin();
    turns.step(id, "tool", "read package.json", CALL);
    turns.step(id, "tool_done", "read ok", DONE);

    const live = turns.latestForSession(SESSION);
    expect(live?.status).toBe("running");
    // The whole point: a client that arrives mid-turn — a reload, a second tab — sees the work.
    expect(turns.stepsSince(id, 0).map((s) => s.text)).toEqual(["read package.json", "read ok"]);
    expect(live?.endedAt).toBeUndefined();
  });

  test("hands out steps after a cursor, so a poller cannot miss one or re-read it", () => {
    const id = begin();
    turns.step(id, "tool", "first", CALL);
    turns.step(id, "tool", "second", CALL);

    const first = turns.stepsSince(id, 0);
    expect(first).toHaveLength(2);

    turns.step(id, "tool", "third", CALL);
    const next = turns.stepsSince(id, first[first.length - 1]!.seq);
    expect(next.map((s) => s.text)).toEqual(["third"]);
  });

  test("shows the answer as it is written", () => {
    const id = begin();
    turns.setReply(id, "Checking the");
    turns.setReply(id, "Checking the build now");

    expect(turns.get(id)?.reply).toBe("Checking the build now");
  });

  test("counts as a running conversation, and stops counting when it ends", () => {
    const id = begin();
    expect(turns.runningSessions().has(SESSION)).toBe(true);

    turns.finish(id, { status: "done", reply: "done" });
    expect(turns.runningSessions().has(SESSION)).toBe(false);
  });
});

describe("a finished turn", () => {
  test("keeps the numbers a reload used to lose", () => {
    const id = begin();
    turns.step(id, "tool", "exec bun test", CALL);
    turns.finish(id, {
      status: "done",
      reply: "the build is green",
      model: "gemini-3.7",
      toolCalls: 11,
      inputTokens: 4000,
      outputTokens: 300,
    });

    const [view] = turns.forSession(SESSION);
    expect(view?.status).toBe("done");
    expect(view?.toolCalls).toBe(11);
    expect(view?.model).toBe("gemini-3.7");
    // `1 step · 1s` was the symptom, and this is the field it was reading: a duration the client had
    // to invent because nothing sent it one.
    expect(toTurnPayload(view!).durationMs).toBeGreaterThanOrEqual(0);
    expect(view?.steps).toHaveLength(1);
  });

  test("a cancelled turn is not filed as a failure", () => {
    // Somebody pressed stop. A transcript that calls that a failure cannot tell you which of your
    // turns you killed and which one broke.
    const id = begin();
    turns.finish(id, { status: "cancelled", reply: "stopped" });
    expect(turns.get(id)?.status).toBe("cancelled");
  });

  test("finishing does not blank a reply it was not given", () => {
    // The streamed text is the only copy of a partial answer, and a turn that ends without text —
    // aborted, refused — must not erase what was already written.
    const id = begin();
    turns.setReply(id, "I got as far as");
    turns.finish(id, { status: "failed", error: "provider hung up" });

    expect(turns.get(id)?.reply).toBe("I got as far as");
    expect(turns.get(id)?.error).toBe("provider hung up");
  });
});

describe("a turn the daemon did not live to finish", () => {
  test("is marked interrupted, not left running forever", () => {
    // A row left `running` is a client polling for an event that can never arrive. Same fix, same
    // reason, as `JobStore.interruptOrphaned`.
    const id = begin();
    expect(turnStore(db).interruptOrphaned().turns).toBe(1);

    const record = turns.get(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.endedAt).toBeGreaterThan(0);
    expect(record?.error).toContain("restarted");
  });

  test("and a finished one is left alone", () => {
    const id = begin();
    turns.finish(id, { status: "done", reply: "ok" });
    expect(turns.interruptOrphaned().turns).toBe(0);
    expect(turns.get(id)?.status).toBe("done");
  });

  test("it reports where the turn was, so somebody can be told", () => {
    /**
     * The count alone marks a dashboard row honest and leaves the person who asked the question in
     * Telegram waiting for a reply that will never come. `boot/interrupted.ts` sends them a line
     * once the gateways are up, and it needs an address to do it.
     */
    const turnId = begin();
    const swept = turns.interruptOrphaned();

    expect(swept.turns).toBe(1);
    // With the turn, so one taken up again is not also told it is gone.
    expect(swept.conversations).toEqual([{ turnId, gatewayId: "web:dashboard", chatId: "web-1" }]);
  });

  test("a second sweep finds nothing, because the rows are no longer running", () => {
    // The addresses are read *before* the update. Reading after would return nothing and the notice
    // would go to nobody — the failure mode that looks exactly like success.
    begin();
    expect(turns.interruptOrphaned().conversations).toHaveLength(1);
    expect(turns.interruptOrphaned().conversations).toHaveLength(0);
  });
});

describe("the conversation list", () => {
  test("is named by what was first asked, not by the chat id", async () => {
    // `web-1757003921` names nothing. The first question does.
    begin({ prompt: "deploy to the raspi" });
    /**
     * The gap is the guarantee's precondition, not a flake workaround.
     *
     * `titles()` orders by `started_at` and breaks ties on a random id, so two turns stamped in the
     * same millisecond have a stable winner rather than the earliest one — see the note on the query.
     * Two `begin()` calls in a row land in one millisecond, which no real conversation does: a person
     * cannot type twice within a millisecond, and messages that do arrive back to back are merged
     * into one turn before a second record exists.
     */
    await sleep(2);
    begin({ prompt: "and check the disk" });

    expect(turns.titles().get(SESSION)).toBe("deploy to the raspi");
  });

  test("two turns in one millisecond still yield one stable answer", () => {
    /**
     * What the `id` tie-break is actually for. Without it the engine picks freely among the tied
     * rows, so the same query could label a conversation differently on two consecutive renders —
     * which is the failure the room ordering hit earlier in this repo's history, in the UI.
     *
     * Which of the two wins is not asserted, because it is not promised. That it is *the same one
     * every time* is.
     */
    begin({ prompt: "one" });
    begin({ prompt: "two" });

    const answers = new Set([1, 2, 3].map(() => turns.titles().get(SESSION)));
    expect(answers.size).toBe(1);
  });

  test("names each conversation from its own first turn", () => {
    begin({ prompt: "first here" });
    begin({ sessionId: "ses_nox:web:dashboard:web-2", prompt: "first there" });

    const titles = turns.titles();
    expect(titles.get(SESSION)).toBe("first here");
    expect(titles.get("ses_nox:web:dashboard:web-2")).toBe("first there");
  });
});

describe("deleting a conversation", () => {
  test("takes its turns and their steps with it", () => {
    const id = begin();
    turns.step(id, "tool", "exec rm -rf nothing", CALL);
    turns.finish(id, { status: "done", reply: "ok" });

    expect(turns.deleteForSession(SESSION)).toBe(1);
    expect(turns.forSession(SESSION)).toEqual([]);
    // Gone with it, not left behind: a row that outlived its turn is one nothing can ever read and nothing will
    // ever clean up — and in the stream, a deleted conversation's words still readable.
    expect(turns.stepsSince(id, 0)).toEqual([]);
    expect(new EventStore(db).list({ turnId: id })).toEqual([]);
  });

  test("leaves other conversations alone", () => {
    begin();
    const other = begin({ sessionId: "ses_nox:web:dashboard:web-2" });
    turns.deleteForSession(SESSION);
    expect(turns.get(other)?.id).toBe(other);
  });

  test("and the session row goes too", async () => {
    const sessions = new SessionStore(db);
    const key = { agentId: "nouva", chatId: "web-1", gatewayId: "web:dashboard" };
    sessions.save(key, [], 0);
    expect(sessions.find(sessionIdFor(key))).not.toBeNull();

    expect(sessions.delete(sessionIdFor(key))).toBe(true);
    expect(sessions.find(sessionIdFor(key))).toBeNull();
  });
});

describe("steps, kept in the event stream (0.7.6)", () => {
  const numbers = (steps: readonly { seq: number }[]) => steps.map((step) => step.seq);

  test("are rows of the stream — the one step store there is since 052", () => {
    const id = begin();
    turns.step(id, "tool", "exec ls", CALL);
    turns.step(id, "tool_done", "exec ok", DONE);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'turn_steps'").get()?.n).toBe(0);
    expect(numbers(turns.stepsSince(id, 0))).toEqual([1, 2]);
  });

  test("a step taken back is gone from every read — a poll that already passed it too", () => {
    const id = begin();
    for (const text of ["one", "two", "three"]) turns.step(id, "steer", text);
    expect(numbers(turns.stepsSince(id, 1))).toEqual([2, 3]);
    turns.unstep(id, [2]);
    expect(numbers(turns.stepsSince(id, 0))).toEqual([1, 3]);
    expect(numbers(turns.stepsSince(id, 1))).toEqual([3]);
    expect(numbers(turns.forSession(SESSION)[0]!.steps)).toEqual([1, 3]);
    expect(numbers(new TurnInspector(db).inspect(id)!.steps)).toEqual([1, 3]);
  });

  test("a turn taken up by the next process counts on from its highest step, taken back or not", () => {
    const id = begin();
    turns.step(id, "steer", "one");
    turns.step(id, "steer", "two");
    turns.unstep(id, [2]);
    const next = turnStore(db);
    expect(next.step(id, "note", "carried on")).toBe(3);
    expect(numbers(next.stepsSince(id, 0))).toEqual([1, 3]);
  });

  test("past the cap one note says so and the remarks stop; a tool call, its result and a wait go on", () => {
    const id = begin();
    for (let i = 1; i <= 500; i += 1) expect(turns.step(id, "reasoning", `thought ${i}`)).toBe(i);
    expect(turns.step(id, "reasoning", "one too many")).toBe(0);
    expect(turns.step(id, "note", "and another")).toBe(0);
    expect(turns.step(id, "tool", "exec ls", CALL)).toBe(502);
    expect(turns.step(id, "tool_done", "exec ok", DONE)).toBe(503);
    expect(turns.step(id, "waiting", "approve exec?")).toBe(504);
    expect(turns.stepsSince(id, 500).map((step) => [step.seq, step.kind, step.text])).toEqual([
      [501, "note", "step log capped at 500: tool calls and waits are still recorded"],
      [502, "tool", "exec ls"],
      [503, "tool_done", "exec ok"],
      [504, "waiting", "approve exec?"],
    ]);
    // A note, not a wait: `waiting` means a person is being asked something.
    expect(new EventStore(db).list({ turnId: id, kinds: ["note"] }).at(-1)?.data).toMatchObject({ step: 501, capped: true });
  });

  test("what is written for a deleted turn goes nowhere", () => {
    const id = begin();
    turns.deleteForSession(SESSION);
    expect(turns.step(id, "note", "too late")).toBe(0);
    turns.finish(id, { status: "cancelled" });
    expect(new EventStore(db).list({ turnId: id })).toEqual([]);
  });
});

describe("a slash command", () => {
  test("is recorded as a complete exchange with no steps", () => {
    // It is not a turn — no provider call, nothing to watch — but from the conversation's side it is a
    // question and an answer, and a transcript that omits it has a hole where the person typed
    // `/status`.
    const id = turns.note({
      sessionId: SESSION,
      agentId: "nouva",
      gatewayId: "web:dashboard",
      chatId: "web-1",
      prompt: "/status",
      reply: "nouva · 4 turns · 1.2k tokens",
    });

    const record = turns.get(id);
    expect(record?.status).toBe("done");
    expect(record?.endedAt).toBeGreaterThan(0);
    expect(turns.stepsSince(id, 0)).toEqual([]);
  });
});

describe("what came before turn records existed", () => {
  const messages = [
    { role: "user" as const, content: "old question", timestamp: 100 },
    { role: "assistant" as const, content: "old answer", timestamp: 200 },
    { role: "user" as const, content: "new question", timestamp: 5_000 },
    { role: "assistant" as const, content: "new answer", timestamp: 5_100 },
  ];

  test("is rendered from the messages, up to the first recorded turn", () => {
    // The two halves meet at a timestamp. Anything else means matching assistant messages to turns by
    // guesswork, and a transcript that shows an exchange twice is worse than one that shows it plainly.
    const out = messagesToTranscript(messages, { before: 5_000 });
    expect(out.map((m) => m.content)).toEqual(["old question", "old answer"]);
  });

  test("stops at the recorded turn's own question, even though it predates the record", () => {
    // Live on the first deploy: a brand-new conversation showed the person's message twice. The
    // envelope is stamped when it arrives and the record when the turn *begins*, so the question is
    // always a little older than the turn it started.
    const out = messagesToTranscript(messages, { before: 5_050, prompt: "new question" });
    expect(out.map((m) => m.content)).toEqual(["old question", "old answer"]);
  });

  test("the cut still lands when a context block was composed in front of the question", () => {
    /**
     * The bug a dashboard room made visible on its very first message.
     *
     * What the session stores as the user message is the *composed* question — the room's events,
     * then what the room said, then what the person typed, in that order — while the turn record
     * stores only what the person typed. The cut matched with `startsWith`, which holds when nothing
     * was composed in and fails the moment anything was: the legacy half survived, and the harness's
     * own scaffolding was drawn as a bubble somebody had supposedly sent.
     *
     * On screen that read as "[1 thing happened in this room since your last message — background,
     * not something to answer] - account@… started this room with nouva, nero." above the same
     * question asked properly.
     */
    const composed =
      "[1 thing happened in this room since your last message — background, not something to answer]\n" +
      "- gading started this room with nouva, nero.\n\ntes @nouva";
    const out = messagesToTranscript(
      [
        { role: "user", content: composed, timestamp: 6_000 },
      ],
      { before: 6_050, prompt: "tes @nouva" },
    );

    expect(out).toEqual([]);
  });

  test("and does not swallow a message that merely mentions the prompt earlier on", () => {
    // Anchored at the end, so a question quoted in the middle of an older message is not mistaken for
    // the recorded turn's own — the person's words are always last in a composed question.
    const out = messagesToTranscript(
      [
        { role: "user", content: "tes @nouva — tapi ini pesan lama", timestamp: 1_000 },
      ],
      { before: 6_050, prompt: "tes @nouva" },
    );

    expect(out.map((m) => m.content)).toEqual(["tes @nouva — tapi ini pesan lama"]);
  });

  test("a conversation whose only exchange is recorded has no legacy half at all", () => {
    const out = messagesToTranscript(
      [
        { role: "user", content: "the only question", timestamp: 900 },
        { role: "assistant", content: "the only answer", timestamp: 1_500 },
      ],
      { before: 1_000, prompt: "the only question" },
    );
    expect(out).toEqual([]);
  });

  test("is the whole conversation when nothing was recorded", () => {
    expect(messagesToTranscript(messages)).toHaveLength(4);
  });

  /**
   * A user message is stored as it was sent now, with the turn's clock note and reminders at its end
   * (M1, 2026-10-15). The cut above matches the record's prompt at the *end* of the message — exactly
   * where those notes now sit — so without stripping them every conversation would show its first
   * question twice, once as the legacy bubble and once as the turn's prompt.
   */
  test("the clock note and reminders stored with a message are not drawn, and do not hide the cut", () => {
    const sent = "new question\n\n(Sent 2026-10-15 09:12 Asia/Jakarta.)\n\n(If this is about something recent… check with `web_search` before you answer.)";
    const out = messagesToTranscript(
      [
        { role: "user", content: "old question\n\n(Sent 2026-10-14 21:40 Asia/Jakarta.)", timestamp: 100 },
        { role: "assistant", content: "old answer", timestamp: 200 },
        { role: "user", content: sent, timestamp: 5_000 },
      ],
      { before: 5_050, prompt: "new question" },
    );
    expect(out.map((m) => m.content)).toEqual(["old question", "old answer"]);
  });

  test("a note the person pasted into their own words stays — only the last one is the turn's", () => {
    const pasted = "earlier you said\n\n(Sent 2026-10-01 08:00 UTC.)\n\nwhat did that mean?";
    const out = messagesToTranscript([{ role: "user", content: `${pasted}\n\n(Sent 2026-10-15 09:12 UTC.)`, timestamp: 1 }]);
    expect(out.map((m) => m.content)).toEqual([pasted]);
  });

  test("on a message with pictures the notes are their own text part, and that part is dropped", () => {
    const out = messagesToTranscript([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "text", text: "(Sent 2026-10-15 09:12 UTC.)" },
        ],
        timestamp: 1,
      },
    ]);
    expect(out.map((m) => m.content)).toEqual(["what is this?"]);
  });

  test("folds the tool calls stored with a message into steps", () => {
    const out = messagesToTranscript([
      { role: "user", content: "check", timestamp: 1 },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "/etc/hosts" } }],
      },
      { role: "assistant", content: "checked", timestamp: 3 },
    ]);

    expect(out).toHaveLength(2);
    expect(out[1]?.steps?.[0]?.text).toBe("read /etc/hosts");
  });
});

describe("step timings", () => {
  test("the first step is measured from the start of the turn", () => {
    // Otherwise the first step reads as instantaneous, which hides the most interesting number in a
    // slow turn: the wait before anything happened.
    const view = {
      id: "t1",
      sessionId: SESSION,
      agentId: "nouva",
      gatewayId: "web:dashboard",
      chatId: "web-1",
      status: "done" as const,
      prompt: "p",
      reply: "r",
      toolCalls: 2,
      startedAt: 1_000,
      endedAt: 4_000,
      steps: [
        { seq: 1, at: 2_500, kind: "tool" as const, text: "read a" },
        { seq: 2, at: 2_700, kind: "tool" as const, text: "read b" },
      ],
    };

    const payload = toTurnPayload(view);
    expect(payload.steps.map((s) => s.ms)).toEqual([1_500, 200]);
    expect(payload.durationMs).toBe(3_000);
  });
});

describe("the live cursor", () => {
  test("is honoured for the turn it counted", () => {
    expect(resolveCursor({ requested: "t1", latest: "t1", asked: 40 })).toBe(40);
  });

  test("is discarded when the daemon is answering about a different turn", () => {
    // Otherwise a client that polled at step 40 of one turn is handed "everything after 40" of a turn
    // with four steps — nothing — and the live view sits empty while the agent works.
    expect(resolveCursor({ requested: "t1", latest: "t2", asked: 40 })).toBe(0);
  });

  test("a first poll starts at the beginning", () => {
    expect(resolveCursor({ latest: "t1", asked: 0 })).toBe(0);
    // And a client that asks with no turn but a stale number is treated the same way — it has not
    // told us what it counted, so we cannot trust the count. This one asserted 7 while saying so.
    expect(resolveCursor({ latest: "t1", asked: 7 })).toBe(0);
  });
});

describe("who owns a running turn", () => {
  const view = (id: string, status: "running" | "done") => ({
    id,
    sessionId: SESSION,
    agentId: "nouva",
    gatewayId: "web:dashboard",
    chatId: "web-1",
    status,
    prompt: "p",
    reply: status === "running" ? "" : "answered",
    toolCalls: 0,
    startedAt: 1_000,
    steps: [],
  });

  test("the history is only the turns that are over", () => {
    // The bug, seen on the live box: a reload got the running turn in the transcript, drew it as a
    // finished exchange — `… 0 steps`, empty answer — and suppressed the live feed because the turn
    // was "already in the history". The page froze while the daemon wrote a 2,500-character reply.
    const history = historyOf([view("t1", "done"), view("t2", "running")]);
    expect(history.map((t) => t.id)).toEqual(["t1"]);
  });

  test("a conversation whose only turn is running has no history yet", () => {
    expect(historyOf([view("t1", "running")])).toEqual([]);
  });
});

describe("a question asked twice", () => {
  test("does not truncate the history at the first time it was asked", () => {
    // The dashboard offers suggested prompts, so asking the same thing twice is normal. Matching the
    // recorded turn's prompt anywhere in the list would hide everything between the two.
    const out = messagesToTranscript(
      [
        { role: "user", content: "perkenalkan dirimu", timestamp: 100 },
        { role: "assistant", content: "halo, saya Nouva", timestamp: 200 },
        { role: "user", content: "cek disk", timestamp: 300 },
        { role: "assistant", content: "7.9 GB dari 40 GB", timestamp: 400 },
        { role: "user", content: "perkenalkan dirimu", timestamp: 5_000 },
      ],
      { before: 5_050, prompt: "perkenalkan dirimu" },
    );

    expect(out.map((m) => m.content)).toEqual([
      "perkenalkan dirimu",
      "halo, saya Nouva",
      "cek disk",
      "7.9 GB dari 40 GB",
    ]);
  });
});

/**
 * Two turns in the same millisecond, read twice.
 *
 * `forChat` ordered by `started_at` alone, so SQLite returned same-millisecond rows in whatever
 * order the scan produced — and the same room transcript read twice could put a reply above the
 * message it answered. Found by chasing a test that failed about one run in four under load and
 * passed every time on an idle machine, which is the shape of a bug that survives for months.
 *
 * The property is *stability*, not causality. `id` is a random UUID, so within one millisecond the
 * order is arbitrary — it simply no longer changes between reads. Getting the causal order would
 * need a monotonic column, and two turns sharing a millisecond in a room are usually genuinely
 * concurrent: a message naming two agents runs both.
 */
describe("ordering does not flap when two turns share a millisecond", () => {
  test("same-millisecond turns come back in the order they happened", () => {
    /**
     * Two wrong versions of this test came before the right one, and both are worth recording.
     *
     * Asserting *stability* proved nothing: SQLite answers the same query the same way twice in one
     * process with or without a tiebreak, so it passed with the fix deleted. Then I tiebroke on `id`
     * and asserted id order — which was checkable but not the property anybody wants, because `id`
     * is a random UUID: it makes the order stable and still arbitrary. The room test that started
     * all this kept failing under load, correctly.
     *
     * The property is that a room reads back the way it happened, so the assertion is the order the
     * turns were created in.
     */
    const at = Date.now();
    const order = ["nox", "nero", "nexa", "nestor", "nix", "nouva"];
    // Stamped directly rather than through the recorder: the collision is the premise, and leaving
    // it to how fast the machine is would make this pass or fail for the wrong reason.
    for (const agent of order) {
      const id = begin({ agentId: agent });
      db.prepare("UPDATE turn_records SET started_at = ? WHERE id = ?").run(at, id);
    }

    expect(turns.forChat("web:dashboard", "web-1").map((t) => t.agentId)).toEqual(order);
  });

  test("a later millisecond still sorts after an earlier one", () => {
    // The tiebreak must not become the sort. `id` is random, so a bug here would shuffle turns that
    // are genuinely minutes apart.
    const at = Date.now();
    const early = begin({ agentId: "first" });
    db.prepare("UPDATE turn_records SET started_at = ? WHERE id = ?").run(at, early);
    const late = begin({ agentId: "second" });
    db.prepare("UPDATE turn_records SET started_at = ? WHERE id = ?").run(at + 5_000, late);

    expect(turns.forChat("web:dashboard", "web-1").map((t) => t.agentId)).toEqual(["first", "second"]);
  });
});
