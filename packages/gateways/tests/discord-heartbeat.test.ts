/**
 * Discord's liveness by heartbeat (`heartbeatAlive`). Its first heartbeat comes about 41 s after Hello and the first
 * health check at 30 s, so every boot of the live box logged "health check failed" once per bot. A connection is not
 * judged before its first heartbeat was due; after that, no heartbeat answered is not alive.
 */

import { describe, expect, test } from "bun:test";
import { heartbeatAlive } from "../src/channels/discord/heartbeat.ts";

const READY = 1_000_000;

describe("a Discord connection's heartbeat", () => {
  test("one answered is alive, however old the connection", () => {
    expect(heartbeatAlive(42, READY, READY + 3_600_000)).toBe(true);
    expect(heartbeatAlive(0, READY, READY + 1)).toBe(true);
  });

  test("none answered yet, 30 s after ready — the first health check — is not judged dead", () => {
    expect(heartbeatAlive(-1, READY, READY + 30_000)).toBe(true);
  });

  test("none answered long after the first was due is not alive", () => {
    expect(heartbeatAlive(-1, READY, READY + 60_000)).toBe(false);
    expect(heartbeatAlive(-1, READY, READY + 600_000)).toBe(false);
  });

  test("not ready, no time to measure from: not alive", () => {
    expect(heartbeatAlive(-1, null, READY)).toBe(false);
  });
});
