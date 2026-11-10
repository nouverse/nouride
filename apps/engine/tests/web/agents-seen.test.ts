/**
 * When the daemon first saw each agent (0.8.1): written down once — those there at a start at that start, each new one
 * when it loads — kept across restarts, and carried on each agent's row of `/status` as `since`, the order Nouride
 * Office shows agents in when there are more than it has room for.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import { AgentsSeen } from "@/commons/agents-seen.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";

const memory = () => {
  let saved: Record<string, number> = {};
  let saves = 0;
  return { file: { load: () => ({ ...saved }), save: (seen: Record<string, number>) => ((saved = { ...seen }), (saves += 1)) }, saves: () => saves };
};

describe("when each agent was first seen", () => {
  test("is written down once, kept across a restart, and a new agent comes after", () => {
    const store = memory();
    let now = 1_000;
    const first = new AgentsSeen(store.file, () => now);
    first.note(["nox", "nouva"]);
    now = 2_000;
    first.note(["nouva", "nox"]);
    expect(store.saves()).toBe(1);
    // A restart reads it back; an agent made since is seen when it loads.
    now = 5_000;
    const after = new AgentsSeen(store.file, () => now);
    after.note(["nero"]);
    expect([after.since("nouva"), after.since("nox"), after.since("nero"), after.since("ghost")]).toEqual([1_000, 1_000, 5_000, null]);
  });

  test("is on each agent's row of /status", async () => {
    // Everything the route asks for that this test does not look at answers with nothing.
    const anything: unknown = new Proxy(function () {}, { get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : anything), apply: () => anything });
    const app = new Hono();
    const token = "control-token-for-tests-0000000000";
    mountControlRoutes(app, {
      ctx: { config: { daemon: {}, llm: { defaults: {} }, security: {}, delegate: {}, missions: { perAgent: 1 } }, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
      token,
      registry: { all: () => [anything], status: () => "running", loadFailures: () => [], enabled: () => [] } as unknown as AgentRegistry,
      pipeline: anything,
      providers: anything,
      approvals: anything,
      agentsSeen: { since: () => 1_234 },
    } as unknown as ControlDeps);
    const response = await app.request("/api/control/status", { headers: { "x-nouride-token": token } }, { clientAddress: "203.0.113.10" });
    const body = (await response.json()) as { agents: { since: unknown }[] };
    expect(body.agents.map((agent) => agent.since)).toEqual([1_234]);
  });
});
