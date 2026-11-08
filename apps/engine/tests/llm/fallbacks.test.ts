/**
 * `[llm] fallbacks`: when the model a turn is on cannot answer after its retries, the next pair
 * — a provider and a model — answers, in order. Another model on the same profile answers a model that is busy or not
 * served; another profile answers an endpoint that is down, out of credit or refusing its key.
 *
 * Held here to: which failures each pair answers, the order, that the rest of the turn stays on the pair that
 * answered, that usage is charged to the profile that answered, and that the operator hears once an outage.
 */

import { describe, expect, test } from "bun:test";
import { createProvider } from "@nouride/llm";
import { eventProblems, LLMError, type ChatParams, type LLMFailure, type LLMProvider } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { alertOnFallback, FallbackOutages } from "@/modules/pipeline/fallback-alert.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const FAILURES: Record<string, LLMFailure> = {
  rate_limit: { class: "rate_limit", action: "retry", alertOperator: false, operatorHint: "rate limited by the provider; backing off." },
  overloaded: { class: "overloaded", action: "retry", alertOperator: false, operatorHint: "provider is saturated; backing off." },
  model_not_found: { class: "model_not_found", action: "stop", alertOperator: true, operatorHint: "the model id is wrong." },
  transient: { class: "transient", action: "retry", alertOperator: false, operatorHint: "the provider failed." },
  auth: { class: "auth", action: "stop", alertOperator: true, operatorHint: "the provider rejected the credential." },
  billing: { class: "billing", action: "stop", alertOperator: true, operatorHint: "the account is out of credit." },
  content_policy: { class: "content_policy", action: "stop", alertOperator: false, operatorHint: "refused on content." },
};

/** Every call any endpoint got, as `profile/model`. */
type Asked = string[];

/**
 * An endpoint where the models in `failing` cannot answer with `failure`, and every other model answers — a tool call
 * first when `toolFirst`, so the turn takes a second round, then text.
 */
function endpoint(profile: string, asked: Asked, input: { failing?: string[]; failure?: LLMFailure; toolFirst?: boolean } = {}) {
  let rounds = 0;
  return {
    async chat(params: ChatParams) {
      asked.push(`${profile}/${params.model}`);
      // A turn that falls back for ever never yields to a timer, so it would hang the file rather than fail it.
      if (asked.length > 20) throw new Error(`asked ${asked.length} times — falling back in a loop`);
      if (input.failing?.includes(params.model)) throw new LLMError(`${profile}/${params.model}: ${input.failure!.class}`, 429, { failure: input.failure! });
      rounds += 1;
      if (input.toolFirst && rounds === 1) {
        return { text: "", toolCalls: [{ id: "c1", name: "clock", arguments: {} }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 }, model: params.model };
      }
      return { text: `answered by ${profile}/${params.model}`, toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: params.model };
    },
  } as unknown as LLMProvider;
}

