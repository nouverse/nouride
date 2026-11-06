/**
 * `EVENT_EXAMPLES` is one row's `data` of every kind (`types/events.ts`) — what the stream's consumers are tested
 * against. An example the contract does not describe would test them against something no daemon writes.
 */

import { describe, expect, test } from "bun:test";
import { EVENT_EXAMPLES, EVENT_KINDS, eventProblems } from "../src/types/events.ts";

describe("the contract's examples", () => {
  test("there is one of every kind, and each is a row the contract describes", () => {
    expect(Object.keys(EVENT_EXAMPLES).sort()).toEqual([...EVENT_KINDS].sort());
    for (const [kind, data] of Object.entries(EVENT_EXAMPLES)) {
      expect({ kind, problems: eventProblems(kind, data as Record<string, unknown>) }).toEqual({ kind, problems: [] });
    }
  });
});
