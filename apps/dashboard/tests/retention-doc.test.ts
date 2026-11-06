/**
 * The retention call's doc names every record the call governs (dash-practice-orphan-doc-comments).
 *
 * It said "the four things it writes down" while `RetentionScope` had five: `sessions` was added to the call and
 * not to the sentence about it. A count goes stale without anything failing, so the doc names the scopes and this
 * holds it to the type.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(import.meta.path), "..", "src", "commons", "lib", "api.logs.ts"), "utf8");

describe("the retention call's doc", () => {
  test("names each scope the call reads and sets, and counts none", () => {
    const scopes = [.../export type RetentionScope\s*=\s*([^;]+);/.exec(source)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    // The fail-open shape: no scopes read would make the check below pass on anything.
    expect(scopes).toContain("sessions");
    const doc = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*retention:/.exec(source)?.[1] ?? "";
    expect(scopes.filter((scope) => !doc.includes(`\`${scope}\``))).toEqual([]);
    expect(doc).not.toMatch(/\b(two|three|four|five|six|seven)\b/);
  });
});
