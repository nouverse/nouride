/**
 * The Overview's warnings: the daemon's own issues, and each pack that did not load (`health-ok-with-agents-failed`).
 *
 * A daemon whose one pack had failed showed "System Healthy" and nothing else: `/health` stays `ok` over a failed pack,
 * on purpose, so the page is where it has to be said.
 */

import { describe, expect, test } from "bun:test";
import { healthWarnings } from "@/commons/lib/health-warnings";

describe("the Overview's warnings", () => {
  test("say each pack that did not load, with how to bring it back, after the daemon's own issues", () => {
    expect(healthWarnings({ issues: ["telegram:nouva: reconnecting"], failedAgents: ["e2e"] })).toEqual([
      "telegram:nouva: reconnecting",
      "Agent e2e did not start: something in its files is wrong. Whoever runs this server needs to fix them, then reload it.",
    ]);
  });

  test("nothing to say from a daemon with none — or one older than the field", () => {
    expect(healthWarnings({})).toEqual([]);
    expect(healthWarnings({ issues: [] })).toEqual([]);
  });
});