function run(
  own: LLMProvider,
  fallbacks: { profile: string; model: string; provider: LLMProvider }[],
  options: { model?: string; streaming?: boolean; onFallback?: (info: { from: string; fromProfile: string; to: string; toProfile: string; failure: LLMFailure }) => void } = {},
) {
  const activity: string[] = [];
  const rows: { kind: string; data: Record<string, unknown> }[] = [];
  const charged: string[] = [];
  const written: string[] = [];
  const clock = { definition: { name: "clock", description: "the time", parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "noon", isError: false }) };
  const toolset: AgentToolset = {
    definitions: [clock.definition],
    get: (name: string) => (name === "clock" ? clock : undefined),
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as AgentToolset;
  const agent = fakeAgent({ config: { ...fakeAgent().config, llm: { provider: "nougate", model: options.model ?? "primary", maxTokens: 1024, temperature: 0 } } });
  const result = new TurnExecutor({
    llm: {
      streaming: { enabled: options.streaming === true, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onActivity: (kind, text, data) => {
      activity.push(`${kind}: ${text}`);
      rows.push({ kind, data: { step: 1, text, ...(data ?? {}) } });
    },
    onUsage: (usage) => void charged.push(`${usage.provider}/${usage.model}`),
    onText: (delta) => void written.push(delta),
    ...(options.onFallback ? { onFallback: options.onFallback } : {}),
  }).run({
    agent,
    provider: own,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
    toolset,
    history: [],
    userMessage: { role: "user", content: "what time is it?", timestamp: 1 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
  });
  return { result, activity, charged, written, rows };
}

describe("a fallback on the agent's own profile", () => {
  for (const failure of ["rate_limit", "overloaded", "model_not_found"]) {
    test(`answers when the agent's model ${failure === "model_not_found" ? "is not served" : `is ${failure}`}, and the turn says so`, async () => {
      const asked: Asked = [];
      const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES[failure]! });
      const seen: string[] = [];
      const { result, activity, charged } = run(nougate, [{ profile: "nougate", model: "spare", provider: nougate }], {
        onFallback: (info) => void seen.push(`${info.fromProfile}/${info.from} → ${info.toProfile}/${info.to}: ${info.failure.class}`),
      });

      expect((await result).text).toBe("answered by nougate/spare");
      expect(asked).toEqual(["nougate/primary", "nougate/spare"]);
      expect(seen).toEqual([`nougate/primary → nougate/spare: ${failure}`]);
      expect(charged).toEqual(["nougate/spare"]);
      expect(activity.some((line) => line.startsWith("retry: primary ") && line.endsWith(": answering with spare"))).toBe(true);
    });
  }

  test("the step it writes is one the event contract describes", async () => {
    // Live, 2026-10-31: Nouva's Gemini fell back to Sonnet and six rows logged "an event row the contract does not
    // describe" — `reason: "fallback"`, `from` and `to` were written and never added to the contract (1.7).
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES.rate_limit! });
    const { result, rows } = run(nougate, [{ profile: "nougate", model: "spare", provider: nougate }]);
    await result;
    const fallback = rows.find((row) => row.kind === "retry" && row.data.reason === "fallback");
    expect(fallback?.data).toMatchObject({ from: "primary", to: "spare" });
    expect(eventProblems("retry", fallback!.data)).toEqual([]);
  });

  test("is not asked for what another model behind the same endpoint would meet too — a key refused", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES.auth! });
    await expect(run(nougate, [{ profile: "nougate", model: "spare", provider: nougate }]).result).rejects.toThrow("nougate/primary: auth");
    expect(asked).toEqual(["nougate/primary"]);
  });
});

describe("a fallback on another profile", () => {
  for (const failure of ["transient", "auth", "billing", "rate_limit"]) {
    test(`answers an endpoint that ${failure === "transient" ? "is down" : `fails with ${failure}`}, and is charged for what it answered`, async () => {
      const asked: Asked = [];
      const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES[failure]! });
      const openrouter = endpoint("openrouter", asked);
      const { result, activity, charged } = run(nougate, [{ profile: "openrouter", model: "claude", provider: openrouter }]);

      expect((await result).text).toBe("answered by openrouter/claude");
      expect(asked).toEqual(["nougate/primary", "openrouter/claude"]);
      expect(charged).toEqual(["openrouter/claude"]);
      expect(activity.some((line) => line.endsWith(": answering with claude on openrouter"))).toBe(true);
    });
  }

  test("skips a pair on the same profile for a failure only another endpoint answers, and takes the next", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES.auth! });
    const local = endpoint("ollama", asked);
    const { result } = run(nougate, [
      { profile: "nougate", model: "spare", provider: nougate },
      { profile: "ollama", model: "qwen3:8b", provider: local },
    ]);
    expect((await result).text).toBe("answered by ollama/qwen3:8b");
    expect(asked).toEqual(["nougate/primary", "ollama/qwen3:8b"]);
  });

  test("is never asked for what any model would meet — a content policy", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES.content_policy! });
    await expect(run(nougate, [{ profile: "openrouter", model: "claude", provider: endpoint("openrouter", asked) }]).result).rejects.toThrow("content_policy");
    expect(asked).toEqual(["nougate/primary"]);
  });
});

