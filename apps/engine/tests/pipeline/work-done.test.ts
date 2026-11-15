/**
 * Work between agents that has ended, said to both of them in their own chats (`modules/pipeline/work-done.ts`).
 *
 * Seen on a live install: one agent handed another a step with `ask`, the report went back to the asker, and that was
 * all of it. The helper's own chat with the same person held no trace of the work it had just done, and the asker knew
 * nothing of what the person and the helper settled after.
 *
 * Held here: the row kept of work that ended, and what the table is bounded by; each line, and where its words may be
 * said; what is kept of the helper's later answer, and never from a room; and the whole of it through the real
 * pipeline: a person, an asking agent, the agent it asks, and the next turn of each.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import type { Person } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { KEPT_MS, OUTCOME_KEPT, SAID_KEPT, TASK_KEPT, WorkDoneStore, type WorkDone, type WorkDoneInput } from "@/modules/pipeline/work-done.store.ts";
import { askDone, DONE_WITHIN_MS, doneNotes, doneSources, heldIn, HELPED_SHOWN, helpedNote, keepDone, keepSaid, missionDone, TALKED_SHOWN, talkedNote, type DoneSources } from "@/modules/pipeline/work-done.ts";
import { samePersonIn } from "@/modules/pipeline/work-now.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { peersFrom } from "@/modules/tools/builtins/ask-agent.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { conversationOf, envelope, FakeGateway, tempDir } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function opened(clock: { now: number } = { now: NOW }): { store: WorkDoneStore; db: SqliteDb; clock: { now: number } } {
  const dir = tempDir("work-done");
  const db = openDatabase(join(dir, "t.db"));
  migrate(db);
  cleanup.push(() => {
    db.close();
    removePath(dir);
  });
  return { store: new WorkDoneStore(db, () => clock.now), db, clock };
}

/** The helper's own private chat with the person. */
const AT_NIX = { gatewayId: "telegram:nix", chatId: "814" };

const ASK: WorkDoneInput = { kind: "ask", helper: "nix", asker: "nestor", gatewayId: "telegram:nestor", chatId: "814", senderId: "814", task: "Run step 1 of the benchmark", outcome: "success: step 1 ran, 412 ms", ref: null };

