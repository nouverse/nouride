/**
 * `/health` names the packs that failed to load.
 *
 * Found in the 0.7.7 → 0.7.10 upgrade run: a daemon whose one pack had failed answered `ok` with `agents: 0` — to
 * Docker's healthcheck, the update's confirmation and a monitoring probe alike — and nothing on the probe said which.
 * Named now, and live, so a pack fixed and reloaded leaves it at once. Reported, not failed: the status and the code
 * stay as they were, because an update that rolled back over it could not undo the migration it already ran.
 */

import { describe, expect, test } from "bun:test";
import type { DaemonContext } from "@/commons/context.ts";
import { buildHealth } from "@/modules/web/health.ts";

function ctx(agents?: { active(): number; failed(): string[] }): DaemonContext {
  return {
    gateways: new Map(),
    db: { walSizeBytes: () => 0 },
    config: { daemon: { dataDir: "/tmp/nr-health" } },
    providerErrors: new Map(),
    status: "running",
    startedAt: Date.now(),
    agentCount: 1,
    ...(agents ? { agents } : {}),
  } as unknown as DaemonContext;
}

describe("/health and the packs that did not load", () => {
  test("each is named, and the daemon is still ok, with a 200 — reported, not failed", () => {
    const health = buildHealth(ctx({ active: () => 0, failed: () => ["e2e"] }));
    expect(health.payload).toMatchObject({ status: "ok", agents: 0, failedAgents: ["e2e"] });
    expect(health.httpStatus).toBe(200);
  });

  test("read live: a pack fixed and reloaded is counted, and named no more", () => {
    let loaded = 0;
    let failed = ["e2e"];
    const daemon = ctx({ active: () => loaded, failed: () => failed });
    expect(buildHealth(daemon).payload).toMatchObject({ agents: 0, failedAgents: ["e2e"] });
    loaded = 1;
    failed = [];
    const after = buildHealth(daemon).payload;
    expect(after.agents).toBe(1);
    expect(after).not.toHaveProperty("failedAgents");
  });

  test("none failed, nothing said — and a context without the registry still counts what it was given", () => {
    expect(buildHealth(ctx()).payload).not.toHaveProperty("failedAgents");
    expect(buildHealth(ctx()).payload.agents).toBe(1);
  });
});

describe("/health and agents' own users (0.8.0)", () => {
  test("says how the daemon runs its agents' commands, so doctor can tell a socket gone from a host without one", () => {
    const daemon = { ...ctx(), agentUsers: { through: "socket" as const, reason: "each agent's commands run as its own user (nr-<agent>)" } } as DaemonContext;
    expect(buildHealth(daemon).payload.agentUsers).toEqual({ through: "socket", reason: "each agent's commands run as its own user (nr-<agent>)" });
    expect(buildHealth(ctx()).payload).not.toHaveProperty("agentUsers");
  });
});
