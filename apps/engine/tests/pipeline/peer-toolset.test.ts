/**
 * Whether `ask_agent` is offered, which is a question about the daemon and not about the pack.
 *
 * The rule and the reason are in `resolveToolset`. What is pinned here is the live failure that
 * produced it: the tool was reachable only through `DEFAULT_TOOLS`, which applies to a pack that says
 * nothing about tools — and every pack on the box enumerated its own list. So the prompt told the
 * agent to call `ask_agent`, the schema did not carry it, and the model spent its reasoning looking
 * for the tool before settling for `delegate`, which runs a helper as *itself*. The other agent was
 * never involved and the answer came back as though it had been.
 */

import { describe, expect, test } from "bun:test";
import type { SecuritySection, Tool } from "@nouride/shared";
import { createAskAgentTool } from "@/modules/tools/builtins/ask-agent.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent } from "../helpers.ts";

const security = {
  toolTimeoutMs: 30_000,
  toolMaxOutputBytes: 1_000_000,
  exec: { mode: "full", ask: "off", allowed: [], blocked: [], ceiling: "full" },
} as unknown as SecuritySection;

const registry = (): Map<string, Tool> =>
  new Map([
    [
      "ask_agent",
      createAskAgentTool({
        peers: () => ["nox"],
        run: async () => ({
          agentId: "nox",
          status: "success",
          summary: "",
          files: [],
          spills: [],
          metrics: { toolCalls: 0, steps: 0, ms: 0 },
        }),
      }),
    ],
  ]);

/** A pack that writes its tool list out in full — which is what every real pack here does. */
const enumeratingPack = () =>
  fakeAgent({
    config: { tools: { enabled: ["read", "delegate"], approvalRequired: [], blocked: [] } } as never,
  });

describe("ask_agent follows the daemon, not the pack", () => {
  test("a pack that enumerates its tools still gets it when there is somebody to ask", () => {
    const toolset = resolveToolset(enumeratingPack(), registry(), security, {
      peerAgents: () => ["nox"],
    });

    expect(toolset.definitions.map((d) => d.name)).toContain("ask_agent");
    expect(toolset.get("ask_agent")).toBeDefined();
  });

  test("withdrawn when the daemon has nobody else on it", () => {
    // A tool in the schema is a promise the model will try to keep, and on a single-agent install
    // this one's every call would answer "there are none".
    const toolset = resolveToolset(enumeratingPack(), registry(), security, {
      peerAgents: () => [],
    });

    expect(toolset.definitions.map((d) => d.name)).not.toContain("ask_agent");
    expect(toolset.get("ask_agent")).toBeUndefined();
  });

  test("a pack that named it does not keep it once there is nobody to ask", () => {
    // The list is not the authority in either direction. An operator who disabled the other agents
    // has not left this one a bus it can still call.
    const listedIt = fakeAgent({
      config: { tools: { enabled: ["read", "ask_agent"], approvalRequired: [], blocked: [] } } as never,
    });
    const toolset = resolveToolset(listedIt, registry(), security, { peerAgents: () => [] });

    expect(toolset.definitions.map((d) => d.name)).not.toContain("ask_agent");
  });

  test("no peer source at all — a bare toolset gets nothing", () => {
    // The shape a one-shot tool run and half the suite use. Absent means absent, not "assume yes".
    const toolset = resolveToolset(enumeratingPack(), registry(), security);

    expect(toolset.definitions.map((d) => d.name)).not.toContain("ask_agent");
  });
});

/**
 * Whether an ask may move to the background (0.7.19) — a question about the turn asking, read from the one limit a
 * turn's background work has. The parameter is offered only where it can do something: a helper's turn, a peer's and a
 * scheduled one are resolved with none, and their asks wait to the end.
 */
describe("an ask that may move to the background", () => {
  /** A registry whose `ask_agent` can start one that moves — as boot builds it — recording which way each ask went. */
  const detaching = (went: string[]): Map<string, Tool> => {
    const handoff = { agentId: "nox", status: "success" as const, summary: "done", files: [], spills: [], metrics: { toolCalls: 0, steps: 0, ms: 0 } };
    return new Map([
      [
        "ask_agent",
        createAskAgentTool({
          peers: () => ["nox"],
          run: async () => (went.push("waited to the end"), handoff),
          start: () => (went.push("may move"), { run: { answer: Promise.resolve(handoff), detach: () => ({ answered: true as const }) } }),
        }),
      ],
    ]);
  };
  const params = (toolset: ReturnType<typeof resolveToolset>) =>
    Object.keys((toolset.definitions.find((d) => d.name === "ask_agent")!.parameters as { properties: object }).properties);
  const ctx = { agentId: "nouva", chatId: "c", gatewayId: "web:dashboard", signal: new AbortController().signal } as never;

  test("where the turn may hold background work: offered, with `background`", async () => {
    const went: string[] = [];
    const toolset = resolveToolset(enumeratingPack(), detaching(went), security, { peerAgents: () => ["nox"], backgroundHelpers: () => 2 });
    expect(params(toolset)).toEqual(["agent", "task", "asks", "tier", "background"]);
    await toolset.get("ask_agent")!.execute({ agent: "nox", task: "check the build" }, ctx);
    expect(went).toEqual(["may move"]);
  });

  test("where it may hold none — a helper's, a peer's, a scheduled turn, or a limit of 0: no `background`, and the ask waits to the end", async () => {
    const went: string[] = [];
    const toolset = resolveToolset(enumeratingPack(), detaching(went), security, { peerAgents: () => ["nox"], backgroundHelpers: () => 0 });
    expect(params(toolset)).toEqual(["agent", "task", "asks", "tier"]);
    // Sent anyway, it is not heard: nothing in this turn can move behind it.
    await toolset.get("ask_agent")!.execute({ agent: "nox", task: "check the build", background: true }, ctx);
    expect(went).toEqual(["waited to the end"]);
  });
});