describe("the row kept of work one agent did for another", () => {
  test("is read back by the agent that did it, newest first, and not by another", () => {
    const { store, clock } = opened();
    store.record(ASK);
    clock.now += 1000;
    store.record({ ...ASK, asker: "nouva", task: "Check the deploy", ref: "job_1" });
    const mine = store.byHelper("nix", NOW - HOUR);
    expect(mine.map((row) => [row.asker, row.task, row.ref, row.endedAt])).toEqual([
      ["nouva", "Check the deploy", "job_1", NOW + 1000],
      ["nestor", "Run step 1 of the benchmark", null, NOW],
    ]);
    expect(mine[1]).toMatchObject({ kind: "ask", helper: "nix", gatewayId: "telegram:nestor", chatId: "814", senderId: "814", outcome: "success: step 1 ran, 412 ms", saidAt: null, said: null });
    expect(store.byHelper("nestor", 0)).toEqual([]);
    // Only what ended since.
    expect(store.byHelper("nix", NOW + 500).map((row) => row.asker)).toEqual(["nouva"]);
  });

  test("an agent's work for itself is nobody else's: nothing is kept", () => {
    const { store } = opened();
    store.record({ ...ASK, asker: "nix" });
    expect(store.byHelper("nix", 0)).toEqual([]);
  });

  test("what was asked and how it ended are cut as they are written, on one line, with nothing that closes a quote", () => {
    const { store } = opened();
    store.record({ ...ASK, task: `Say "done"\nand \`stop\` ${"x".repeat(400)}`, outcome: `success: ${"y".repeat(900)}` });
    const [row] = store.byHelper("nix", 0);
    expect(row!.task.length).toBeLessThanOrEqual(TASK_KEPT);
    expect(row!.task.startsWith("Say 'done' and 'stop' xxx")).toBe(true);
    expect(row!.outcome.length).toBeLessThanOrEqual(OUTCOME_KEPT);
    expect(row!.outcome.length).toBeGreaterThan(OUTCOME_KEPT - 5);
  });

  test("a row a week old goes when the next is written, and not before", () => {
    const { store, db, clock } = opened();
    store.record(ASK);
    clock.now = NOW + KEPT_MS - 1000;
    store.record({ ...ASK, task: "Second" });
    const count = () => db.prepare<{ n: number }>("SELECT count(*) AS n FROM work_for_another").get()!.n;
    expect(count()).toBe(2);
    clock.now = NOW + KEPT_MS + 1000;
    store.record({ ...ASK, task: "Third" });
    expect(count()).toBe(2);
    expect(store.byHelper("nix", 0).map((row) => row.task)).toEqual(["Third", "Second"]);
  });

  test("the helper's later answer is kept on it, cut, and only then is it one the asker is told of", () => {
    const { store, clock } = opened();
    store.record(ASK);
    store.record({ ...ASK, task: "Another" });
    expect(store.talkedOf("nestor", 0)).toEqual([]);
    const [another, first] = store.byHelper("nix", 0);
    clock.now = NOW + 5000;
    store.said(first!.id, `We agreed to "ship" it ${"z".repeat(600)}`, AT_NIX);
    const talked = store.talkedOf("nestor", 0);
    expect(talked.map((row) => row.id)).toEqual([first!.id]);
    expect(talked[0]!.saidAt).toBe(NOW + 5000);
    expect(talked[0]!.said!.startsWith("We agreed to 'ship' it zzz")).toBe(true);
    expect(talked[0]!.said!.length).toBeLessThanOrEqual(SAID_KEPT);
    // Nobody else's, and not what ended before `since`.
    expect(store.talkedOf("nix", 0)).toEqual([]);
    expect(store.talkedOf("nestor", NOW + 1)).toEqual([]);
    // The latest talk first, whichever work ended last.
    clock.now = NOW + 9000;
    store.said(another!.id, "And the other.", AT_NIX);
    expect(store.talkedOf("nestor", 0).map((row) => row.task)).toEqual(["Another", "Run step 1 of the benchmark"]);
    clock.now = NOW + 12_000;
    store.said(first!.id, "Once more.", AT_NIX);
    expect(store.talkedOf("nestor", 0).map((row) => row.task)).toEqual(["Run step 1 of the benchmark", "Another"]);
  });
});

// NOW falls at eight in the morning, UTC: work that ended two hours before it ended at 06:00, a talk twenty minutes
// before at 07:40.
// ── the lines ─────────────────────────────────────────────────────────────────────────────────────────────────────

const row = (over: Partial<WorkDone> = {}): WorkDone => ({
  id: 1, kind: "ask", helper: "nix", asker: "nestor", gatewayId: "telegram:nestor", chatId: "814", senderId: "814",
  task: "Run step 1 of the benchmark", outcome: "success: step 1 ran, 412 ms", ref: null, endedAt: NOW - 2 * HOUR, saidAt: null, said: null, ...over,
});

/** One person with an id on each of two connections, as People holds them. */
const PEOPLE = [{ name: "Gading", ids: ["telegram:nestor:814", "telegram:nix:814", "web:usr_1"] }] as unknown as Person[];
const sameIn = samePersonIn(PEOPLE);

const sources = (over: Partial<DoneSources> = {}): DoneSources => ({
  at: { gatewayId: "telegram:nix", chatId: "814" },
  reader: { gatewayId: "telegram:nix", senderId: "814" },
  helped: [],
  talked: [],
  samePerson: sameIn,
  timeZone: "UTC",
  held: () => false,
  ...over,
});

