/**
 * Which window each store is swept on, asserted at the wiring rather than in each store.
 *
 * Every store's own `sweep(days)` is correct whatever number it is handed — they were all tested
 * that way, and all of them passed while the daemon was handing two of them the wrong one. The bug
 * was never inside a store; it was in this file, and nothing was looking at it.
 *
 * What it cost: files had `[attachments] retention_days`, seven days against a thirty-day
 * transcript, so a conversation went on mentioning a screenshot for three weeks after the screenshot
 * was deleted — the index kept a ref, the ref resolved to nothing, and `attachment_read` answered
 * "no local copy and no way to fetch it again" about a file the conversation was visibly about. And
 * `llm_usage` was on the *attachment* window, which has nothing to do with what a provider call
 * cost; both wanting a number is not a reason to share one.
 *
 * So the rule is written down here: **one conversation, one lifetime.** Everything that is part of
 * what was said goes together, and a store added later cannot quietly get a window of its own
 * without this failing.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { startRetentionSweep } from "@/boot/maintenance.ts";
import { MemoryStateStore } from "@/modules/memory/memory-state.store.ts";
import { tempDir } from "../helpers.ts";

/** Distinct numbers, so a swept store can be traced back to the knob it was handed. */
const WINDOWS = {
  sessionDays: 111,
  auditDays: 222,
  jobLogDays: 333,
  toolOutputDays: 444,
  scratchpadDays: 555,
  logDays: 666,
};

function runSweepOnce() {
  const seen: Record<string, number | undefined> = {};
  const spy = (name: string, extra: Record<string, unknown> = {}) => ({
    sweep: (days?: number) => {
      seen[name] = days;
      return extra.zero === true ? 0 : 0;
    },
    ...extra,
  });

  const timer = startRetentionSweep({
    config: {
      ...DEFAULT_CONFIG,
      retention: { ...DEFAULT_CONFIG.retention, ...WINDOWS },
    } as never,
    attachments: {
      sweep: (days: number) => {
        seen.attachments = days;
        return { removed: 0, freedBytes: 0 };
      },
    } as never,
    usage: spy("usage") as never,
    sessions: spy("sessions") as never,
    turns: spy("turns") as never,
    chatEvents: spy("chatEvents") as never,
    roomMessages: spy("roomMessages") as never,
    attachmentIndex: spy("attachmentIndex") as never,
    jobs: { sweepLogs: (days: number) => ((seen.jobs = days), 0) } as never,
    spill: spy("spill") as never,
    uploads: { sweep: () => ((seen.uploads = -1), 0) } as never,
    audit: spy("audit") as never,
    approvals: spy("approvals") as never,
    logs: spy("logs") as never,
    cron: { sweepRuns: () => undefined } as never,
    drafts: spy("drafts") as never,
    memoryChanges: { sweepChanges: () => ((seen.memoryChanges = -1), 0) },
    missions: spy("missions") as never,
  });
  clearInterval(timer);
  return seen;
}

describe("one conversation, one lifetime", () => {
  /**
   * Everything that is part of what was said. A transcript, the turns and steps under it, a room's
   * events and messages, the index of its files — and the file bytes themselves, because a photo
   * somebody sent is not a separate thing from the sentence it arrived with.
   */
  const CHAT_STORES = [
    "sessions",
    "turns",
    "chatEvents",
    "roomMessages",
    "attachmentIndex",
    "attachments",
    // An ended mission's record: its page is its conversation's, and outliving it opened onto turns gone (0.8.0).
    "missions",
  ];

  test("every chat store is swept on `[retention] session_days`", () => {
    const seen = runSweepOnce();
    for (const store of CHAT_STORES) {
      expect(seen[store]).toBe(WINDOWS.sessionDays);
    }
  });

  test("and nothing that is not a conversation is on that window", () => {
    /**
     * The other direction, and the reason this is two tests. Unifying by making *everything* use one
     * number would satisfy the first assertion and be wrong: a spilled tool result is read within
     * the turn or the one after it, and keeping thirty days of multi-megabyte tool output is disk
     * spent on nothing.
     */
    const seen = runSweepOnce();
    expect(seen.usage).toBe(WINDOWS.auditDays);
    expect(seen.audit).toBe(WINDOWS.auditDays);
    expect(seen.approvals).toBe(WINDOWS.auditDays);
    expect(seen.drafts).toBe(WINDOWS.auditDays);
    expect(seen.logs).toBe(WINDOWS.logDays);
    expect(seen.jobs).toBe(WINDOWS.jobLogDays);
    expect(seen.spill).toBe(WINDOWS.toolOutputDays);
  });
});

describe("memory's change feed", () => {
  /**
   * Ninety days, said in the design and the dashboard — and true only on an install that kept writing: the one
   * `DELETE` ran inside `recordChanges`, relative to the change being written. On a quiet one nothing new was written,
   * so nothing old was ever let go.
   */
  test("is swept by the daily sweep, not only when a change is written", async () => {
    expect(runSweepOnce().memoryChanges).toBe(-1);

    const dir = tempDir("memory-changes");
    const db = await openAndMigrate(join(dir, "test.db"));
    try {
      const state = new MemoryStateStore(db);
      const DAY = 86_400_000;
      const now = Date.UTC(2026, 9, 17);
      // One batch, the last change written ten days ago: what it pruned as it was written is past a hundred days.
      state.recordChanges([99, 95, 10].map((ago) => ({ at: now - ago * DAY, subject: "gading", change: "added" as const, text: `${ago} days ago`, cause: "pass" as const })));
      expect(state.changes({ limit: 10 })).toHaveLength(3);
      expect(state.sweepChanges(now)).toBe(2);
      expect(state.changes({ limit: 10 }).map((change) => change.text)).toEqual(["10 days ago"]);
    } finally {
      db.close();
      removePath(dir);
    }
  });
});

describe("what a fresh install gets", () => {
  test("a month of conversation, a month of audit", () => {
    // Thirty rather than the ninety it was: the ninety-day reasoning was about the audit log and got
    // applied to the transcript by proximity, where it buys less and costs more.
    expect(DEFAULT_CONFIG.retention.sessionDays).toBe(30);
    expect(DEFAULT_CONFIG.retention.auditDays).toBe(30);
  });

  test("three days of background job output, as of the daemon log (0.8.12, the owner's word; it was fourteen)", () => {
    expect(DEFAULT_CONFIG.retention.jobLogDays).toBe(3);
    // And the scheduler's run history, on the owner's next word.
    expect(DEFAULT_CONFIG.cron.runRetentionDays).toBe(3);
  });

  test("and the attachments section has no window of its own to disagree with", () => {
    expect("retentionDays" in DEFAULT_CONFIG.attachments).toBe(false);
  });
});
