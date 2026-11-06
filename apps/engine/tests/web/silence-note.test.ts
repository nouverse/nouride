/**
 * A local message nobody answered says why, when the daemon knows: an agent addressed by name and paused was told to
 * "check routing" (0.7.11's end-to-end run, after `/stop` and a restart).
 */

import { describe, expect, test } from "bun:test";
import { silenceNote } from "@/modules/web/control/routes/conversations.ts";

function registry(paused: string[], known = ["e2e", "nox"]) {
  return { get: (id: string) => (known.includes(id) ? {} : undefined), isPaused: (id: string) => paused.includes(id) } as never;
}

describe("why nobody answered", () => {
  test("an addressed agent that is asleep is named, with how to wake it", () => {
    expect(silenceNote({ registry: registry(["e2e"]) }, "e2e")).toBe("e2e is asleep: /wake wakes it");
  });

  test("an agent that is not paused, or none addressed, is the routing hint", () => {
    expect(silenceNote({ registry: registry([]) }, "e2e")).toMatch(/check routing/);
    expect(silenceNote({ registry: registry(["e2e"]) }, undefined)).toMatch(/check routing/);
  });

  test("a name that is no agent is not called paused", () => {
    expect(silenceNote({ registry: registry(["ghost"], ["e2e"]) }, "ghost")).toMatch(/check routing/);
  });
});