describe("what the helper is told of its own work for another agent", () => {
  test("in words, in its own chat with the person the work was for: who asked, what, when, how it ended", () => {
    const note = helpedNote(sources({ helped: [row({ ref: "job_ab12" })] }));
    expect(note).toBe(
      "(Work you did for another agent lately. It is in no chat's history of yours, and a person may speak of it here as something you know: " +
        'A job for nestor, ended 2027-01-15 06:00 (job_ab12): asked "Run step 1 of the benchmark"; it ended success: step 1 ran, 412 ms.)',
    );
  });

  test("in words in the chat it was asked from, whoever is answered there", () => {
    const note = helpedNote(sources({ at: { gatewayId: "telegram:nestor", chatId: "814" }, reader: { gatewayId: "telegram:nestor", senderId: "999" }, helped: [row()] }));
    expect(note).toContain('asked "Run step 1 of the benchmark"');
  });

  test("anywhere else only that it did a job, for whom and when: another person's chat, a turn no person began, work no person began", () => {
    const closed = "A job for nestor, ended 2027-01-15 06:00, asked from a chat whose words are not this one's.";
    for (const src of [
      sources({ reader: { gatewayId: "telegram:nix", senderId: "555" }, helped: [row()] }),
      sources({ reader: undefined, helped: [row()] }),
      sources({ helped: [row({ senderId: null })] }),
      // Two senders People knows nothing of are two people, not one: neither has a name to share.
      sources({ reader: { gatewayId: "discord:nix", senderId: "888" }, helped: [row({ gatewayId: "discord:nestor", chatId: "d7", senderId: "777" })] }),
    ]) {
      const note = helpedNote(src)!;
      expect(note).toContain(closed);
      expect(note).not.toContain("benchmark");
      expect(note).not.toContain("412");
    }
  });

  test("a mission another agent started is said as one, with its id to read the rest from", () => {
    const note = helpedNote(sources({ helped: [row({ kind: "mission", ref: "msn_1", task: "Ship the docs", outcome: "done: the docs are out" })] }));
    expect(note).toContain('A mission for nestor, ended 2027-01-15 06:00 (msn_1): asked "Ship the docs"; it ended done: the docs are out.');
  });

  test("at most three, the newest; nothing said when there is none", () => {
    const many = Array.from({ length: HELPED_SHOWN + 2 }, (_, index) => row({ id: index, task: `Task ${index}` }));
    const note = helpedNote(sources({ helped: many }))!;
    expect(note.match(/A job for/g)).toHaveLength(HELPED_SHOWN);
    expect(note).toContain("Task 0");
    expect(note).not.toContain(`Task ${HELPED_SHOWN}`);
    expect(helpedNote(sources())).toBeNull();
    expect(doneNotes(sources())).toEqual([]);
  });
});

describe("each line is said once in a chat", () => {
  const first = row({ ref: "job_1" });
  const second = row({ id: 2, task: "Check the deploy", endedAt: NOW - HOUR });
  const lineOf = (one: WorkDone) => /A job for nestor[^.]*\.(?: \d+ ms\.)?/.exec(helpedNote(sources({ helped: [one] }))!)![0];

  test("a line the conversation holds is not said again; one it does not hold is", () => {
    const whole = helpedNote(sources({ helped: [first, second] }))!;
    expect(whole).toContain("Run step 1 of the benchmark");
    expect(whole).toContain("Check the deploy");
    // The first is in the chat's history, as sent: only the second is said.
    const held = (line: string) => line.includes("Run step 1 of the benchmark");
    const later = helpedNote(sources({ helped: [first, second], held }))!;
    expect(later).not.toContain("Run step 1 of the benchmark");
    expect(later).toContain("Check the deploy");
    // Both held: nothing is said, not an empty note.
    expect(helpedNote(sources({ helped: [first, second], held: () => true }))).toBeNull();
    expect(doneNotes(sources({ helped: [first], talked: [row({ saidAt: NOW, said: "Agreed." })], held: () => true }))).toEqual([]);
  });

  test("the line is the same text each time it is made, whenever that is: a clock's time, in the daemon's zone", () => {
    expect(lineOf(first)).toContain("ended 2027-01-15 06:00 (job_1)");
    expect(helpedNote(sources({ helped: [first], timeZone: "Asia/Jakarta" }))).toContain("ended 2027-01-15 13:00 (job_1)");
    // A zone nobody has is read as UTC, not thrown on.
    expect(helpedNote(sources({ helped: [first], timeZone: "Nowhere/Never" }))).toContain("ended 2027-01-15 06:00");
  });

  test("the asker's line is said again when the helper has answered anew, and not for the answer it was told of", () => {
    const answered = row({ saidAt: NOW - 20 * 60 * 1000, said: "Done, and we agreed to roll back tomorrow." });
    const asker = (over: Partial<DoneSources>) => sources({ at: { gatewayId: "telegram:nestor", chatId: "814" }, reader: { gatewayId: "telegram:nestor", senderId: "814" }, ...over });
    const told = talkedNote(asker({ talked: [answered] }))!;
    const held = (line: string) => told.includes(line);
    expect(talkedNote(asker({ talked: [answered], held }))).toBeNull();
    expect(talkedNote(asker({ talked: [{ ...answered, saidAt: NOW, said: "On second thought, today." }], held }))).toContain("On second thought, today.");
  });

  test("what a conversation holds is what its person's messages hold: a turn's notes are kept there, as sent", () => {
    const line = "A job for nestor, ended 2027-01-15 06:00";
    expect(heldIn([{ role: "user", content: `hello\n\n(Work you did for another agent lately: ${line}.)`, timestamp: 1 }], line)).toBe(true);
    expect(heldIn([{ role: "user", content: [{ type: "text", text: `x ${line} y` }], timestamp: 1 }], line)).toBe(true);
    // The agent quoting it back is not the daemon having said it.
    expect(heldIn([{ role: "assistant", content: `You mean ${line}?`, timestamp: 1 }], line)).toBe(false);
    expect(heldIn([{ role: "user", content: "hello", timestamp: 1 }], line)).toBe(false);
    expect(heldIn([], line)).toBe(false);
  });
});

