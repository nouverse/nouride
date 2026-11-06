/**
 * The stamp in a snapshot's name, written by every backup and read back by the database's rotation and the vault's.
 * One format: a reader that disagreed with a writer would keep the wrong snapshots, quietly.
 */

import { describe, expect, test } from "bun:test";
import { snapshotStamp, snapshotTakenAt } from "../src/index.ts";

describe("a snapshot's stamp", () => {
  const at = Date.UTC(2026, 9, 17, 9, 30, 5, 750);

  test("is sortable and to the second, in UTC", () => {
    expect(snapshotStamp(at)).toBe("2026-10-17-09-30-05");
    expect([snapshotStamp(at + 60_000), snapshotStamp(at)].sort()).toEqual([snapshotStamp(at), snapshotStamp(at + 60_000)]);
  });

  test("reads back to the second it was written at, after the prefix a name carries", () => {
    expect(snapshotTakenAt(snapshotStamp(at))).toBe(Date.UTC(2026, 9, 17, 9, 30, 5));
    expect(snapshotTakenAt(`nouride-${snapshotStamp(at)}-before-0.7.10.db`, "nouride-")).toBe(Date.UTC(2026, 9, 17, 9, 30, 5));
  });

  test("a name without one, or with another prefix, is null rather than a guess", () => {
    expect(snapshotTakenAt("notes.md")).toBeNull();
    expect(snapshotTakenAt(`vault-${snapshotStamp(at)}`, "nouride-")).toBeNull();
  });
});
