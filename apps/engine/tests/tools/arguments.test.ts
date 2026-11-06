/**
 * An array argument sent as the JSON text of the array.
 *
 * Found on a live install: every `exec` refused, `pwd` included, with "ask for a shell explicitly:
 * ["bash", "-lc", "[\"pwd\"]"]" — the model was sending `{"command": "[\"pwd\"]"}`, and following
 * the advice with the same encoding reproduced the refusal forever. See `coerceArguments`.
 */

import { describe, expect, test } from "bun:test";
import type { ChatResponse, LLMProvider, Tool } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { coerceArguments } from "@/modules/tools/arguments.ts";
import { normalizeCommand } from "@/modules/tools/builtins/exec.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const EXEC_PARAMETERS = {
  type: "object",
  properties: { command: { type: "array", items: { type: "string" } }, cwd: { type: "string" } },
};

describe("coerceArguments", () => {
  test("a JSON array sent as a string becomes the array", () => {
    expect(coerceArguments({ command: '["pwd"]' }, EXEC_PARAMETERS)).toEqual({ command: ["pwd"] });
    expect(coerceArguments({ command: ' ["bash", "-lc", "ls | wc -l"] ' }, EXEC_PARAMETERS)).toEqual({
      command: ["bash", "-lc", "ls | wc -l"],
    });
  });

  test("and then runs, instead of being read as shell syntax", () => {
    expect(normalizeCommand(coerceArguments({ command: '["pwd"]' }, EXEC_PARAMETERS).command)).toEqual({ argv: ["pwd"] });
  });

  test("only where the schema says array", () => {
    // `cwd` is a string parameter; a bracketed string there is the model's to mean.
    expect(coerceArguments({ command: ["ls"], cwd: '["a"]' }, EXEC_PARAMETERS)).toEqual({ command: ["ls"], cwd: '["a"]' });
  });

  test("a string that is not a JSON array is left for the tool to judge", () => {
    // `[` is also a program: `[ -f x ]` is a shell test and must not be swallowed.
    expect(coerceArguments({ command: "[ -f x ]" }, EXEC_PARAMETERS)).toEqual({ command: "[ -f x ]" });
    expect(coerceArguments({ command: "git status" }, EXEC_PARAMETERS)).toEqual({ command: "git status" });
    expect(coerceArguments({ command: '{"a": 1}' }, EXEC_PARAMETERS)).toEqual({ command: '{"a": 1}' });
  });

  test("a number, a boolean or an object sent as its text becomes one, where the schema declares exactly that (G4)", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer" }, ratio: { type: "number" }, verbose: { type: "boolean" }, filter: { type: "object" }, name: { type: "string" } },
    };
    expect(coerceArguments({ count: "5", ratio: "-0.25", verbose: "TRUE", filter: ' {"tag": "a"} ', name: "5" }, schema)).toEqual({
      count: 5,
      ratio: -0.25,
      verbose: true,
      filter: { tag: "a" },
      name: "5",
    });
    expect(coerceArguments({ verbose: "false" }, schema)).toEqual({ verbose: false });
  });

  test("text that is not unambiguously one is left for the check to name", () => {
    const schema = { type: "object", properties: { count: { type: "integer" }, ratio: { type: "number" }, verbose: { type: "boolean" }, filter: { type: "object" }, either: { type: ["integer", "string"] } } };
    const sent = { count: "5.5", ratio: "1e5", verbose: "yes", filter: '["a"]', either: "7" };
    expect(coerceArguments(sent, schema)).toBe(sent);
    expect(coerceArguments({ count: "99999999999999999999" }, schema)).toEqual({ count: "99999999999999999999" });
  });

  test("a well-formed call is returned untouched", () => {
    const args = { command: ["git", "status"] };
    expect(coerceArguments(args, EXEC_PARAMETERS)).toBe(args);
    expect(coerceArguments(args, undefined)).toBe(args);
  });
});

describe("the executor coerces before the gate and the tool see it", () => {
  test("gate and execute both receive the array", async () => {
    const seen: { gate?: unknown; execute?: unknown } = {};
    const tool: Tool = {
      requiresApproval: false,
      definition: { name: "exec", description: "run", parameters: EXEC_PARAMETERS },
      async execute(args) {
        seen.execute = args.command;
        return { content: "ok", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === "exec" ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: (_name: string, args: Record<string, unknown>) => {
        seen.gate = args.command;
        return { action: "run", via: "allowlist" };
      },
      blockedPatterns: [],
    } as unknown as AgentToolset;

    let asked = 0;
    const provider = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(): Promise<ChatResponse> {
        asked += 1;
        return (asked === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "exec", arguments: { command: '["pwd"]' } }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "gpt-4" }
          : { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "gpt-4" }) as unknown as ChatResponse;
      },
    } as unknown as LLMProvider;

    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: {
          maxContextRatio: 0.8,
          truncationStrategy: "sliding_window",
          preserveRecentTurns: 1,
          summaryModel: undefined,
          compactAtRatio: 0.9,
          preserveRecentToolResults: 3,
        },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    });
    await executor.run({
      agent: fakeAgent(),
      provider,
      toolset,
      history: [],
      userMessage: { role: "user", content: "where am I", timestamp: 1 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

    expect(seen.gate).toEqual(["pwd"]);
    expect(seen.execute).toEqual(["pwd"]);
  });
});