describe("what the asker is told of what followed", () => {
  const followed = row({ saidAt: NOW - 20 * 60 * 1000, said: "Done, and we agreed to roll back tomorrow." });
  const asker = (over: Partial<DoneSources> = {}) => sources({ at: { gatewayId: "telegram:nestor", chatId: "814" }, reader: { gatewayId: "telegram:nestor", senderId: "814" }, talked: [followed], ...over });

  test("on a turn that answers the same person: who, on what, when, and how the helper's answer there began", () => {
    expect(talkedNote(asker())).toBe(
      "(What they settled there is not in this chat: " +
        'Since nix worked for you on "Run step 1 of the benchmark" (ended 2027-01-15 06:00), it has answered the person you are answering in a chat of their own, at 2027-01-15 07:40. ' +
        'That answer began: "Done, and we agreed to roll back tomorrow.".)',
    );
  });

  test("the same person on another connection is the same person", () => {
    expect(talkedNote(asker({ at: { gatewayId: "web:dashboard", chatId: "d1" }, reader: { gatewayId: "web", senderId: "usr_1" } }))).toContain("roll back tomorrow");
  });

  test("never to another person, even in the chat it was asked from: what a person said in private is theirs", () => {
    // A room: the work was asked from here, and somebody else is answered now.
    expect(talkedNote(asker({ reader: { gatewayId: "telegram:nestor", senderId: "999" } }))).toBeNull();
    expect(talkedNote(asker({ reader: undefined }))).toBeNull();
    expect(talkedNote(asker({ talked: [{ ...followed, senderId: null }] }))).toBeNull();
  });

  test("nothing of work the helper has not talked of since; at most two", () => {
    expect(talkedNote(asker({ talked: [row()] }))).toBeNull();
    const many = Array.from({ length: TALKED_SHOWN + 2 }, (_, index) => ({ ...followed, id: index, task: `Task ${index}` }));
    const note = talkedNote(asker({ talked: many }))!;
    expect(note.match(/Since nix worked for you/g)).toHaveLength(TALKED_SHOWN);
  });

  test("both lines, the helper's first, on one turn's message", () => {
    const notes = doneNotes(asker({ helped: [row({ helper: "nestor", asker: "nouva" })] }));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("Work you did for another agent lately");
    expect(notes[1]).toContain("What they settled there");
  });
});

