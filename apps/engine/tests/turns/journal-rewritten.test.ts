/**
 * A turn's journal rewritten to what the model holds, once its oldest steps were summed up (`turns/journal.store.ts`,
 * `llm/summarize-steps.ts`).
 *
 * The journal is what a turn is closed from when a restart cuts it off. A turn that made room for itself holds notes
 * and its newest steps; closed from every step as first recorded, it would be put into the conversation as a turn no
 * request can carry, and the turn taken up after the restart would end on the full context the notes were written to
 * avoid. So the journal is rewritten in one commit, and stays a journal with no hole in it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import type { ChatMessage } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { TurnJournalStore } from "@/modules/turns/journal.store.ts";
import { tempDir } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const QUESTION: ChatMessage = { role: "user", content: "cek kenapa disk penuh" };
const step = (n: number): ChatMessage[] => [
  { role: "assistant", content: `step ${n}`, toolCalls: [{ id: `c${n}`, name: "exec", arguments: { command: `du svc${n}` } }] },
  { role: "tool", toolCallId: `c${n}`, content: `${n}G` },
];

/** A journal three steps into a turn, as the executor writes it. */
async function journal() {
  const dir = tempDir("journal-rewritten");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  const store = new TurnJournalStore(db);
  const j = store.open("turn_1", { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", kind: "chat", startedAt: 1 }, QUESTION);
  for (const n of [1, 2, 3]) {
    const [asked, answered] = step(n) as [ChatMessage, ChatMessage];
    j.record(asked);
    j.started([`c${n}`]);
    j.record(answered);
  }
  return { db, store, j };
}

const messagesOf = (store: TurnJournalStore) => store.read("turn_1")!.entries.map((entry) => ("message" in entry ? entry.message : entry));

describe("a journal rewritten after the turn's oldest steps were summed up", () => {
  test("holds the question, then what it was handed, and nothing of what was recorded before", async () => {
    const { store, j } = await journal();
    const noted: ChatMessage = { role: "assistant", content: "[My notes]\n\nsvc1 and svc2 are small.\n\nstep 3", toolCalls: step(3)[0]!.toolCalls! };
    j.rewritten([noted, step(3)[1]!]);

    expect(messagesOf(store)).toEqual([QUESTION, noted, step(3)[1]!]);
    // No hole: a closing reads it as a journal whose every write landed.
    expect(store.read("turn_1")!.complete).toBe(true);
    expect(j.complete()).toBe(true);
    expect(store.count()).toBe(1);
  });

  test("goes on being written after it, in order, with no gap in its rows", async () => {
    const { db, store, j } = await journal();
    j.rewritten(step(3));
    const [asked, answered] = step(4) as [ChatMessage, ChatMessage];
    j.record(asked);
    j.started(["c4"]);
    j.record(answered);

    expect(messagesOf(store)).toEqual([QUESTION, ...step(3), asked, { started: ["c4"] }, answered]);
    expect(db.prepare<{ seq: number }>("SELECT seq FROM turn_journal WHERE turn_id = 'turn_1' ORDER BY seq").all().map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(store.read("turn_1")!.complete).toBe(true);
  });

  test("leaves another turn's journal alone", async () => {
    const { store, j } = await journal();
    const other = store.open("turn_2", { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-2", kind: "chat", startedAt: 1 }, { role: "user", content: "yang lain" });
    other.record({ role: "assistant", content: "ya" });
    j.rewritten(step(3));
    expect(store.read("turn_2")!.entries).toHaveLength(2);
  });

  test("a rewrite that cannot be committed leaves the journal as it was: whole, and only longer", async () => {
    const { db, store, j } = await journal();
    const before = messagesOf(store);
    // A message the store cannot write: the commit fails with the rows after the question already deleted inside it.
    const circular: Record<string, unknown> = { role: "assistant", content: "x" };
    circular.self = circular;
    j.rewritten([step(3)[0]!, circular as unknown as ChatMessage]);

    expect(messagesOf(store)).toEqual(before);
    expect(store.read("turn_1")!.complete).toBe(true);
    expect(store.failures().count).toBe(1);
    // And the next write lands, on the next number, as if nothing had been tried.
    j.record({ role: "assistant", content: "after" });
    const seqs = db.prepare<{ seq: number }>("SELECT seq FROM turn_journal WHERE turn_id = 'turn_1' ORDER BY seq").all().map((row) => row.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index));
    expect(messagesOf(store)).toEqual([...before, { role: "assistant", content: "after" }]);
    expect(j.complete()).toBe(true);
    expect(store.read("turn_1")!.complete).toBe(true);
  });
});
