/**
 * `identify` from config to the wire: the profile key is read, the registry hands it to the client, and a
 * turn says which agent and which conversation it is — the root one, so a `delegate` helper shares its parent's.
 */

import { describe, expect, test } from "bun:test";
import type { ChatParams, LLMProvider } from "@nouride/shared";
import { SecretStore } from "@nouride/secrets";
import { parseConfig } from "@/modules/config/global/index.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent, tempDir } from "../helpers.ts";

const profile = (extra: Record<string, unknown>) => ({ providers: { gw: { kind: "openai", base_url: "https://gw.test/v1", api_key: "gw_key", ...extra } } });

describe("[providers.<name>] identify", () => {
  test("read as a boolean, off when absent, refused as anything else", () => {
    expect(parseConfig(profile({ identify: true })).providers.gw?.identify).toBe(true);
    expect(parseConfig(profile({})).providers.gw?.identify).toBeUndefined();
    expect(() => parseConfig(profile({ identify: "yes" }))).toThrow("identify");
  });

  test("handed to the client the registry builds", async () => {
    const sent: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    }) as unknown as typeof fetch;
    const config = parseConfig(profile({ identify: true }));
    const providers = new ProviderRegistry(config.providers, await SecretStore.open(tempDir("secrets"), { GW_KEY: "k" }), { fetchImpl });
    await providers.get("gw").chat({ model: "m", messages: [{ role: "user", content: "hi" }], identity: { agentId: "nouva", conversation: "c" } });
    expect(sent[0]?.["x-client-id"]).toBe("nouride/nouva");
  });
});

/** One turn of `agent`, in `sessionId`, against a provider that records what it was asked. */
async function askedOnce(configure: (agent: ReturnType<typeof fakeAgent>) => void, sessionId = "ses_nouva:telegram:main:814"): Promise<ChatParams[]> {
  const asked: ChatParams[] = [];
  const provider = {
    chat: async (params: ChatParams) => {
      asked.push(params);
      return { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
    },
    stream() {
      throw new Error("streaming is off here");
    },
  } as unknown as LLMProvider;
  const agent = fakeAgent();
  agent.config.llm = { provider: "gw", model: "m", maxTokens: 128, temperature: 0.7 };
  configure(agent);
  const toolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 2, maxTokensPerTurn: 1024 },
      context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.8, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
  });
  await executor.run({
    agent,
    provider,
    toolset,
    history: [],
    userMessage: { role: "user", content: "check the build", timestamp: Date.now() },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "814",
    chatType: "dm",
    sessionId,
    senderId: "814",
  });
  return asked;
}

describe("a turn's effort", () => {
  test("the agent's, on every request of the turn; none when it sets none", async () => {
    expect((await askedOnce((agent) => void (agent.config.llm.effort = "medium")))[0]?.effort).toBe("medium");
    expect((await askedOnce(() => {}))[0]?.effort).toBeUndefined();
  });
});

describe("a turn's identity", () => {
  test("the agent, and the conversation a helper's session belongs to", async () => {
    const asked: ChatParams[] = [];
    const provider = {
      chat: async (params: ChatParams) => {
        asked.push(params);
        return { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      },
      stream() {
        throw new Error("streaming is off here");
      },
    } as unknown as LLMProvider;
    const agent = fakeAgent();
    agent.config.llm = { provider: "gw", model: "m", maxTokens: 128, temperature: 0.7 };
    const toolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 2, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.8, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    });

    await executor.run({
      agent,
      provider,
      toolset,
      history: [],
      userMessage: { role: "user", content: "check the build", timestamp: Date.now() },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "814",
      chatType: "dm",
      sessionId: "ses_nouva:telegram:main:814:sub:helper-1",
      senderId: "814",
    });

    expect(asked[0]?.identity).toEqual({ agentId: agent.config.id, conversation: "ses_nouva:telegram:main:814" });
  });
});