describe("a conversation deleted is said nowhere afterwards", () => {
  test("what its agent asked another for from it goes; another agent's asks from the same chat, and other chats', stay", () => {
    const { store } = opened();
    store.record(ASK);
    store.record({ ...ASK, chatId: "999", task: "From another chat" });
    store.record({ ...ASK, asker: "nouva", task: "Another agent's, from the same chat" });
    expect(store.forgetChat("nestor", "telegram:nestor", "814")).toBe(1);
    expect(store.byHelper("nix", 0).map((row) => row.task).sort()).toEqual(["Another agent's, from the same chat", "From another chat"]);
    // The helper deleting a chat of its own takes none of the work it did from another's.
    expect(store.forgetChat("nix", "telegram:nestor", "999")).toBe(0);
    expect(store.byHelper("nix", 0)).toHaveLength(2);
  });

  test("an answer its agent gave in it is taken off the work it was kept on; the work, and an answer from another chat, stay", () => {
    const { store } = opened();
    store.record(ASK);
    store.record({ ...ASK, task: "Second" });
    const [second, first] = store.byHelper("nix", 0);
    store.said(first!.id, "Agreed here.", AT_NIX);
    store.said(second!.id, "Agreed elsewhere.", { gatewayId: "web:dashboard", chatId: "d1" });
    // Another agent's conversation of the same address is not the helper's.
    store.forgetChat("nestor", "telegram:nix", "814");
    expect(store.talkedOf("nestor", 0)).toHaveLength(2);

    store.forgetChat("nix", "telegram:nix", "814");
    expect(store.talkedOf("nestor", 0).map((row) => [row.task, row.said])).toEqual([["Second", "Agreed elsewhere."]]);
    expect(store.byHelper("nix", 0).find((row) => row.task === ASK.task)).toMatchObject({ said: null, saidAt: null });
  });
});

