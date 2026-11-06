/**
 * `/health` says whether this daemon is a paired Box.
 *
 * The same Pro edition runs on a Box and in a pod since 2026-09-30, so the edition cannot answer it —
 * and the dashboard shows My Box from this field, where there is a box to show.
 */

import { describe, expect, test } from "bun:test";
import type { DaemonContext } from "@/commons/context.ts";
import { buildHealth } from "@/modules/web/health.ts";

function ctx(appliance: unknown): DaemonContext {
  return {
    gateways: new Map(),
    db: { walSizeBytes: () => 0 },
    config: { daemon: { dataDir: "/tmp/nr-health" } },
    providerErrors: new Map(),
    status: "running",
    startedAt: Date.now(),
    agentCount: 1,
    ...(appliance ? { appliance } : {}),
  } as unknown as DaemonContext;
}

describe("/health", () => {
  test("appliance is true only where the appliance plugin is running", () => {
    expect(buildHealth(ctx(undefined)).payload.appliance).toBe(false);
    expect(buildHealth(ctx({ report: () => ({ issues: [] }) })).payload.appliance).toBe(true);
  });
});
