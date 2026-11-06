/**
 * An approval level answers a call by itself, whether or not anyone could have been asked.
 *
 * "Nobody to ask" used to be a refusal and nothing more, decided before the level was consulted. An agent
 * set to never ask had its `sudo` refused while every chat was disconnected and no dashboard was open, and
 * the same call ran the moment a dashboard polled for approvals — though nobody was asked either way.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalLevel, GateAsk, GateDecision, Tool, ToolCall } from "@nouride/shared";
import { UnattendedApprovalGate } from "@/modules/cron/approval.ts";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { fakeAgent } from "../helpers.ts";

/** What `exec`'s gate says for a command on the fixed list when no chat is connected and no dashboard is open. */
function nobodyToAsk(hardlineClass: GateAsk["hardlineClass"]): GateDecision {
  return {
    action: "refuse",
    reason: "needs approval (it is on the list) and there is nobody to ask right now",
    unasked: { action: "ask", grantable: false, hardline: true, ...(hardlineClass ? { hardlineClass } : {}), reason: "it is on the list" },
  };
}

async function callWith(level: ApprovalLevel, decision: GateDecision, deps: Partial<ExecutorDeps> = {}): Promise<{ ran: boolean; content: string }> {
  let ran = false;
  const tool: Tool = {
    requiresApproval: false,
    definition: { name: "exec", description: "runs a command", parameters: { type: "object", properties: {} } },
    async execute() {
      ran = true;
      return { content: "ran", isError: false };
    },
  };
  const toolset = {
    definitions: [tool.definition],
    get: (name: string) => (name === "exec" ? tool : undefined),
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => decision,
    blockedPatterns: [],
  };
  const caller = new ToolCaller({ approvalLevel: () => level, ...deps } as unknown as ExecutorDeps);
  const req = { toolset, agent: fakeAgent(), sessionId: "s", chatId: "c", gateway: "telegram", gatewayId: "telegram:main", senderId: "u", chatType: "dm" } as unknown as TurnRequest;
  const call: ToolCall = { id: "c1", name: "exec", arguments: {} };
  const result = await caller.run(req, call, 4_000);
  return { ran, content: result.content };
}

describe("with nobody to ask", () => {
  test("never ask runs it — nobody would have been asked anyway", async () => {
    expect(await callWith("trusted", nobodyToAsk("stop"))).toEqual({ ran: true, content: "ran" });
  });

  test("ask as configured still refuses: that level wants a person, and there is none", async () => {
    const outcome = await callWith("careful", nobodyToAsk("delete"));
    expect(outcome.ran).toBe(false);
    expect(outcome.content).toContain("nobody to ask");
  });

  test("balanced answers what it does not ask: a delete runs, the daemon stopped still needs a person", async () => {
    expect((await callWith("balanced", nobodyToAsk("delete"))).ran).toBe(true);
    expect((await callWith("balanced", nobodyToAsk(undefined))).ran).toBe(true);
    expect((await callWith("balanced", nobodyToAsk("stop"))).ran).toBe(false);
  });

  test("a scheduled run's ask is refused at once, and the model is told nobody was there — never that a human denied it", async () => {
    // Found on the live box (0.8.0): a job's send_message to another chat came back "A human denied this call".
    const outcome = await callWith("balanced", { action: "ask", grantable: false, hardline: true, hardlineClass: "unwatched", reason: "it sends elsewhere" }, { approvals: new UnattendedApprovalGate() });
    expect(outcome.ran).toBe(false);
    expect(outcome.content).toStartWith('"exec" needs approval and this is a scheduled run, so there is nobody to ask. Reason: it sends elsewhere.');
    expect(outcome.content).not.toContain("A human denied");
  });

  test("a refusal that does not depend on who is asked stays refused, whatever the level", async () => {
    expect((await callWith("trusted", { action: "refuse", reason: "blocked by this agent's configuration" })).ran).toBe(false);
  });
});