describe("what is read for a turn, and what is kept as work ends", () => {
  test("a turn reads the last day's, its own as helper and what was talked of as asker", () => {
    const { store, clock } = opened();
    store.record(ASK);
    store.said(store.byHelper("nix", 0)[0]!.id, "Agreed.", AT_NIX);
    clock.now = NOW + DONE_WITHIN_MS - 1000;
    const at = { gatewayId: "telegram:nix", chatId: "814" };
    expect(doneSources(store, { me: "nix", at, reader: undefined, people: PEOPLE, now: clock.now, timeZone: "UTC", held: () => false }).helped).toHaveLength(1);
    expect(doneSources(store, { me: "nestor", at, reader: undefined, people: PEOPLE, now: clock.now, timeZone: "UTC", held: () => false }).talked).toHaveLength(1);
    // A day on, it is not said any more.
    clock.now = NOW + DONE_WITHIN_MS + 1000;
    expect(doneSources(store, { me: "nix", at, reader: undefined, people: PEOPLE, now: clock.now, timeZone: "UTC", held: () => false }).helped).toEqual([]);
    expect(doneSources(store, { me: "nestor", at, reader: undefined, people: PEOPLE, now: clock.now, timeZone: "UTC", held: () => false }).talked).toEqual([]);
    // No store, nothing: an install without it says nothing and fails nothing.
    expect(doneNotes(doneSources(undefined, { me: "nix", at, reader: undefined, people: PEOPLE, now: NOW, timeZone: "UTC", held: () => false }))).toEqual([]);
  });

  test("an ask that ended: who did it, who asked, from where, for whom, and how it ended in one line", () => {
    const report = { status: "success" as const, summary: "  step 1 ran\n", reason: undefined };
    expect(askDone({ helper: "nix", asker: "nestor", from: { gatewayId: "g", chatId: "c", senderId: "u" }, task: "Run it", report, job: "job_1" })).toEqual({
      kind: "ask", helper: "nix", asker: "nestor", gatewayId: "g", chatId: "c", senderId: "u", task: "Run it", outcome: "success: step 1 ran", ref: "job_1",
    });
    const failed = askDone({ helper: "nix", asker: "nestor", from: { gatewayId: "g", chatId: "c" }, task: "Run it", report: { status: "failed", summary: "", reason: "the provider refused" } });
    expect(failed).toMatchObject({ senderId: null, ref: null, outcome: "failed (the provider refused)" });
    // Stopped at a step for a restart: it has not ended, and is not kept as if it had.
    expect(askDone({ helper: "nix", asker: "nestor", from: { gatewayId: "g", chatId: "c" }, task: "Run it", report, paused: true })).toBeNull();
  });

  test("a mission another agent started is kept as it ends; one a person started, or its own agent, is not", () => {
    const mission = { id: "msn_1", agentId: "nix", byAgent: "nestor" as string | null, gatewayId: "telegram:nestor", chatId: "814", startedBy: "814", goal: "Ship the docs", status: "done" as const, reason: null as string | null, report: "The docs are out." as string | null };
    expect(missionDone(mission)).toEqual({ kind: "mission", helper: "nix", asker: "nestor", gatewayId: "telegram:nestor", chatId: "814", senderId: "814", task: "Ship the docs", outcome: "done: The docs are out.", ref: "msn_1" });
    expect(missionDone({ ...mission, status: "failed", reason: "its checks never passed", report: null })).toMatchObject({ outcome: "failed (its checks never passed)" });
    expect(missionDone({ ...mission, byAgent: null })).toBeNull();
    expect(missionDone({ ...mission, byAgent: "nix" })).toBeNull();
  });

  test("keeping never fails the work it is kept of: a store that throws is said in the log, and nothing to keep is nothing", () => {
    const calls: WorkDoneInput[] = [];
    keepDone({ record: (input) => void calls.push(input) }, ASK);
    keepDone({ record: () => { throw new Error("disk full"); } }, ASK);
    keepDone({ record: (input) => void calls.push(input) }, null);
    keepDone(undefined, ASK);
    expect(calls).toEqual([ASK]);
  });

  test("the helper's answer is kept on its recent work for that person, from a private chat alone", () => {
    const { store } = opened();
    store.record(ASK);
    store.record({ ...ASK, senderId: "555", task: "For somebody else" });
    store.record({ ...ASK, senderId: null, task: "Nobody's" });
    const base = { me: "nix", at: AT_NIX, private: true, reader: { gatewayId: "telegram:nix", senderId: "814" }, reply: "Agreed: roll back tomorrow.", people: PEOPLE, now: NOW };
    const said = () => store.byHelper("nix", 0).filter((one) => one.said !== null).map((one) => [one.task, one.said]);

    keepSaid(store, { ...base, private: false });
    keepSaid(store, { ...base, reader: undefined });
    keepSaid(store, { ...base, reply: "   " });
    keepSaid(store, { ...base, me: "nestor" });
    keepSaid(undefined, base);
    expect(said()).toEqual([]);

    keepSaid(store, base);
    // The same person, on the helper's own connection; not the other person's work, nor work no person began.
    expect(said()).toEqual([["Run step 1 of the benchmark", "Agreed: roll back tomorrow."]]);
    // The latest answer is the one kept.
    keepSaid(store, { ...base, reply: "On second thought, today." });
    expect(said()).toEqual([["Run step 1 of the benchmark", "On second thought, today."]]);
    // Where it was said is kept with it: the answer goes when that conversation is deleted.
    expect(store.forgetChat("nix", "telegram:nix", "814")).toBe(0);
    expect(said()).toEqual([]);
    // A store that throws does not fail the turn.
    keepSaid({ byHelper: () => { throw new Error("locked"); }, said: () => {} }, base);
  });
});

// ── through the real pipeline ─────────────────────────────────────────────────────────────────────────────────────

interface Said {
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}
interface Body {
  messages: { role: string; content: unknown }[];
  stream?: boolean;
}
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
const agentOf = (body: Body): string => /\(agent id: ([^)]+)\)/.exec(textOf(body.messages[0]?.content))?.[1] ?? "?";
const lastUser = (body: Body): string => textOf(conversationOf(body.messages).filter((message) => message.role === "user").at(-1)?.content);

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["ask_agent"]\napproval_required = []\n';
const DEPLOY = "Deploy v2 to staging, then check it answers on /health.";

