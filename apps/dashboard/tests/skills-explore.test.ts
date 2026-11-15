/**
 * Skills' Explore tab: what its list is called and the line under it, from where the daemon says the list is from:
 * Nouverse's catalog, or the public lists themselves when the catalog is off or does not answer.
 */

import { describe, expect, test } from "bun:test";
import { listLabel, listLine } from "@/modules/skills/explore.panel";

describe("the list's name", () => {
  test("is Nouverse's picks before a search, ClawHub's most used when Nouverse's is not there, and the words after one", () => {
    expect(listLabel("catalog", "")).toBe("Nouverse's picks");
    expect(listLabel("hubs", "")).toBe("Most used on ClawHub");
    // A daemon from before the catalog says nothing of where its list is from: it asked ClawHub.
    expect(listLabel(undefined, "")).toBe("Most used on ClawHub");
    expect(listLabel("catalog", "pdf")).toBe("Matching “pdf”");
    expect(listLabel("hubs", "pdf")).toBe("Matching “pdf”");
  });
});

describe("the line under it", () => {
  const at = Date.parse("2026-11-15T02:00:00Z");
  test("says what the list is and how fresh Nouverse's copy is; nothing where the public lists answered themselves", () => {
    expect(listLine(undefined, false)).toBe("");
    expect(listLine({ from: "hubs" }, true)).toBe("");
    expect(listLine({ from: "catalog", total: 41000, syncedAt: "2026-11-15T02:00:00Z" }, false, at + 3 * 3_600_000)).toBe("Nouverse's picks first, from Nouverse's list of public skills, updated 3 h ago.");
    expect(listLine({ from: "catalog", total: 1302, syncedAt: "2026-11-15T02:00:00Z" }, true, at + 3 * 3_600_000)).toBe("1,302 matches in Nouverse's list of public skills, updated 3 h ago.");
    expect(listLine({ from: "catalog", total: 1, syncedAt: null }, true)).toBe("1 match in Nouverse's list of public skills.");
  });
});
