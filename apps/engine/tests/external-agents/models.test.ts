/**
 * The model an external agent runs, as lists name it (0.8.1): the pack's `[external] model`, else the CLI's own
 * default as its last session opened on it. The agent picker showed Nix, a Claude Code agent on its default, as
 * `claude-sonnet-5-5` — its `[llm]`, which answers none of its turns — and Kuro as `codex:gpt-5.6-luna`.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import type { NewSessionResult } from "@nouride/acp";
import { offeredModels, OfferedModels } from "@/modules/external-agents/models.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";

const opened = (currentValue: string, options: { value: string; name?: string; description?: string }[]) =>
  ({ sessionId: "s1", configOptions: [{ id: "model", type: "select", currentValue, options }] }) as NewSessionResult;

describe("the model a CLI's session opened on", () => {
  test("an alias is named by the model it describes itself as, where another option has that name", () => {
    // Claude Code's adapter on the live box: `default` named "Default (recommended)", described by its model's name.
    const models = offeredModels(opened("default", [
      { value: "default", name: "Default (recommended)", description: "Opus 5.5" },
      { value: "opus", name: "Opus 5.5" },
      { value: "sonnet", name: "Sonnet 5.5", description: "Opus 5.5" },
    ]));
    expect(models).toEqual([{ value: "default", name: "Default (recommended)", current: "Opus 5.5" }, { value: "opus", name: "Opus 5.5" }, { value: "sonnet", name: "Sonnet 5.5" }]);
  });

  test("any other is named by its value; one not offered is not named at all", () => {
    expect(offeredModels(opened("gpt-6-luna", [{ value: "gpt-6-luna", name: "6 Luna", description: "Latest frontier model." }, { value: "gpt-5.6-luna", name: "5.6 Luna" }]))?.[0]).toEqual({ value: "gpt-6-luna", name: "6 Luna", current: "gpt-6-luna" });
    expect(offeredModels(opened("elsewhere", [{ value: "small" }])) ).toEqual([{ value: "small" }]);
  });

  test("is kept with the models, read back after a restart, and null before a first session", () => {
    let saved: Record<string, unknown> = {};
    const file = { load: () => structuredClone(saved) as never, save: (models: Record<string, unknown>) => void (saved = structuredClone(models)) };
    const kept = new OfferedModels(file);
    expect(kept.runsOn("nix")).toBeNull();
    kept.keep("nix", offeredModels(opened("default", [{ value: "default", description: "Opus 5.5" }, { value: "opus", name: "Opus 5.5" }]))!);
    expect(new OfferedModels(file).runsOn("nix")).toBe("Opus 5.5");
  });
});

test("an external agent's row of /status carries its CLI's model: the pack's, and the default its CLI named", async () => {
  // Everything the route asks for that this test does not look at answers with nothing.
  const anything: unknown = new Proxy(function () {}, { get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : anything), apply: () => anything });
  const agent = (id: string, external: Record<string, string>) => {
    const config = new Proxy({}, { get: (_target, key) => (key === "id" ? id : key === "external" ? external : anything) });
    return new Proxy({}, { get: (_target, key) => (key === "config" ? config : anything) });
  };
  const app = new Hono();
  const token = "control-token-for-tests-0000000000";
  mountControlRoutes(app, {
    ctx: { config: { daemon: {}, llm: { defaults: {} }, security: {}, delegate: {}, missions: { perAgent: 1 } }, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
    token,
    registry: { all: () => [agent("nix", { cli: "claude-code" }), agent("kuro", { cli: "codex", model: "gpt-5.6-luna" })], status: () => "running", loadFailures: () => [], enabled: () => [] } as unknown as AgentRegistry,
    pipeline: anything,
    providers: anything,
    approvals: anything,
    externalAgents: { row: (id: string) => ({ name: id === "codex" ? "Codex" : "Claude Code" }), models: { runsOn: (id: string) => (id === "nix" ? "Opus 5.5" : "gpt-6-luna") } },
  } as unknown as ControlDeps);
  const response = await app.request("/api/control/status", { headers: { "x-nouride-token": token } }, { clientAddress: "203.0.113.10" });
  const body = (await response.json()) as { agents: { external: { name: string; model: string | null; cliDefault: string | null } }[] };
  expect(body.agents.map(({ external }) => [external.name, external.model, external.cliDefault])).toEqual([
    ["Claude Code", null, "Opus 5.5"],
    ["Codex", "gpt-5.6-luna", "gpt-6-luna"],
  ]);
});
