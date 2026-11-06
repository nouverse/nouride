/**
 * When a conversation's context is cleared on a schedule — `[rollover]`.
 *
 * The failure worth the file is the rollover loop: `daily` staleness asks when the *conversation*
 * began, and reading a timestamp that survives the clear makes every following message roll over
 * again. `sessions.created_at` is exactly such a timestamp, which is why `started_at` exists.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { ChatMessage, RolloverSection } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { evaluateRollover } from "@/modules/sessions/rollover.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JAKARTA = "Asia/Jakarta";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-rollover-"));
});

afterEach(() => {
  removePath(dir);
});

function turns(...pairs: [ChatMessage["role"], string][]): ChatMessage[] {
  return pairs.map(([role, content]) => ({ role, content }) as ChatMessage);
}

/** 2026-08-20 10:30 Jakarta, chosen so the UTC date is the same day and the local hour is unambiguous. */
const AT = Date.parse("2026-08-20T03:30:00Z");

describe("evaluateRollover", () => {
  const reset = (over: Partial<RolloverSection> = {}): RolloverSection => ({
    mode: "daily",
    atHour: 4,
    idleMinutes: 360,
    ...over,
  });

  test("mode none never rolls over, however old the conversation", () => {
    const decision = evaluateRollover({
      startedAt: AT - 30 * DAY,
      updatedAt: AT - 30 * DAY,
      now: AT,
      rollover: reset({ mode: "none" }),
      timezone: JAKARTA,
    });
    expect(decision.stale).toBe(false);
  });

  test("daily: a conversation begun before today's boundary is stale", () => {
    const decision = evaluateRollover({
      // Yesterday evening Jakarta time — before this morning's 04:00.
      startedAt: AT - 20 * HOUR,
      updatedAt: AT - HOUR,
      now: AT,
      rollover: reset(),
      timezone: JAKARTA,
    });
    expect(decision).toEqual({ stale: true, reason: "daily" });
  });

  test("daily: a conversation begun after the boundary is not", () => {
    const decision = evaluateRollover({
      // 09:00 Jakarta, after 04:00.
      startedAt: AT - 90 * 60_000,
      updatedAt: AT,
      now: AT,
      rollover: reset(),
      timezone: JAKARTA,
    });
    expect(decision.stale).toBe(false);
  });

  test("daily: a conversation started at 04:30 is not stale against its own 04:00 boundary", () => {
    // The boundary is truncated to the top of the local hour; without that, a conversation begun at
    // 04:30 compares against a boundary of "now minus whole hours" and rolls over immediately.
    const startedAt = Date.parse("2026-08-19T21:30:00Z"); // 04:30 Jakarta on the 20th
    const decision = evaluateRollover({
      startedAt,
      updatedAt: AT,
      now: AT,
      rollover: reset(),
      timezone: JAKARTA,
    });
    expect(decision.stale).toBe(false);
  });

  test("daily reads when the conversation began, not when it was last touched", () => {
    // Kept up all day: touched a minute ago, begun yesterday. Still stale — that is the difference
    // between `daily` and `idle`.
    const decision = evaluateRollover({
      startedAt: AT - 20 * HOUR,
      updatedAt: AT - 60_000,
      now: AT,
      rollover: reset(),
      timezone: JAKARTA,
    });
    expect(decision).toEqual({ stale: true, reason: "daily" });
  });

  test("idle reads when it was last touched, not when it began", () => {
    const stale = evaluateRollover({
      startedAt: AT - 20 * HOUR,
      updatedAt: AT - 7 * HOUR,
      now: AT,
      rollover: reset({ mode: "idle" }),
      timezone: JAKARTA,
    });
    expect(stale).toEqual({ stale: true, reason: "idle" });

    const fresh = evaluateRollover({
      // Begun days ago but answered five minutes ago: not idle.
      startedAt: AT - 5 * DAY,
      updatedAt: AT - 5 * 60_000,
      now: AT,
      rollover: reset({ mode: "idle" }),
      timezone: JAKARTA,
    });
    expect(fresh.stale).toBe(false);
  });

  test("timezone decides the boundary", () => {
    // 2026-08-20 05:00 Jakarta is 2026-08-19 22:00 UTC. A conversation begun at 03:00 Jakarta on the
    // 20th is before Jakarta's 04:00 boundary and after UTC's, so the two zones disagree — and the
    // configured one has to win, or the rollover happens in the middle of someone's evening.
    const now = Date.parse("2026-08-19T22:00:00Z");
    const startedAt = Date.parse("2026-08-19T20:00:00Z"); // 03:00 Jakarta on the 20th

    expect(
      evaluateRollover({ startedAt, updatedAt: now, now, rollover: reset(), timezone: JAKARTA }),
    ).toEqual({ stale: true, reason: "daily" });
    expect(
      evaluateRollover({ startedAt, updatedAt: now, now, rollover: reset(), timezone: "UTC" }).stale,
    ).toBe(false);
  });

  test("an unknown timezone falls back to UTC rather than throwing", () => {
    const decision = evaluateRollover({
      startedAt: AT - 30 * DAY,
      updatedAt: AT,
      now: AT,
      rollover: reset(),
      timezone: "Mars/Olympus",
    });
    expect(decision.stale).toBe(true);
  });
});

