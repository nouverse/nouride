/**
 * What one message costs in commits — through the real pipeline, wired as the daemon wires it (`boot/durable.ts`).
 *
 * Each commit is a write a Box's card takes. A plain one-line message in a one-to-one chat, answered in one model
 * call, made eleven before 0.7.11:
 *
 *     INSERT inbox · UPDATE inbox (placed) · INSERT turn_records + event · INSERT turn_journal (head) ·
 *     INSERT turn_journal (question) · UPDATE turn_journal (composed question) · UPDATE turn_records + event (partial
 *     answer) · INSERT turn_journal (answer) · the settle · UPDATE turn_records (delivered) · UPDATE inbox (done)
 *
 * It makes eight: the inbox's row and its `placed` are one commit, the journal opens in one, and the message is
 * handled in the turn's own settle. What is left apart is apart for a reason — the turn's row is written before
 * anything slow, the composed question after its files download, the answer is journaled before the settle so a crash
 * between them keeps it, and `delivered_at` is set only once the platform has the reply.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SqliteDb } from "@nouride/runtime";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { countingDb, envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

async function daemon(options: { answer?: string; appliance?: boolean } = {}) {
  let raw!: SqliteDb;
  let counted!: ReturnType<typeof countingDb>;
  const bench = await pipelineBench({
    turns: [{ text: options.answer ?? "Halo juga." }],
    config: { agents: { groups_require_mention: false } },
    db: (opened) => ((raw = opened), (counted = countingDb(opened)).db),
    deps: ({ db }) => ({ roomMessages: new RoomMessageStore(db), ...(options.appliance ? { appliance: () => true } : {}) }),
  });
  benches.push(bench);
  const { pipeline, gateway } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();
  counted.commits.length = 0;
  return { pipeline, gateway, db: raw, commits: () => counted.commits.map((commit) => commit.join(" + ")) };
}

const inboxStatus = (db: SqliteDb) => db.prepare<{ status: string }>("SELECT status FROM inbox").all().map((row) => row.status);

describe("one message", () => {
  test("is eight commits, where it was eleven", async () => {
    const d = await daemon();
    d.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "halo", timestamp: Date.now() }));
    await d.pipeline.idle();

    expect(d.commits()).toEqual([
      "INSERT inbox + UPDATE inbox",
      "INSERT turn_records + INSERT events:turn",
      "INSERT turn_journal + INSERT turn_journal",
      "UPDATE turn_journal",
      // What the request carried (0.7.26) goes with the first row it answered, never in a commit of its own.
      "UPDATE turn_records + INSERT events:context + INSERT events:reply",
      "INSERT turn_journal",
      // The conversation is its row and the two messages the turn added — the question and the answer: the turn
      // writes those, not the whole conversation again. Still the one settle.
      "INSERT sessions + INSERT session_messages + INSERT session_messages + DELETE turn_journal + UPDATE turn_records + INSERT events:reply + UPDATE turn_records + INSERT events:turn + UPDATE turn_records + UPDATE inbox",
      "UPDATE turn_records",
    ]);
    // Handled, and only once: nothing after the settle writes the inbox again.
    expect(inboxStatus(d.db)).toEqual(["done"]);
  });

  test("in a room, its record in the room's log is the same commit as its inbox row", async () => {
    const d = await daemon();
    d.gateway.receive(envelope({ id: "g1", chatType: "group", chatId: "room-1", senderId: "ana", text: "halo semua", timestamp: Date.now() }));
    await d.pipeline.idle();

    expect(d.commits()[0]).toBe("INSERT chat_messages + INSERT inbox + UPDATE inbox");
    expect(inboxStatus(d.db)).toEqual(["done"]);
  });

  test("on a Box, a partial answer is written about once a second or a kilobyte, not every 240 characters", async () => {
    const answer = "x".repeat(600);
    // The first carries the request's line too (`events:context`).
    const partials = (commits: string[]) => commits.filter((commit) => /^UPDATE turn_records( \+ INSERT events:context)? \+ INSERT events:reply$/.test(commit)).length;

    const plain = await daemon({ answer });
    plain.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "panjang", timestamp: Date.now() }));
    await plain.pipeline.idle();
    // Streamed in two halves of 300: the first is written at once, the second is past 240 more.
    expect(partials(plain.commits())).toBe(2);

    const box = await daemon({ answer, appliance: true });
    box.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "panjang", timestamp: Date.now() }));
    await box.pipeline.idle();
    expect(partials(box.commits())).toBe(1);
  });
});
