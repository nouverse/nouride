/**
 * A turn whose provider cannot be had yet ends, says so, and does not hold the conversation (0.8.15).
 *
 * On 0.8.14, a fresh Docker install under Nix's benchmark (2026-11-02): the first message came before the provider's key
 * was set. Building the turn read the provider eagerly for the second look, threw there — before the turn's own failure
 * path — and the conversation stayed held by a turn that never ran. Every later message, the key set by then, was
 * steered into it: "↪ Got it" and a line from the steer reply, never an answer, until a restart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { SecretError } from "@nouride/secrets";
import type { LoadedAgent } from "@nouride/shared";
import type { ExecutorDeps, TurnBrain } from "@/modules/llm/executor/types.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a provider whose key is not set yet", () => {
  test("the turn ends, the person is told, and the next message — the key set — is answered as a turn of its own", async () => {
    let keySet = false;
    const bench: Bench = await pipelineBench({
      turns: [{ text: "Halo! Saya Nouva." }],
      deps: (made) => ({
        providers: new Proxy(made.providers, {
          get(target, prop, receiver) {
            if (prop === "get") {
              return (name: string) => {
                if (!keySet) throw new SecretError('[providers.test] needs the secret "test_key", which is not set. Add TEST_KEY to .env, or set it from the dashboard.');
                return target.get(name);
              };
            }
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }),
      }),
    });
    cleanups.push(bench.dispose);
    bench.pipeline.attach();

    bench.gateway.receive(envelope({ id: "m1", text: "halo, kamu siapa?", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length > 0, 5_000, "a word for the first message");
    expect(bench.gateway.lastText()).toContain("A credential is missing or misconfigured.");
    // Its record closed, and nothing left at work in the chat.
    expect(bench.turns.runningFor("nouva", "telegram:main", "chat-1")).toBeNull();

    keySet = true;
    bench.gateway.receive(envelope({ id: "m2", text: "halo lagi", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.some((sent) => sent.text.includes("Halo! Saya Nouva.")), 5_000, "the second message answered");
    expect(bench.gateway.sent.map((sent) => sent.text).join("\n")).not.toContain("Got it");
  });

  test("anything else that throws before the turn runs gives its place back the same way", async () => {
    let unreachable = true;
    // An external agent's runner is made while the turn is built — where the provider was read — and here fails once.
    const cli = {
      runnerFor: (_agent: LoadedAgent, d: ExecutorDeps): TurnBrain => {
        if (unreachable) {
          unreachable = false;
          throw new Error("the CLI could not be reached");
        }
        return {
          run: async (req) => {
            d.onText?.("answered");
            const turn = [req.userMessage, { role: "assistant" as const, content: "answered", timestamp: Date.now() }];
            const compaction = { threshold: 1e9, limit: 1e9, totalLimit: 1e9, source: "test", summaryModel: "", summarizerWindow: 0 };
            return { text: "answered", messages: [...req.history, ...turn], turnMessages: turn, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0, iterations: 0, approvalsRefused: 0, toolSteps: [], stopReason: "stop", contextTokens: 0, truncated: false, compaction, tokenScale: 1 };
          },
        };
      },
    };
    const bench: Bench = await pipelineBench({ agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n', deps: { externalAgents: cli } });
    cleanups.push(bench.dispose);
    bench.pipeline.attach();

    bench.gateway.receive(envelope({ id: "m1", text: "halo", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length > 0, 5_000, "a word for the first message");
    expect(bench.gateway.lastText()).toContain("Something went wrong on my side.");
    expect(bench.turns.runningFor("nouva", "telegram:main", "chat-1")).toBeNull();

    bench.gateway.receive(envelope({ id: "m2", text: "halo lagi", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.some((sent) => sent.text.includes("answered")), 5_000, "the second message answered");
    expect(bench.gateway.sent.map((sent) => sent.text).join("\n")).not.toContain("Got it");
  });
});
