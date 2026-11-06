/**
 * What an external agent's CLI says by itself, between turns (0.8.6), as the pipeline carries it: the wake-up is a turn
 * of the agent's in its chat, through the queue, which its runner is told to read rather than prompt — and a turn the
 * agent answers for another, asked with `ask_agent`, says so, so what the CLI says there wakes no chat of its own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LoadedAgent } from "@nouride/shared";
import type { ExecutorDeps, TurnBrain, TurnRequest } from "@/modules/llm/executor/types.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

/** A coding CLI's runner that answers every turn of `ids` with `said`, keeping each request it was handed. */
function cli(ids: string[], said: string, seen: TurnRequest[]) {
  return {
    runnerFor: (agent: LoadedAgent, d: ExecutorDeps): TurnBrain | null =>
      ids.includes(agent.config.id)
        ? {
            run: async (req) => {
              seen.push(req);
              d.onText?.(said);
              const turn = [req.userMessage, { role: "assistant" as const, content: said, timestamp: Date.now() }];
              const compaction = { threshold: 1e9, limit: 1e9, totalLimit: 1e9, source: "test", summaryModel: "", summarizerWindow: 0 };
              return { text: said, messages: [...req.history, ...turn], turnMessages: turn, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0, iterations: 0, approvalsRefused: 0, toolSteps: [], stopReason: "stop", contextTokens: 0, truncated: false, compaction, tokenScale: 1 };
            },
          }
        : null,
  };
}

describe("what a coding CLI says by itself (0.8.6)", () => {
  test("wakes the agent in its chat with a turn the runner reads it in, headed as such — a person's turn is not one", async () => {
    const seen: TurnRequest[] = [];
    const bench = await pipelineBench({ deps: { externalAgents: cli(["nouva"], "Finished: the build passed.", seen) } });
    benches.push(bench);
    bench.pipeline.attach();
    bench.gateway.receive(envelope({ id: "m1", text: "build it", timestamp: Date.now() }));
    await eventually(() => seen.length === 1 && bench.turns.forChat("telegram:main", "chat-1").every((turn) => turn.status !== "running"), 4_000, "the person's turn");
    bench.pipeline.wakeForOwnWords({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" });
    await bench.pipeline.idle();
    await eventually(() => seen.length === 2, 4_000, "the woken turn");
    expect(seen[0]!.ownWords).toBeUndefined();
    expect(seen[1]).toMatchObject({ ownWords: true, systemEvent: true, gatewayId: "telegram:main", chatId: "chat-1" });
    await eventually(() => bench.turns.forChat("telegram:main", "chat-1").length === 2 && bench.turns.forChat("telegram:main", "chat-1").every((turn) => turn.status !== "running"), 4_000, "its record");
    expect(bench.turns.forChat("telegram:main", "chat-1").map((turn) => turn.cause?.via ?? null)).toEqual([null, "cli own words"]);
    expect(bench.gateway.sent.map((message) => message.text)).toContain("Finished: the build passed.");
  });

  test("a turn of an agent another one asked says it was asked; the agent's own turn does not", async () => {
    const seen: TurnRequest[] = [];
    const pack = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["ask_agent"]\n';
    const bench = await pipelineBench({
      turns: [{ toolCalls: [{ id: "a1", name: "ask_agent", args: { agent: "nox", task: "check the build" } }] }, { text: "done" }],
      agents: [{ id: "nouva", configToml: pack }, { id: "nox", configToml: pack }],
      config: { daemon: { orchestrator: "nouva" }, agents: { mentions_enabled: true } },
      configure: (config) => void (config.queue.steerReply = false),
      deps: { externalAgents: cli(["nox"], "the build is green", seen) },
    });
    benches.push(bench);
    bench.pipeline.setTools(createBuiltinTools({ security: bench.config.security, askAgent: { run: bench.pipeline.peerTurnRunner(), peers: (caller) => ["nouva", "nox"].filter((id) => id !== caller) } }));
    bench.pipeline.attach();
    bench.gateway.receive(envelope({ id: "m1", text: "ask nox", timestamp: Date.now() }));
    await eventually(() => seen.length === 1, 4_000, "nox asked");
    expect(seen[0]!.asked).toBe(true);
    bench.gateway.receive(envelope({ id: "m2", text: "@nox hi", timestamp: Date.now(), mentions: ["nox"] }));
    await eventually(() => seen.length === 2, 4_000, "nox's own turn");
    expect(seen[1]!.asked).toBeUndefined();
  });

  test("a restart is told what the CLIs left running in the background, to wait for as for a job", async () => {
    const left = [{ id: "cli:nix", command: "nix's Claude Code", startedAt: 1 }];
    const bench = await pipelineBench({ deps: { externalAgents: { runnerFor: () => null, working: () => left } } });
    benches.push(bench);
    expect(bench.pipeline.cliCommands()).toEqual(left);
  });

  test("a command the last process was stopped with wakes its chat with a prompt to the CLI, headed as such", async () => {
    const seen: TurnRequest[] = [];
    const bench = await pipelineBench({ deps: { externalAgents: cli(["nouva"], "It was cut off: the build did not finish.", seen) } });
    benches.push(bench);
    bench.pipeline.attach();
    bench.pipeline.wakeForCliStopped({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" });
    await bench.pipeline.idle();
    await eventually(() => seen.length === 1, 4_000, "the woken turn");
    expect(seen[0]).toMatchObject({ systemEvent: true, chatId: "chat-1" });
    expect(seen[0]!.ownWords).toBeUndefined();
    expect(String(seen[0]!.userMessage.content)).toContain("a command you had left running in the background may have been cut off");
    await eventually(() => bench.turns.forChat("telegram:main", "chat-1").some((turn) => turn.status !== "running"), 4_000, "its record");
    expect(bench.turns.forChat("telegram:main", "chat-1").map((turn) => turn.cause?.via)).toEqual(["cli stopped"]);
  });
});
