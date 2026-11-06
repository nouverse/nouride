/**
 * The daemon's hint under `careful` (SIMPLIFY RFC §7.5): after five questions in a day, at most once a day per person,
 * never once they have moved, naming `balanced` and where it is set — and never `trusted`.
 */

import { describe, expect, test } from "bun:test";
import { approvalPrompt } from "@/commons/notify.ts";
import { CarefulHints, carefulHintText } from "@/modules/tools/careful-hint.ts";

const DAY = 24 * 60 * 60_000;

function hints(start = Date.UTC(2026, 9, 24, 3)) {
  let now = start;
  const counter = new CarefulHints({ timeZone: () => "UTC", now: () => now });
  return { counter, later: (ms: number) => void (now += ms) };
}

const daemon = { level: "careful", source: "daemon" } as const;

describe("when the hint is said", () => {
  test("on the fifth question of a day, and not again that day", () => {
    const { counter } = hints();
    const said = Array.from({ length: 8 }, () => counter.next("telegram:main\u0000u1", daemon));
    expect(said.map((hint) => hint !== null)).toEqual([false, false, false, false, true, false, false, false]);
  });

  test("per person: another person's questions count for them alone", () => {
    const { counter } = hints();
    for (let i = 0; i < 4; i += 1) counter.next("u1", daemon);
    expect(counter.next("u2", daemon)).toBeNull();
    expect(counter.next("u1", daemon)).not.toBeNull();
  });

  test("a new day counts from nothing again", () => {
    const { counter, later } = hints();
    for (let i = 0; i < 5; i += 1) counter.next("u1", daemon);
    later(DAY);
    const nextDay = Array.from({ length: 5 }, () => counter.next("u1", daemon));
    expect(nextDay.filter(Boolean)).toHaveLength(1);
    expect(nextDay[4]).not.toBeNull();
  });

  test("never above careful, and never once the person set a level themselves", () => {
    const { counter } = hints();
    for (const resolution of [{ level: "balanced", source: "daemon" }, { level: "careful", source: "person" }] as const) {
      expect(Array.from({ length: 6 }, () => counter.next(`u-${resolution.source}-${resolution.level}`, resolution)).some(Boolean)).toBe(false);
    }
  });
});

describe("what it says", () => {
  test("names balanced, what balanced still asks, and where to set it — never trusted", () => {
    const fromDaemon = carefulHintText("daemon")!;
    expect(fromDaemon).toContain("`/approvals balanced`");
    expect(fromDaemon).toContain(
      "which still asks before a config.toml changes, someone is given access, this daemon stops, a stored secret is replaced, a credential leaves this machine, or its system packages change",
    );
    expect(fromDaemon).toContain("dashboard");
    // Set on the agent, a person's `/approvals` does not reach it: the Access tab does.
    const fromAgent = carefulHintText("agent")!;
    expect(fromAgent).toContain("Access tab");
    expect(fromAgent).not.toContain("/approvals");
    for (const text of [fromDaemon, fromAgent]) expect(text.toLowerCase()).not.toContain("trusted");
  });

  test("rides under the question in the daemon's prompt, and is absent when there is none", () => {
    const notice = {
      request: { id: "apr_1", agentId: "nouva", tool: "exec", params: { command: "bun test" } },
      grantable: true,
      reason: "first time this agent has run this command",
    };
    expect(approvalPrompt({ ...notice, hint: carefulHintText("daemon")! })).toContain("`/approvals balanced` stops them for you");
    expect(approvalPrompt(notice)).not.toContain("/approvals balanced");
  });
});

describe("how it reaches the question", () => {
  test("the executor asks for it only when a person is actually asked, and hands it to the approval", async () => {
    const { ToolCaller } = await import("@/modules/llm/executor/tool-caller.ts");
    const { fakeAgent } = await import("../helpers.ts");
    const counted: string[] = [];
    const asks: { hint?: string }[] = [];
    const tool = {
      requiresApproval: true,
      definition: { name: "exec", description: "runs a command", parameters: { type: "object", properties: {} } },
      execute: async () => ({ content: "ran", isError: false }),
    };
    const run = async (level: "careful" | "balanced", gate: object) => {
      const caller = new ToolCaller({
        approvalLevel: () => level,
        carefulHint: () => (counted.push(level), "_the hint_"),
        approvals: { request: async (ask: { hint?: string }) => (asks.push(ask), { status: "denied" as const }) },
      } as never);
      const toolset = { definitions: [tool.definition], get: () => tool, requiresApproval: () => true, parallelSafe: () => false, gate: () => gate, blockedPatterns: [] };
      const req = { toolset, agent: fakeAgent(), sessionId: "s", chatId: "c", gateway: "telegram", gatewayId: "telegram:main", senderId: "u", chatType: "dm" };
      await caller.run(req as never, { id: "c1", name: "exec", arguments: {} }, 4_000);
    };
    await run("careful", { action: "ask", grantable: true, reason: "new" });
    // Answered by the level, nobody is asked — and nothing is counted.
    await run("balanced", { action: "ask", grantable: true, reason: "new" });
    expect(counted).toEqual(["careful"]);
    expect(asks.map((ask) => ask.hint)).toEqual(["_the hint_"]);
  });
});
