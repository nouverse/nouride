/**
 * A turn in a chat where the agent's own mission waits for the person's answer is told so (0.8.15).
 *
 * Nix's mission asked Sam for three keys; Sam sent them in Nix's chat, and Nix began "the key you just sent is the
 * same as before" — a repeat, not the answer its mission was waiting for (2026-11-02).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LoadedAgent } from "@nouride/shared";
import type { ExecutorDeps, TurnBrain, TurnRequest } from "@/modules/llm/executor/types.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { missionQuestions } from "@/modules/pipeline/mission-questions.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const WORK = [{ name: "work" }];
const QUESTION = "The three Nougate keys did not reach this mission — send them again?";
const waiting = (over: Partial<Mission> = {}): Mission =>
  ({ id: "msn_bbbba27611f44b259ec8", agentId: "nix", gatewayId: "telegram:nix", chatId: "814", status: "waiting", waitKind: "input", answers: [{ question: QUESTION, at: 1 }], ...over }) as Mission;

describe("what the agent is told of its missions' questions", () => {
  test("a question waiting: named, with how to pass the answer on, and that it is no repeat", () => {
    expect(missionQuestions([waiting()], "nix", WORK)).toEqual([
      `[Your mission msn_bbbba27611f44b259ec8 is waiting for this person's answer to its question: "${QUESTION}" If this message answers it, pass the answer on with work (action "answer", id msn_bbbba27611f44b259ec8) and say that you did: it is the answer the mission asked for, not a repeat.]`,
    ]);
  });

  test("nothing for a question answered, a mission at work, or another agent's", () => {
    expect(missionQuestions([waiting({ answers: [{ question: QUESTION, answer: "sent", at: 1 }] })], "nix", WORK)).toEqual([]);
    expect(missionQuestions([waiting({ status: "running", waitKind: null })], "nix", WORK)).toEqual([]);
    expect(missionQuestions([waiting({ waitKind: "approval" })], "nix", WORK)).toEqual([]);
    expect(missionQuestions([waiting()], "nouva", WORK)).toEqual([]);
  });

  test("an agent without `work` tells the person the command instead — it cannot pass it on", () => {
    expect(missionQuestions([waiting()], "nix", [])[0]).toContain("tell them to send it with /mission answer msn_bbbba27611f44b259ec8 <answer> (you cannot pass it on)");
  });

  test("a long question is cut, and its newest open one is the one named", () => {
    const long = "x".repeat(900);
    const note = missionQuestions([waiting({ answers: [{ question: "old", answer: "done", at: 1 }, { question: long, at: 2 }] })], "nix", WORK)[0]!;
    expect(note).toContain(`"${"x".repeat(600)}…"`);
    expect(note).not.toContain('"old"');
  });
});

describe("a chat turn", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  test("in the chat its waiting mission reports to carries the note; in another chat, none", async () => {
    const seen: TurnRequest[] = [];
    const cli = {
      runnerFor: (_agent: LoadedAgent, d: ExecutorDeps): TurnBrain => ({
        run: async (req) => {
          seen.push(req);
          d.onText?.("ok");
          const turn = [req.userMessage, { role: "assistant" as const, content: "ok", timestamp: Date.now() }];
          const compaction = { threshold: 1e9, limit: 1e9, totalLimit: 1e9, source: "test", summaryModel: "", summarizerWindow: 0 };
          return { text: "ok", messages: [...req.history, ...turn], turnMessages: turn, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0, iterations: 0, approvalsRefused: 0, toolSteps: [], stopReason: "stop", contextTokens: 0, truncated: false, compaction, tokenScale: 1 };
        },
      }),
    };
    const missionCommands = { forChat: (gatewayId: string, chatId: string) => (gatewayId === "telegram:main" && chatId === "814" ? [waiting({ agentId: "nouva", gatewayId, chatId })] : []) };
    const bench: Bench = await pipelineBench({ agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n', deps: { externalAgents: cli, missionCommands } as never });
    cleanups.push(bench.dispose);
    bench.pipeline.attach();
    bench.gateway.receive(envelope({ gatewayId: "telegram:main", chatId: "814", chatType: "dm", senderId: "u1", senderName: "Gading", text: "here are the keys", timestamp: Date.now() }));
    await eventually(() => seen.length > 0, 5_000, "the turn in the mission's chat");
    expect((seen[0]!.reminders ?? []).join("\n")).toContain("Your mission msn_bbbba27611f44b259ec8 is waiting for this person's answer");
    bench.gateway.receive(envelope({ gatewayId: "telegram:main", chatId: "999", chatType: "dm", senderId: "u1", senderName: "Gading", text: "hello", timestamp: Date.now() }));
    await eventually(() => seen.length > 1, 5_000, "the turn in another chat");
    expect((seen[1]!.reminders ?? []).join("\n")).not.toContain("Your mission");
  });
});
