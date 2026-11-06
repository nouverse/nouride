/**
 * The recent log, in memory.
 *
 * Exists because the journal is not everywhere: every debugging step on this project has gone through
 * `journalctl -u nouride`, which works only under systemd and never remotely. Docker, macOS launchd and
 * an LXC without systemd each have something else or nothing.
 *
 * What it must never do is become the reason an incident gets worse, which is why the tests below are
 * mostly about staying bounded.
 */

import { describe, expect, test } from "bun:test";
import type { LogEntry } from "@nouride/shared";
import { LogBuffer } from "@/commons/log-buffer.ts";

const entry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: "2026-08-18T10:00:00.000Z",
  level: "info",
  component: "pipeline",
  message: "something happened",
  ...overrides,
});

describe("staying bounded", () => {
  test("keeps only the newest entries once full", () => {
    // A daemon that logs its way out of memory during an incident is the one thing this must not do,
    // and an incident is exactly when log volume spikes.
    const buffer = new LogBuffer(10);
    for (let i = 1; i <= 50; i++) buffer.record(entry({ message: `line ${i}` }));

    const all = buffer.query({ limit: 100 });
    expect(all).toHaveLength(10);
    expect(all[0]?.message).toBe("line 41");
    expect(all.at(-1)?.message).toBe("line 50");
  });

  test("reports the oldest sequence it still holds", () => {
    // So a follower can tell it has fallen behind rather than reading a gap as a quiet period.
    const buffer = new LogBuffer(10);
    for (let i = 1; i <= 50; i++) buffer.record(entry());

    expect(buffer.oldestSeq()).toBe(41);
    expect(buffer.latestSeq()).toBe(50);
  });
});

describe("reading it back", () => {
  test("newest last, which is the order a person reads a log in", () => {
    const buffer = new LogBuffer(10);
    buffer.record(entry({ message: "first" }));
    buffer.record(entry({ message: "second" }));

    expect(buffer.query().map((e) => e.message)).toEqual(["first", "second"]);
  });

  test("filters by level, inclusive of everything above it", () => {
    const buffer = new LogBuffer(10);
    buffer.record(entry({ level: "debug", message: "d" }));
    buffer.record(entry({ level: "info", message: "i" }));
    buffer.record(entry({ level: "warn", message: "w" }));
    buffer.record(entry({ level: "error", message: "e" }));

    expect(buffer.query({ minLevel: "warn" }).map((e) => e.message)).toEqual(["w", "e"]);
  });

  test("filters by component", () => {
    const buffer = new LogBuffer(10);
    buffer.record(entry({ component: "gateway.telegram:bot", message: "gw" }));
    buffer.record(entry({ component: "pipeline", message: "pl" }));

    expect(buffer.query({ component: "pipeline" }).map((e) => e.message)).toEqual(["pl"]);
  });

  test("`since` returns only what a follower has not seen", () => {
    const buffer = new LogBuffer(10);
    buffer.record(entry({ message: "old" }));
    const seen = buffer.latestSeq();
    buffer.record(entry({ message: "new" }));

    expect(buffer.query({ since: seen }).map((e) => e.message)).toEqual(["new"]);
  });

  test("`since` past the end is empty, not everything", () => {
    // A follower that restarts with a stale high sequence must not be handed the whole buffer.
    const buffer = new LogBuffer(10);
    buffer.record(entry());

    expect(buffer.query({ since: 9999 })).toEqual([]);
  });

  test("limit takes the newest, not the oldest", () => {
    const buffer = new LogBuffer(10);
    for (let i = 1; i <= 5; i++) buffer.record(entry({ message: `line ${i}` }));

    expect(buffer.query({ limit: 2 }).map((e) => e.message)).toEqual(["line 4", "line 5"]);
  });
});
