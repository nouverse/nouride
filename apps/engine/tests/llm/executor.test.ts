import { messageText } from "@nouride/shared";
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ContentPart, LLMProvider } from "@nouride/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { outOfTimeForAnotherRound, wrapUpReserveMs } from "@/modules/llm/executor/deadline.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent, sleep } from "../helpers.ts";

function emptyToolset(): AgentToolset {
  return {
    definitions: [],
    get: () => undefined,
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  };
}

function longHistory(turns: number, size: number): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let i = 0; i < turns; i += 1) {
    history.push({ role: "user", content: `u${i}:${"x".repeat(size)}`, timestamp: i * 2 });
    history.push({ role: "assistant", content: `a${i}:${"y".repeat(size)}`, timestamp: i * 2 + 1 });
  }
  return history;
}

describe("TurnExecutor typing keepalive", () => {
  test("starts typing before summary compaction finishes", async () => {
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryStarted = false;
    const typing: string[] = [];

    const provider = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(params: { temperature?: number }) {
        // The summary call is the deterministic one; everything else is the turn.
        if (params.temperature === 0) {
          summaryStarted = true;
          await summaryGate;
          return {
            text: "condensed earlier work",
            toolCalls: [],
            stopReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "gpt-4",
          };
        }

        return {
          text: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "gpt-4",
        };
      },
      stream() {
        throw new Error("streaming is disabled in this test");
      },
    } as unknown as LLMProvider;

    const agent = fakeAgent();
    agent.config.llm = { provider: "test", model: "gpt-4", maxTokens: 128, temperature: 0.7 };

    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: true, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: {
          maxContextRatio: 0.8,
          truncationStrategy: "summary",
          preserveRecentTurns: 1,
          summaryModel: undefined,
          compactAtRatio: 0.8,
          preserveRecentToolResults: 3,
        },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      onTyping: () => void typing.push("tick"),
      typingRefreshMs: 1000,
    });

    const run = executor.run({
      agent,
      provider,
      toolset: emptyToolset(),
      history: longHistory(3, 7000),
      userMessage: { role: "user", content: "what changed?", timestamp: Date.now() },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "session-1",
      senderId: "user-1",
    });

    await sleep(10);

    expect(summaryStarted).toBe(true);
    expect(typing.length).toBeGreaterThan(0);

    releaseSummary?.();
    const result = await run;
    expect(result.text).toBe("done");
  });
});

/**
 * The turn deadline gets the rescue the iteration cap already had.
 *
 * Reconstructed from a live turn: 21 tool calls, every one successful — a pull request merged, a
 * tag re-pushed, a failed job re-run and its flake diagnosed — and the person was told none of it.
 * The clock aborted the loop mid-call, the loop broke with no text, and the pipeline sent "I ran
 * out of time on that one and stopped part-way". The same turn four rounds later would have hit
 * the iteration cap and been asked to summarize.
 */
