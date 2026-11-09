/**
 * `/health` names the turn journal's lost writes. A write that fails is swallowed so the turn carries on, and
 * until this the only trace was one log line: a full disk turned durable turns back into the pre-0.7 kind with
 * nothing on the probe an operator watches. An issue, not a status — the daemon still answers, and restarting it
 * empties no disk.
 */

import { describe, expect, test } from "bun:test";
import type { DaemonContext } from "@/commons/context.ts";
import { buildHealth } from "@/modules/web/health.ts";

function ctx(failures?: { count: number; lastAt: number | null }): DaemonContext {
  return {
    gateways: new Map(),
    db: { walSizeBytes: () => 0 },
    config: { daemon: { dataDir: "/tmp/nr-health" } },
    providerErrors: new Map(),
    status: "running",
    startedAt: Date.now(),
    agentCount: 1,
    ...(failures ? { journal: { failures: () => failures } } : {}),
  } as unknown as DaemonContext;
}

describe("/health and the turn journal", () => {
  test("a lost write is an issue, with how many and when the last was, and the status stays ok", () => {
    const at = Date.UTC(2026, 9, 17, 1, 2, 3);
    const health = buildHealth(ctx({ count: 3, lastAt: at }));
    expect(health.payload.issues).toEqual(["turn journal: 3 write(s) failed since start, the last at 2026-10-17T01:02:03.000Z"]);
    expect(health.payload.status).toBe("ok");
    expect(health.httpStatus).toBe(200);
  });

  test("none lost, nothing said", () => {
    expect(buildHealth(ctx({ count: 0, lastAt: null })).payload.issues).toBeUndefined();
    expect(buildHealth(ctx()).payload.issues).toBeUndefined();
  });
});