describe("started_at", () => {
  let db: SqliteDb;
  let store: SessionStore;
  const key = { agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" };

  beforeEach(async () => {
    db = await openAndMigrate(join(dir, "nouride.db"));
    store = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("clear() restarts the conversation clock while created_at survives", () => {
    store.save(key, turns(["user", "hi"], ["assistant", "hello"]), 10);
    const before = store.load(key);

    // Backdate both columns to yesterday, the way a conversation left running overnight looks.
    db.prepare("UPDATE sessions SET created_at = ?, started_at = ? WHERE id = ?").run(
      before.createdAt - DAY,
      before.startedAt - DAY,
      before.id,
    );

    store.clear(key);
    const after = store.load(key);

    // The row still dates from yesterday — that is deliberate, the dashboard shows how long a chat
    // has been running.
    expect(after.createdAt).toBe(before.createdAt - DAY);
    // The conversation does not. This is the assertion that stops the rollover loop: with
    // `started_at` left at yesterday, the very next message would be evaluated as stale again.
    expect(after.startedAt).toBeGreaterThan(after.createdAt);
  });

  test("a rolled-over conversation is not immediately stale again", () => {
    store.save(key, turns(["user", "hi"], ["assistant", "hello"]), 10);
    const seeded = store.load(key);
    db.prepare("UPDATE sessions SET created_at = ?, started_at = ? WHERE id = ?").run(
      seeded.createdAt - DAY,
      seeded.startedAt - DAY,
      seeded.id,
    );

    const stale = store.load(key);
    const policy = { mode: "daily" as const, atHour: 4, idleMinutes: 360 };
    expect(
      evaluateRollover({
        startedAt: stale.startedAt,
        updatedAt: stale.updatedAt,
        now: Date.now(),
        rollover: policy,
        timezone: JAKARTA,
      }).stale,
    ).toBe(true);

    store.clear(key);
    const fresh = store.load(key);
    expect(
      evaluateRollover({
        startedAt: fresh.startedAt,
        updatedAt: fresh.updatedAt,
        now: Date.now(),
        rollover: policy,
        timezone: JAKARTA,
      }).stale,
    ).toBe(false);
  });

  test("a save() during a conversation does not move started_at", () => {
    store.save(key, turns(["user", "hi"], ["assistant", "hello"]), 10);
    const first = store.load(key);
    db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(first.startedAt - HOUR, first.id);

    store.save(key, turns(["user", "hi"], ["assistant", "hello"], ["user", "more"]), 20);
    const second = store.load(key);

    expect(second.startedAt).toBe(first.startedAt - HOUR);
  });
});
