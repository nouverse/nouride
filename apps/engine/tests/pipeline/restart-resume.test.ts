/**
 * A turn a restart cut off is taken up again once the daemon is back — once, soon after, and only a
 * conversation's (`modules/pipeline/restart-resume.ts`).
 *
 * Until 0.7.0 nothing ran again until somebody said "continue", so work left running overnight waited for
 * the morning. Each condition here is the one that keeps that from becoming a loop or a surprise: a daemon
 * down for long was stopped on purpose, a turn that crashed it must not restart it for ever, and a cron
 * run has a schedule of its own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { turnsToResume } from "@/modules/pipeline/restart-resume.ts";
import { SCHEDULED, TurnStore } from "@/modules/turns/turns.store.ts";
import { FakeGateway, tempDir, turnStore } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const MINUTE = 60_000;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function store(): Promise<TurnStore> {
  const dir = tempDir("restart-resume");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  return turnStore(db);
}

/** A turn as a restart leaves it: begun, and closed `interrupted`. */
function cut(turns: TurnStore, chatId = "814", messageId?: string): string {
  const id = turns.begin({ sessionId: `ses_nouva:telegram:nouva:${chatId}`, agentId: "nouva", gatewayId: "telegram:nouva", chatId, prompt: "deploy the site", ...(messageId ? { messageId } : {}) });
  turns.finish(id, { status: "interrupted", reply: "⚠️ I was interrupted by a restart…", error: "restart" });
  return id;
}

describe("which turns are taken up", () => {
  test("one the shutdown stopped, soon after", async () => {
    const turns = await store();
    const id = cut(turns);
    expect(turnsToResume({ recovered: [], turns, now: Date.now() }).map((turn) => turn.id)).toEqual([id]);
  });

  test("not once the daemon has been down for longer than a quarter of an hour", async () => {
    const turns = await store();
    cut(turns);
    expect(turnsToResume({ recovered: [], turns, now: Date.now() + 16 * MINUTE })).toEqual([]);
  });

  test("not a turn that was itself taking one up — a turn that crashes the daemon would restart it for ever", async () => {
    const turns = await store();
    cut(turns, "814", "resume:turn_earlier");
    expect(turnsToResume({ recovered: [], turns, now: Date.now() })).toEqual([]);
  });

  test("not one a boot in the same quarter of an hour already took up — two restarts in a row", async () => {
    const turns = await store();
    const id = cut(turns);
    turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814", prompt: "[system] carry on", messageId: `resume:${id}` });
    expect(turnsToResume({ recovered: [], turns, now: Date.now() })).toEqual([]);
  });

  test("not a scheduled job's own turn in the chat whose history it keeps — the schedule runs it again (0.7.11)", async () => {
    const turns = await store();
    const id = turns.begin({ sessionId: "ses_nouva:telegram:nouva:814", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814", prompt: "send the daily report", cause: { via: SCHEDULED, job: "job_1" } });
    turns.finish(id, { status: "interrupted", error: "restart" });
    expect(turnsToResume({ recovered: [], turns, now: Date.now() })).toEqual([]);
  });

  test("not a cron run's, nor a turn that finished", async () => {
    const turns = await store();
    cut(turns, "cron:job_1");
    const done = turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814", prompt: "hi" });
    turns.finish(done, { status: "done", reply: "hello" });
    expect(turnsToResume({ recovered: [], turns, now: Date.now() })).toEqual([]);
  });

  test("one lost in a crash, by when its journal stopped — not by when this boot closed it", async () => {
    const turns = await store();
    const recent = cut(turns);
    const stale = cut(turns, "815");
    const recovered = [
      { turnId: recent, kind: "chat" as const, report: "⚠️ …", cutAt: Date.now() - 2 * MINUTE },
      { turnId: stale, kind: "chat" as const, report: "⚠️ …", cutAt: Date.now() - 3 * 60 * MINUTE },
    ];
    expect(turnsToResume({ recovered, turns, now: Date.now() }).map((turn) => turn.id)).toEqual([recent]);
  });
});

test("the turn that takes one up is marked, so the next boot will not take it up again", async () => {
  // One attempt: nothing answers the provider here, and the real backoff is half a minute.
  const bench = await pipelineBench({ maxAttempts: 1, gateway: new FakeGateway("telegram:nouva") });
  cleanup.push(bench.dispose);
  const { pipeline, turns, db } = bench;

  const id = cut(turns);
  const [turn] = turnsToResume({ recovered: [], turns, now: Date.now() });
  expect(pipeline.resumeTurn(turn!)).toBe(true);
  await pipeline.idle();

  const taken = db.prepare<{ message_id: string; prompt: string }>("SELECT message_id, prompt FROM turn_records WHERE id != ?").get(id);
  expect(taken?.message_id).toBe(`resume:${id}`);
  expect(taken?.prompt).toContain('working on "deploy the site"');
  // Cut off in turn, it is not taken up a second time.
  db.prepare("UPDATE turn_records SET status = 'interrupted', ended_at = ? WHERE id != ?").run(Date.now(), id);
  db.prepare("UPDATE turn_records SET status = 'done' WHERE id = ?").run(id);
  expect(turnsToResume({ recovered: [], turns, now: Date.now() })).toEqual([]);
});
