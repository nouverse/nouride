/**
 * An agent's effort from its Model tab (0.8.17): `POST /agents/:id/effort` writes `[llm] effort` through the setter the
 * CLI tab and `agent_configure` use, "default" taking it away; a level it does not know, or an agent that is not there,
 * writes nothing. Each agent's row of `/status` carries the effort it thinks with and the install's, which the tab reads.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import type { LoadedAgent } from "@nouride/shared";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";

const TOKEN = "control-token-for-tests-0000000000";

/** Everything a route asks for that a test does not look at answers with nothing. */
const anything: unknown = new Proxy(function () {}, { get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : anything), apply: () => anything });
/** An object that answers its own keys, and nothing for the rest. */
const filled = <T extends object>(own: T): T => new Proxy(own, { get: (target, key) => (key in target ? target[key as keyof T] : anything) });

function app() {
  const written: string[] = [];
  const nova = filled({ config: filled({ id: "nova", llm: filled({ provider: "local", model: "m", effort: "high" }) }) }) as unknown as LoadedAgent;
  const scoped = new Hono();
  mountControlRoutes(scoped, {
    ctx: { config: { daemon: {}, llm: { defaults: { effort: "medium" } }, security: {}, delegate: {}, missions: { perAgent: 1 } }, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
    token: TOKEN,
    registry: { get: (id: string) => (id === "nova" ? nova : undefined), all: () => [nova], status: () => "running", loadFailures: () => [], enabled: () => [] } as unknown as AgentRegistry,
    setup: { setEffort: async (input: { agentId: string; effort: string }) => (written.push(`${input.agentId} ${input.effort}`), { ok: true as const }) },
    pipeline: anything,
    providers: anything,
    approvals: anything,
  } as unknown as ControlDeps);
  const call = (method: string, path: string, body?: unknown) =>
    scoped.request(`/api/control${path}`, { method, headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { clientAddress: "203.0.113.10" });
  return { call, written };
}

describe("an agent's effort from its Model tab", () => {
  test("a level, or default for the install's, is written through the effort setter", async () => {
    const { call, written } = app();
    expect((await call("POST", "/agents/nova/effort", { effort: "xhigh" })).status).toBe(200);
    expect((await call("POST", "/agents/nova/effort", { effort: "default" })).status).toBe(200);
    expect(written).toEqual(["nova xhigh", "nova default"]);
  });

  test("a level it does not know, none at all, or no such agent: refused, nothing written", async () => {
    const { call, written } = app();
    const huge = await call("POST", "/agents/nova/effort", { effort: "huge" });
    expect(huge.status).toBe(400);
    expect(await huge.json()).toEqual({ error: "effort is one of low, medium, high, xhigh, max, default" });
    expect((await call("POST", "/agents/nova/effort", {})).status).toBe(400);
    expect((await call("POST", "/agents/ghost/effort", { effort: "low" })).status).toBe(404);
    expect(written).toEqual([]);
  });

  test("each agent's row of /status says the effort it thinks with and the install's", async () => {
    const { call } = app();
    const body = (await (await call("GET", "/status")).json()) as { agents: { effort: unknown; effortDefault: unknown }[] };
    expect(body.agents.map((agent) => [agent.effort, agent.effortDefault])).toEqual([["high", "medium"]]);
  });
});
