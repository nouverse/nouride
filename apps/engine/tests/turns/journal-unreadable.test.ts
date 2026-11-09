/**
 * A journal row that cannot be read is a hole, said in the log, never skipped in silence (`turns/journal.store.ts`).
 *
 * A row that did not parse, or parsed into neither a message nor a list of started calls, was dropped from the turn and
 * the journal still read as complete — so the closing after a crash read past it, and could say a call it named never
 * began, with nothing in the log to say a row was gone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { TurnJournalStore } from "@/modules/turns/journal.store.ts";
import { tempDir } from "../helpers.ts";

const warned: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "turns.journal" && entry.level === "warn" && warned.push(entry)));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  warned.length = 0;
});

/** A journal of one turn, as a crash leaves it: the question, a call asked for, its start, its result. */
async function journal() {
  const dir = tempDir("journal-unreadable");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  const store = new TurnJournalStore(db);
  const j = store.open("turn_1", { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", kind: "chat", startedAt: 1 }, { role: "user", content: "deploy the site" });
  j.record({ role: "assistant", content: "", toolCalls: [{ id: "e1", name: "exec", arguments: { command: "./deploy.sh" } }] });
  j.started(["e1"]);
  j.record({ role: "tool", toolCallId: "e1", content: "deployed to the private host" });
  expect(store.unsettled()[0]?.complete).toBe(true);
  return { db, store };
}

describe("a journal row that cannot be read", () => {
  for (const [what, entry] of [
    ["is not JSON", '{"started": ["e1"'],
    ["is JSON but neither a message nor started calls", '{"something": "else"}'],
  ] as const) {
    test(`one that ${what} makes the journal incomplete, and the warning names the turn and the row's number`, async () => {
      const { db, store } = await journal();
      const seq = db.prepare<{ seq: number }>("SELECT seq FROM turn_journal WHERE turn_id = 'turn_1' AND entry LIKE '%\"started\"%'").get()!.seq;
      db.prepare("UPDATE turn_journal SET entry = ? WHERE turn_id = 'turn_1' AND seq = ?").run(entry, seq);

      const [turn] = store.unsettled();

      expect(turn?.complete).toBe(false);
      // What could be read is still there.
      expect(turn?.entries.filter((read) => "message" in read)).toHaveLength(3);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.message).toBe("skipped a turn journal row that could not be read");
      expect(warned[0]!.turn_id).toBe("turn_1");
      expect(warned[0]!.data).toEqual({ seq });
    });
  }

  test("the warning carries the row's number, never what the turn said", async () => {
    const { db, store } = await journal();
    const seq = db.prepare<{ seq: number }>("SELECT seq FROM turn_journal WHERE turn_id = 'turn_1' AND entry LIKE '%deployed to%'").get()!.seq;
    db.prepare("UPDATE turn_journal SET entry = substr(entry, 1, 40) WHERE turn_id = 'turn_1' AND seq = ?").run(seq);

    expect(store.unsettled()[0]?.complete).toBe(false);
    expect(JSON.stringify(warned)).not.toContain("deploy");
  });
});
