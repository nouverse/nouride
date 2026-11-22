/**
 * `/status` carries what a connection that is not up yet waits on, for `nouride status` to print: the reason
 * as its adapter said it, and nothing for a connection that said nothing or is the daemon's own.
 */

import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
/** Everything a route asks for that a test does not look at answers with nothing. */
const anything: unknown = new Proxy(function () {}, { get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : anything), apply: () => anything });

test("each connection's row says why it waits, where it said", async () => {
  const gateways = new Map<string, unknown>([
    ["telegram:nouva", { id: "telegram:nouva", platform: "telegram", status: "connecting", waiting: { reason: "Telegram asked this bot to wait 30 minutes before it connects.", since: 1, until: 2 } }],
    ["discord:nouva", { id: "discord:nouva", platform: "discord", status: "connecting", waiting: null }],
    ["telegram:nix", { id: "telegram:nix", platform: "telegram", status: "connected" }],
    ["mission", { id: "mission", platform: "local", status: "connected", internal: true, waiting: { reason: "never shown", since: 1 } }],
  ]);
  const scoped = new Hono();
  mountControlRoutes(scoped, {
    ctx: { config: { daemon: {}, llm: { defaults: { effort: "medium" } }, security: {}, delegate: {}, missions: { perAgent: 1 } }, gateways, startedAt: Date.now(), status: "ready", providerErrors: new Map() },
    token: TOKEN,
    registry: { get: () => undefined, all: () => [], status: () => "running", loadFailures: () => [], enabled: () => [] } as unknown as AgentRegistry,
    pipeline: anything,
    providers: anything,
    approvals: anything,
    setup: anything,
  } as unknown as ControlDeps);
  const answered = await scoped.request("/api/control/status", { headers: { "x-nouride-token": TOKEN } }, { clientIp: "127.0.0.1" });
  expect(answered.status).toBe(200);
  const body = (await answered.json()) as { gateways: unknown[] };
  expect(body.gateways).toEqual([
    { id: "telegram:nouva", platform: "telegram", status: "connecting", waiting: "Telegram asked this bot to wait 30 minutes before it connects." },
    { id: "discord:nouva", platform: "discord", status: "connecting" },
    { id: "telegram:nix", platform: "telegram", status: "connected" },
  ]);
});