describe("running out of time", () => {
  function deadlineExecutor(maxTurnDurationMs: number, onWrapUp: (instruction: string) => void) {
    return new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 25, maxTokensPerTurn: 4096, maxTurnDurationMs },
        context: {
          maxContextRatio: 0.8,
          truncationStrategy: "sliding_window",
          preserveRecentTurns: 4,
          summaryModel: undefined,
          compactAtRatio: 0.8,
          preserveRecentToolResults: 3,
        },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      onWrapUp,
    } as never);
  }

  /** A toolset with one tool that always works, so nothing but the clock can end the turn. */
  function pollToolset(): AgentToolset {
    return {
      ...emptyToolset(),
      definitions: [
        { name: "exec", description: "run", parameters: { type: "object", properties: {} } },
      ],
      get: () => ({
        definition: { name: "exec", description: "run", parameters: { type: "object", properties: {} } },
        execute: async () => ({ content: "in_progress", isError: false }),
      }),
    } as unknown as AgentToolset;
  }

  /** Every round asks for another poll; the wrap-up round is the one with no tools left to call. */
  function pollingProvider(seen: string[]): LLMProvider {
    let round = 0;
    return {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(params: { messages: ChatMessage[] }) {
        const last = params.messages[params.messages.length - 1];
        if (last?.role === "user" && messageText(last.content).startsWith("[system]")) {
          seen.push(messageText(last.content));
          return {
            text: "Merged the PR and re-ran the job; the run is still going.",
            toolCalls: [],
            stopReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "gpt-4",
          };
        }
        round += 1;
        return {
          text: "",
          // A different call each round: the same one answered the same ends the turn on its own (`SameAnswers`).
          toolCalls: [{ id: `c${round}`, name: "exec", arguments: { command: ["sleep", String(20 + round)] } }],
          stopReason: "tool_calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "gpt-4",
        };
      },
      stream() {
        throw new Error("streaming is disabled in this test");
      },
    } as unknown as LLMProvider;
  }

  async function runUntilDeadline(deadlineIn: number) {
    const seen: string[] = [];
    const agent = fakeAgent();
    agent.config.llm = { provider: "test", model: "gpt-4", maxTokens: 128, temperature: 0.7 };
    const result = await deadlineExecutor(100_000, () => {}).run({
      agent,
      provider: pollingProvider(seen),
      toolset: pollToolset(),
      history: [],
      userMessage: { role: "user", content: "watch the build", timestamp: Date.now() },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "session-1",
      senderId: "user-1",
      deadlineAt: Date.now() + deadlineIn,
    } as never);
    return { result, seen };
  }

  test("a turn inside the reserve stops and reports instead of dying mid-call", async () => {
    // 100s turn ⇒ a 20s reserve. One round of work happens, then the clock is inside it.
    const { result, seen } = await runUntilDeadline(20_000);

    expect(result.text).toContain("Merged the PR");
    expect(seen).toHaveLength(1);
    // What the reply has to cover, and the half that was always missing: the unfinished part.
    expect(seen[0]).toContain("out of time");
    expect(seen[0]).toContain("still unfinished or still running");
    expect(seen[0]).toContain("Do not call any more tools");
    // One poll, not twenty-one: the round that would have started another wait never ran.
    expect(result.toolCalls).toBe(1);
    // And it says why its last words were a wrap-up — what a delegated turn's handoff reads it from (0.7.15).
    expect(result.wrappedUp).toBe("turn deadline");
  });

  test("a turn with time left is not cut short", async () => {
    // The same setup with room on the clock runs to the iteration cap, which has its own wrap-up —
    // so this asserts the reserve is a floor and not simply "always wrap up".
    const { result, seen } = await runUntilDeadline(90_000);
    expect(result.toolCalls).toBe(25);
    expect(seen[0]).toContain("Tool call limit reached");
    expect(result.wrappedUp).toBe("iteration cap");
  });

  /**
   * A picture in the transcript must survive the rescue path, and it did not.
   *
   * `run` resolves `image_ref` parts to bytes immediately before calling the provider, and `wrapUp` —
   * the path taken when a turn would otherwise say nothing — went straight to the provider with the
   * transcript as it stands. The wire serializer refuses an `image_ref` on principle, so the turn died
   * with `an unresolved image_ref reached the wire serializer`, which the classifier could only report
   * to the person as **"The model is not responding right now."**
   *
   * That is the worst shape of wrong answer: it is our bug, and it sends somebody to go and check
   * their provider. It became common rather than rare once `background_started` began reaching the
   * wrap-up — a turn that starts a job always wraps up now, so every screenshot sent to an agent that
   * starts one hit it.
   */
  describe("a picture in the transcript reaches the wrap-up", () => {
    test("no image_ref survives to the provider on the rescue path", async () => {
      const dir = mkdtempSync(join(tmpdir(), "wrapup-image-"));
      try {
        // A real 1x1 PNG, so this proves the bytes are *read*, not merely that the ref is dropped.
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        );
        const file = join(dir, "shot.png");
        writeFileSync(file, png);

        const seenParts: ContentPart[][] = [];
        const agent = fakeAgent();
        agent.config.llm = { provider: "test", model: "gpt-4", maxTokens: 128, temperature: 0.7 };

        const provider = {
          kind: "openai",
          baseUrl: "https://fake.test/v1",
          async chat(params: { messages: ChatMessage[] }) {
            for (const message of params.messages) {
              if (typeof message.content !== "string") seenParts.push(message.content);
            }
            const last = params.messages[params.messages.length - 1];
            if (last?.role === "user" && messageText(last.content).startsWith("[system]")) {
              return {
                text: "done",
                toolCalls: [],
                stopReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1 },
                model: "gpt-4",
              };
            }
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "exec", arguments: { command: ["sleep", "20"] } }],
              stopReason: "tool_calls",
              usage: { inputTokens: 1, outputTokens: 1 },
              model: "gpt-4",
            };
          },
          stream() {
            throw new Error("streaming is disabled in this test");
          },
        } as unknown as LLMProvider;

        // A 100s turn with 20s left is inside the reserve, so one round runs and the rescue follows.
        await deadlineExecutor(100_000, () => {}).run({
          agent,
          provider,
          toolset: pollToolset(),
          history: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is in this?" },
                { type: "image_ref", ref: "att-1", localPath: file, mimeType: "image/png", filename: "shot.png" },
              ],
              timestamp: Date.now() - 1000,
            },
          ],
          userMessage: { role: "user", content: "watch the build", timestamp: Date.now() },
          gateway: "telegram",
          gatewayId: "telegram:main",
          chatId: "chat-1",
          chatType: "dm",
          sessionId: "session-1",
          senderId: "user-1",
          deadlineAt: Date.now() + 20_000,
        } as never);

        const flat = seenParts.flat();
        // The invariant the serializer enforces, asserted before it gets there.
        expect(flat.filter((p) => p.type === "image_ref")).toHaveLength(0);
        // And the picture actually arrived, rather than being quietly dropped to a placeholder.
        expect(flat.filter((p) => p.type === "image").length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("a deadline the caller never set does not end anything", () => {
    // `deadlineAt` is optional. A caller with no timer has nothing to run out of, and inventing a
    // limit for it would end those turns early for free.
    expect(outOfTimeForAnotherRound({ maxTurnDurationMs: 300_000, now: Date.now() })).toBe(false);
  });

  test("the reserve scales with the turn but stays inside its bounds", () => {
    // A share, because `max_turn_duration_ms` is the operator's to set: 45s is most of a one-minute
    // turn and a rounding error on a half-hour one.
    expect(wrapUpReserveMs(300_000)).toBe(45_000);
    expect(wrapUpReserveMs(60_000)).toBe(20_000);
    expect(wrapUpReserveMs(3_600_000)).toBe(60_000);
  });
});
