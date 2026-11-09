/**
 * A tool that can say its arguments are wrong (`Tool.checkArguments` — an MCP tool, against its server's schema) is
 * asked before the gate, the way arguments that are not one JSON object are answered.
 *
 * Asked after, a gated call was put to a person, approved, and failed — and the corrected call asked them again.
 */

import { describe, expect, test } from "bun:test";
import type { Tool, ToolCall } from "@nouride/shared";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { fakeAgent } from "../helpers.ts";
import { argumentProblems } from "@nouride/mcp";

/** One gated tool whose arguments must hold `title`, run once with `args`: what happened, and who was asked. */
async function call(args: Record<string, unknown>) {
  const asked: string[] = [];
  let ran = false;
  const tool: Tool = {
    requiresApproval: true,
    definition: { name: "github__create_issue", description: "opens an issue", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    checkArguments: (given) => (typeof given.title === "string" ? undefined : 'The arguments for github__create_issue do not match: "title" is required'),
    async execute() {
      ran = true;
      return { content: "opened #12", isError: false };
    },
  };
  const toolset = {
    definitions: [tool.definition],
    get: (name: string) => (name === tool.definition.name ? tool : undefined),
    requiresApproval: () => true,
    parallelSafe: () => false,
    gate: () => ({ action: "ask" as const, grantable: true, reason: "create_issue runs on the external MCP server" }),
    blockedPatterns: [],
  };
  const approvals = {
    canAsk: () => true,
    request: async (ask: { tool: string }) => {
      asked.push(ask.tool);
      return { status: "approved" as const, by: "gading", decision: "allow-once" as const };
    },
  };
  const caller = new ToolCaller({ approvals, approvalLevel: () => "careful" } as unknown as ExecutorDeps);
  const req = { toolset, agent: fakeAgent(), sessionId: "s", chatId: "c", gateway: "telegram", gatewayId: "telegram:main", senderId: "u", chatType: "dm" } as unknown as TurnRequest;
  const result = await caller.run(req, { id: "c1", name: "github__create_issue", arguments: args } as ToolCall, 4_000);
  return { result, asked, ran };
}

describe("arguments the tool says are wrong", () => {
  test("are answered before the gate: nobody is asked, nothing runs, and the model reads what to fix", async () => {
    const { result, asked, ran } = await call({ body: "it fails on Tuesdays" });

    expect(result).toEqual({ content: 'The arguments for github__create_issue do not match: "title" is required', isError: true });
    expect(asked).toEqual([]);
    expect(ran).toBe(false);
  });

  test("arguments it accepts go on to the gate as before — asked, then run", async () => {
    const { result, asked, ran } = await call({ title: "flaky test" });

    expect(asked).toEqual(["github__create_issue"]);
    expect(ran).toBe(true);
    expect(result.content).toContain("opened #12");
  });
});

describe("a value sent as its text", () => {
  test("is the type the schema declares before the check reads it — a count in digits runs, it is not sent back", async () => {
    let got: unknown;
    const parameters = { type: "object", properties: { count: { type: "integer" } }, required: ["count"] };
    const tool: Tool = {
      requiresApproval: false,
      definition: { name: "store__take", description: "takes some", parameters },
      checkArguments: (given) => argumentProblems(parameters, given).join("; ") || undefined,
      async execute(args) {
        got = args.count;
        return { content: "taken", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === tool.definition.name ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => ({ action: "run" as const, via: "allowlist" }),
      blockedPatterns: [],
    };
    const caller = new ToolCaller({ approvalLevel: () => "careful" } as unknown as ExecutorDeps);
    const req = { toolset, agent: fakeAgent(), sessionId: "s", chatId: "c", gateway: "telegram", gatewayId: "telegram:main", senderId: "u", chatType: "dm" } as unknown as TurnRequest;

    const result = await caller.run(req, { id: "c1", name: "store__take", arguments: { count: "3" } } as ToolCall, 4_000);
    expect(result).toMatchObject({ content: "taken", isError: false });
    expect(got).toBe(3);

    const refused = await caller.run(req, { id: "c2", name: "store__take", arguments: { count: "three" } } as ToolCall, 4_000);
    expect(refused).toMatchObject({ isError: true, content: expect.stringContaining('"count" must be an integer') });
  });
});