async function daemon(answer: (agent: string, body: Body) => Said) {
  const asked: { agent: string; body: Body }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const agent = agentOf(body);
    asked.push({ agent, body });
    const said = answer(agent, body);
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    if (!body.stream) return Response.json({ model: "test-model", choices: [{ message: { content: said.text ?? "" }, finish_reason: "stop" }], usage });
    const events: string[] = [];
    if (said.text) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: said.text } }] })}\n\n`);
    for (const [index, call] of (said.toolCalls ?? []).entries()) {
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`);
    }
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: said.toolCalls?.length ? "tool_calls" : "stop" }], usage })}\n\n`, "data: [DONE]\n\n");
    return new Response(new ReadableStream({ start: (controller) => { for (const event of events) controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  const gateway = new FakeGateway();
  let jobs!: JobStore;
  let store!: WorkDoneStore;
  const bench: Bench = await pipelineBench({
    fetch: () => fetchImpl,
    gateway,
    agents: ["nouva", "nox"].map((id) => ({ id, configToml: PACK })),
    config: { daemon: { orchestrator: "nouva" }, agents: { mentions_enabled: true } },
    configure: (config) => {
      config.queue.steerReply = false;
    },
    deps: ({ db, dataDir, config }) => {
      jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4, maxMs: () => config.security.jobMaxMs });
      // As `boot/turn-machine.ts` hands it over.
      store = new WorkDoneStore(db);
      return { jobs, workDone: store };
    },
  });
  cleanup.push(async () => {
    await jobs.killAll();
    for (const turn of bench.pipeline.runningTurns()) turn.controller.abort();
    await bench.pipeline.drain();
    bench.dispose();
  });
  const tools = createBuiltinTools({
    security: bench.config.security,
    runSubagent: bench.pipeline.subagentRunner(),
    startHelper: bench.pipeline.backgroundHelpers(),
    askAgent: { run: bench.pipeline.peerTurnRunner(), start: bench.pipeline.askRunner(), waitMs: 5_000, ...peersFrom(bench.registry, () => true) },
    audit: new AuditLog(bench.db),
  });
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  jobs.setOnComplete((completion) => bench.pipeline.wakeForJob(completion));
  const requests = (agent: string) => asked.filter((one) => one.agent === agent);
  /** A person's message, and the reply that answers it. */
  const say = async (text: string, id: string, over: Parameters<typeof envelope>[0] = {}): Promise<void> => {
    const before = gateway.sent.length;
    gateway.receive(envelope({ id, text, timestamp: Date.now(), ...over }));
    await eventually(() => gateway.sent.slice(before).some((message) => !message.text.startsWith("[")), 6_000, `the reply to "${text}"`);
    // And the turn over, with what follows its reply written: the next message is a new turn.
    await eventually(() => [...bench.pipeline.runningTurns()].length === 0, 6_000, "the turn to end");
  };
  return { store, say, requests, bench };
}

describe("through the real pipeline: one agent asks another, and both are told in their own chats", () => {
  test("the ask is kept as it ends; the helper is told of it in its own chat with the person; its answer there reaches the asker's next turn for them", async () => {
    const d = await daemon((agent, body) => {
      const asked = lastUser(body);
      if (agent === "nox") {
        // Asked by nouva: the brief. In its own chat: the person.
        if (asked.includes(DEPLOY) && !asked.includes("Work you did")) return { text: "Deployed v2 to staging; /health answers 200." };
        return { text: asked.includes("and here?") ? "In the room: v2 is out." : "Yes, v2 is on staging. We agreed to roll it back tomorrow." };
      }
      const results = body.messages.filter((message) => message.role === "tool");
      if (asked.includes("deploy") && results.length === 0) return { toolCalls: [{ id: "a1", name: "ask_agent", args: { agent: "nox", task: DEPLOY } }] };
      return { text: "Done." };
    });

    // 1. The person asks nouva, which asks nox, which answers inside the asking turn.
    await d.say("please deploy v2", "m1");
    const [kept] = d.store.byHelper("nox", 0);
    expect(kept).toMatchObject({ kind: "ask", helper: "nox", asker: "nouva", gatewayId: "telegram:main", chatId: "chat-1", senderId: "user-1", task: DEPLOY, outcome: "success: Deployed v2 to staging; /health answers 200.", said: null });

    // 2. The same person, in a chat of their own with nox.
    await d.say("nox: is v2 out?", "m2", { chatId: "chat-nox" });
    const told = lastUser(d.requests("nox").at(-1)!.body);
    expect(told).toContain("Work you did for another agent lately");
    expect(told).toContain(`A job for nouva`);
    expect(told).toContain(`asked "${DEPLOY}"; it ended success: Deployed v2 to staging; /health answers 200.`);
    // What nox answered there is kept on the work.
    expect(d.store.talkedOf("nouva", 0)[0]).toMatchObject({ said: "Yes, v2 is on staging. We agreed to roll it back tomorrow." });

    // Its next message in that chat does not say it again: the chat holds it.
    await d.say("nox: thanks", "m2b", { chatId: "chat-nox" });
    expect(lastUser(d.requests("nox").at(-1)!.body)).not.toContain("Work you did for another agent lately");
    expect(d.requests("nox").at(-1)!.body.messages.filter((message) => textOf(message.content).includes("Work you did for another agent lately"))).toHaveLength(1);

    // In a room, to the same person: said there, and never carried out of it.
    await d.say("nox: and here?", "m2r", { chatId: "room-1", chatType: "group" });
    expect(d.store.talkedOf("nouva", 0)[0]).toMatchObject({ said: "Yes, v2 is on staging. We agreed to roll it back tomorrow." });

    // 3. The asker's next turn for that person.
    await d.say("anything else?", "m3");
    const nouva = lastUser(d.requests("nouva").at(-1)!.body);
    expect(nouva).toContain(`Since nox worked for you on "${DEPLOY}"`);
    expect(nouva).toContain('That answer began: "Yes, v2 is on staging. We agreed to roll it back tomorrow.".');
    // The asker did no work for another: it is told nothing of the kind.
    expect(nouva).not.toContain("Work you did for another agent lately");

    // 4. The helper's own chat deleted: its answer there is said nowhere any more. Then the chat the work was asked from.
    await d.bench.pipeline.endConversation({ agentId: "nox", gatewayId: "telegram:main", chatId: "chat-nox" }, "delete");
    expect(d.store.talkedOf("nouva", 0)).toEqual([]);
    expect(d.store.byHelper("nox", 0)).toHaveLength(1);
    await d.bench.pipeline.endConversation({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" }, "delete");
    expect(d.store.byHelper("nox", 0)).toEqual([]);
  }, 30_000);

  test("another person is told none of its words: the helper only that it did a job, the asker nothing", async () => {
    const d = await daemon((agent, body) => {
      const asked = lastUser(body);
      if (agent === "nox") {
        if (asked.includes(DEPLOY) && !asked.includes("Work you did")) return { text: "Deployed v2 to staging." };
        return { text: asked.includes("is v2 out") ? "v2 is out." : "Hi Rani." };
      }
      const results = body.messages.filter((message) => message.role === "tool");
      if (asked.includes("deploy") && results.length === 0) return { toolCalls: [{ id: "a1", name: "ask_agent", args: { agent: "nox", task: DEPLOY } }] };
      return { text: "Done." };
    });
    await d.say("please deploy v2", "m1");
    await d.say("nox: is v2 out?", "m2", { chatId: "chat-nox" });

    await d.say("nox: hi", "m3", { chatId: "chat-other", senderId: "user-2", senderName: "Rani" });
    const helper = lastUser(d.requests("nox").at(-1)!.body);
    expect(helper).toContain("A job for nouva");
    expect(helper).toContain("asked from a chat whose words are not this one's");
    expect(helper).not.toContain("Deploy v2");
    // And what nox said to the first person is not replaced by what it said to the second.
    expect(d.store.talkedOf("nouva", 0)[0]).toMatchObject({ said: "v2 is out." });

    await d.say("status?", "m4", { chatId: "chat-other-2", senderId: "user-2", senderName: "Rani" });
    const asker = lastUser(d.requests("nouva").at(-1)!.body);
    expect(asker).not.toContain("Since nox worked for you");
    expect(asker).not.toContain("Deploy v2");
  }, 30_000);
});
