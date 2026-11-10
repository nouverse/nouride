/**
 * `/status` says how much work runs at once and who decided it: the helpers each agent may have in the background and
 * the missions on the box, each a setting or the machine's. `nouride doctor` prints it from here, since the daemon is
 * what knows the machine as it was read at boot.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";
import type { Machine } from "@/commons/machine.ts";

const GiB = 1024 ** 3;
const TOKEN = "control-token-for-tests-0000000000";

/** Everything the route asks for that this test does not look at answers with nothing. */
const anything: unknown = new Proxy(function () {}, { get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : anything), apply: () => anything });

/** `/status` on `machine`, with `agents` agents on, after `configure` changed the defaults. */
async function atOnce(machine: Machine, agents: number, configure: (config: typeof DEFAULT_CONFIG) => void = () => {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  configure(config);
  const on = Array.from({ length: agents }, (_, at) => ({ config: { id: `agent-${at}` } }));
  const app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, machine, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
    token: TOKEN,
    registry: { all: () => [], status: () => "running", loadFailures: () => [], enabled: () => on, get: () => undefined } as unknown as AgentRegistry,
    pipeline: anything,
    providers: anything,
    approvals: anything,
  } as unknown as ControlDeps);
  const response = await app.request("/api/control/status", { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });
  return ((await response.json()) as { atOnce: unknown }).atOnce;
}

describe("how much work runs at once, on /status", () => {
  test("nothing set: both follow the machine, said as the machine's, with the machine in words", async () => {
    expect(await atOnce({ cores: 6, memoryBytes: 8 * GiB, commandsBytes: 6041 * 1024 ** 2 }, 6)).toEqual({
      machine: "6 cores, 8.0GB of memory (5.9GB of it for the agents' commands)",
      helpers: { limit: 4, auto: true },
      missions: { limit: 4, auto: true },
    });
    // A small box: one of each.
    expect(await atOnce({ cores: 4, memoryBytes: 2 * GiB }, 6)).toMatchObject({ helpers: { limit: 1, auto: true }, missions: { limit: 1, auto: true } });
    // Room for four missions, and two agents to run them: two.
    expect(await atOnce({ cores: 16, memoryBytes: 64 * GiB }, 2)).toMatchObject({ helpers: { limit: 4, auto: true }, missions: { limit: 2, auto: true } });
  });

  test("a number set in the config is the one in force on any machine, and said as set", async () => {
    const set = await atOnce({ cores: 4, memoryBytes: 2 * GiB }, 6, (config) => {
      config.delegate.maxBackground = 3;
      config.missions.maxRunning = 5;
    });
    expect(set).toMatchObject({ helpers: { limit: 3, auto: false }, missions: { limit: 5, auto: false } });
    const off = await atOnce({ cores: 16, memoryBytes: 64 * GiB }, 6, (config) => {
      config.delegate.maxBackground = 0;
    });
    expect(off).toMatchObject({ helpers: { limit: 0, auto: false }, missions: { limit: 4, auto: true } });
  });
});