/**
 * An endpoint that does not answer at all, through the real client: a port nothing listens on, or a stream whose
 * socket closes. `postJson` and `streamEvents` used to throw these unclassified, so no pair was ever asked — a stopped
 * ollama ended the turn with openrouter listed to answer it.
 */
describe("an endpoint that does not answer", () => {
  const noWait = { maxAttempts: 2, sleep: async () => {} };
  /** An OpenAI-compatible endpoint whose stream sends `frames`, then loses its socket. */
  const dropping = (frames: string[]) =>
    createProvider({
      kind: "openai",
      baseUrl: "https://down.test/v1",
      apiKey: "k",
      http: {
        ...noWait,
        fetchImpl: (async () => {
          const encoder = new TextEncoder();
          let sent = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent < frames.length) controller.enqueue(encoder.encode(frames[sent++]!));
              else controller.error(new TypeError("The socket connection was closed unexpectedly."));
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }) as unknown as typeof fetch,
      },
    });
  /** An endpoint that streams `text` and finishes, counting the times it was asked. */
  const streaming = (text: string, asked: Asked) =>
    createProvider({
      kind: "openai",
      baseUrl: "https://up.test/v1",
      apiKey: "k",
      http: {
        ...noWait,
        fetchImpl: (async () => {
          asked.push("openrouter/claude");
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }) as unknown as typeof fetch,
      },
    });

  test("is answered by a pair on another profile when nothing listens on its port", async () => {
    const asked: Asked = [];
    const stopped = createProvider({ kind: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", http: noWait });
    const { result, activity } = run(stopped, [{ profile: "openrouter", model: "claude", provider: endpoint("openrouter", asked) }]);
    expect((await result).text).toBe("answered by openrouter/claude");
    expect(asked).toEqual(["openrouter/claude"]);
    expect(activity.some((line) => line.endsWith("primary is down: answering with claude on openrouter"))).toBe(true);
  });

  test("is not answered by another model behind the same endpoint, which is down with it", async () => {
    const stopped = createProvider({ kind: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", http: noWait });
    await expect(run(stopped, [{ profile: "nougate", model: "spare", provider: stopped }]).result).rejects.toThrow(/network error/);
  });

  test("is answered by the next pair when its stream drops before the reply began", async () => {
    const asked: Asked = [];
    const { result, written } = run(dropping([`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`]), [
      { profile: "openrouter", model: "claude", provider: streaming("answered by openrouter/claude", asked) },
    ], { streaming: true });
    expect((await result).text).toBe("answered by openrouter/claude");
    expect(asked).toEqual(["openrouter/claude"]);
    expect(written).toEqual(["answered by openrouter/claude"]);
  });

  test("is not answered twice: a stream that drops part-way through its reply ends the turn as before", async () => {
    const asked: Asked = [];
    const { result, written } = run(dropping([`data: ${JSON.stringify({ choices: [{ delta: { content: "It is no" } }] })}\n\n`]), [
      { profile: "openrouter", model: "claude", provider: streaming("answered by openrouter/claude", asked) },
    ], { streaming: true });
    await expect(result).rejects.toThrow(/stream ended mid-reply/);
    expect(asked).toEqual([]);
    expect(written).toEqual(["It is no"]);
  });
});

describe("the list", () => {
  test("is tried in order, each pair once, until one answers", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary", "spare"], failure: FAILURES.overloaded! });
    const openrouter = endpoint("openrouter", asked);
    const { result } = run(nougate, [
      { profile: "nougate", model: "spare", provider: nougate },
      { profile: "openrouter", model: "claude", provider: openrouter },
    ]);
    expect((await result).text).toBe("answered by openrouter/claude");
    expect(asked).toEqual(["nougate/primary", "nougate/spare", "openrouter/claude"]);
  });

  test("answers the rest of the turn too: the model that refused is not asked again every round", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES.rate_limit! });
    const openrouter = endpoint("openrouter", asked, { toolFirst: true });
    const { result } = run(nougate, [{ profile: "openrouter", model: "claude", provider: openrouter }]);
    expect((await result).text).toBe("answered by openrouter/claude");
    expect(asked).toEqual(["nougate/primary", "openrouter/claude", "openrouter/claude"]);
  });

  test("stands in for a model `/model` chose as well", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["chosen"], failure: FAILURES.overloaded! });
    const { result } = run(nougate, [{ profile: "nougate", model: "spare", provider: nougate }], { model: "chosen" });
    expect((await result).text).toBe("answered by nougate/spare");
    expect(asked).toEqual(["nougate/chosen", "nougate/spare"]);
  });

  test("spent, the turn ends with what the last one said", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary", "spare"], failure: FAILURES.rate_limit! });
    await expect(run(nougate, [{ profile: "nougate", model: "spare", provider: nougate }]).result).rejects.toThrow("nougate/spare: rate_limit");
    expect(asked).toEqual(["nougate/primary", "nougate/spare"]);
  });

  test("answers the turn's closing call too — the wrap-up at its cap, when the agent's model is rate-limited there", async () => {
    const asked: Asked = [];
    // Wants the clock every round, so the turn reaches its cap; the closing call — tools offered, none to be called —
    // is the one refused.
    const nougate = {
      async chat(params: ChatParams) {
        asked.push(`nougate/${params.model}`);
        if (params.toolChoice === "none") throw new LLMError("nougate/primary: rate_limit", 429, { failure: FAILURES.rate_limit! });
        return { text: "", toolCalls: [{ id: `c${asked.length}`, name: "clock", arguments: {} }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: params.model };
      },
    } as unknown as LLMProvider;
    const { result, charged } = run(nougate, [{ profile: "openrouter", model: "claude", provider: endpoint("openrouter", asked) }]);
    expect((await result).text).toBe("answered by openrouter/claude");
    expect(asked.slice(-2)).toEqual(["nougate/primary", "openrouter/claude"]);
    expect(charged.at(-1)).toBe("openrouter/claude");
  });

  test("empty, the turn ends as it always did", async () => {
    const asked: Asked = [];
    const nougate = endpoint("nougate", asked, { failing: ["primary"], failure: FAILURES.rate_limit! });
    await expect(run(nougate, []).result).rejects.toThrow("nougate/primary: rate_limit");
    expect(asked).toEqual(["nougate/primary"]);
  });
});

