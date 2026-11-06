/**
 * An external agent whose CLI cannot answer a turn (0.8.1): its own model answers that turn, and says so first — the
 * owner asked that an agent never go silent when its CLI is signed out or out of its account's limit. Not where the CLI
 * had already said something, nor a turn a person stopped.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { NourideError, type ChatResponse, type LLMProvider, type LoadedAgent } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import type { ExecutorDeps, TurnBrain, TurnRequest } from "@/modules/llm/executor/types.ts";
import { brainFor } from "@/modules/pipeline/brain.ts";
import { AutoApprovalGate, envelope, fakeAgent } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const deps = (texts: string[]): ExecutorDeps =>
  ({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onText: (delta: string) => void texts.push(delta),
  }) as unknown as ExecutorDeps;

const provider = { kind: "openai", baseUrl: "https://fake.test/v1", chat: async () => ({ text: "Here is the answer.", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "small" }) as unknown as ChatResponse } as unknown as LLMProvider;
const toolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run" }), blockedPatterns: [] } as unknown as AgentToolset;
const agent = { ...fakeAgent(), config: { ...fakeAgent().config, id: "nox", displayName: "Nox", external: { cli: "claude-code" } } } as unknown as LoadedAgent;
const request = (signal?: AbortSignal): TurnRequest => ({ agent, provider, toolset, history: [], userMessage: { role: "user", content: "hi", timestamp: 1 }, gateway: "telegram", gatewayId: "telegram:main", chatId: "c1", chatType: "dm", sessionId: "s1", senderId: "u1", ...(signal ? { signal } : {}) }) as TurnRequest;
const cli = (run: (deps: ExecutorDeps) => Promise<never>) => ({ runnerFor: (_agent: LoadedAgent, d: ExecutorDeps): TurnBrain => ({ run: () => run(d) }) });

describe("an external agent whose CLI cannot answer", () => {
  test("is answered by its own model, which says why first", async () => {
    const texts: string[] = [];
    const brain = brainFor(cli(async () => { throw new NourideError("external_agent", "signed out", "Claude Code is not signed in. Sign in on the agent's Brain tab"); }), agent, deps(texts));
    const result = await brain.run(request());
    expect(result.text).toBe("_claude-code could not answer: Claude Code is not signed in. Sign in on the agent's Brain tab. Nox's own model answered this time._\n\nHere is the answer.");
    expect(texts[0]).toStartWith("_claude-code could not answer");
  });

  test("not where the CLI had already said something, nor a turn a person stopped", async () => {
    const said = brainFor(cli(async (d) => { d.onText?.("Working on it…"); throw new Error("the CLI exited"); }), agent, deps([]));
    await expect(said.run(request())).rejects.toThrow("the CLI exited");
    const controller = new AbortController();
    controller.abort();
    const stopped = brainFor(cli(async () => { throw new Error("cancelled"); }), agent, deps([]));
    await expect(stopped.run(request(controller.signal))).rejects.toThrow("cancelled");
  });
});

describe("a coding CLI's turn in a chat", () => {
  test("keeps the typing indicator up while it works (0.8.5)", async () => {
    // Only the executor kept it up: a CLI's turn showed "typing" for the first five seconds and then nothing.
    let ticks = 0;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const slow = { runnerFor: (): TurnBrain => ({ run: async () => { await done; return { text: "Done." } as never; } }) };
    const brain = brainFor(slow, agent, { ...deps([]), onTyping: () => void (ticks += 1), typingRefreshMs: 10 });
    const run = brain.run(request());
    await eventually(() => ticks >= 3, 2_000, "the indicator refreshed while the CLI worked");
    finish();
    await run;
  });

  test("and lets it go when the turn ends, answered or failed — not 'typing' under the answer for good", async () => {
    // Said from the timer the keepalive keeps, not by waiting to see no tick: every interval it set is cleared.
    const set = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    try {
      const typing = { ...deps([]), onTyping: () => {}, typingRefreshMs: 10 };
      await brainFor({ runnerFor: (): TurnBrain => ({ run: async () => ({ text: "Done." }) as never }) }, agent, typing).run(request());
      const failed = brainFor({ runnerFor: (): TurnBrain => ({ run: async () => { throw new Error("the CLI exited"); } }) }, agent, typing);
      await failed.run(request());
      const timers = set.mock.results.map((result) => result.value);
      expect(timers.length).toBeGreaterThanOrEqual(2);
      // By identity: one timer object deep-equals any other.
      expect(timers.filter((timer) => !cleared.mock.calls.some(([gone]) => gone === timer))).toHaveLength(0);
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });
});

describe("a turn a coding CLI answered", () => {
  test("is recorded as answered by the CLI, not by the agent's own model, which said nothing (0.8.1, the live box)", async () => {
    // Nix's turns said "model: claude-sonnet-5-5" under work Claude Code had done.
    const b = await pipelineBench({
      deps: {
        externalAgents: {
          runnerFor: (_agent: LoadedAgent, d: ExecutorDeps): TurnBrain => ({
            run: async (req) => {
              d.onText?.("Done.");
              const said = [req.userMessage, { role: "assistant" as const, content: "Done.", timestamp: Date.now() }];
              const compaction = { threshold: 1e9, limit: 1e9, totalLimit: 1e9, source: "test", summaryModel: "", summarizerWindow: 0 };
              return { text: "Done.", messages: [...req.history, ...said], turnMessages: said, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0, iterations: 1, approvalsRefused: 0, toolSteps: [], stopReason: "stop", contextTokens: 0, truncated: false, compaction, tokenScale: 1, answeredBy: "Claude Code · sonnet" };
            },
          }),
        },
      },
    });
    b.pipeline.attach();
    b.gateway.receive(envelope({ id: "m1", text: "audit it", timestamp: Date.now() }));
    await eventually(() => b.turns.forChat("telegram:main", "chat-1").some((turn) => turn.status !== "running"), 4_000, "the turn's end");
    expect(b.turns.forChat("telegram:main", "chat-1").map((turn) => turn.model)).toEqual(["Claude Code · sonnet"]);
    b.dispose();
  });
});