describe("what the operator is told", () => {
  const agent = fakeAgent({ config: { ...fakeAgent().config, llm: { provider: "nougate", model: "primary", maxTokens: 1, temperature: 0 } } });
  const fell = (failure: LLMFailure) => ({ from: "primary", fromProfile: "nougate", to: "claude", toProfile: "openrouter", failure });

  test("once an outage, however many turns fall back — and again after an hour without one", () => {
    let now = 0;
    const alerts: { key: string; text: string }[] = [];
    const notify = alertOnFallback(new FallbackOutages(() => now), { alert: async (key, text) => (alerts.push({ key, text }), true) }, agent);
    notify(fell(FAILURES.transient!));
    now += 30 * 60_000;
    notify(fell(FAILURES.transient!));
    now += 50 * 60_000;
    notify(fell(FAILURES.transient!));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toBe("nouva: primary on nougate failed (transient), so claude on openrouter is answering until it is back.");
    now += 61 * 60_000;
    notify(fell(FAILURES.transient!));
    expect(alerts).toHaveLength(2);
  });

  test("with the fix, when it is theirs to make — a model not served, a key refused", () => {
    const alerts: string[] = [];
    alertOnFallback(new FallbackOutages(), { alert: async (_key, text) => (alerts.push(text), true) }, agent)(fell(FAILURES.model_not_found!));
    expect(alerts[0]).toEndWith("until it is back. the model id is wrong.");
  });
});
