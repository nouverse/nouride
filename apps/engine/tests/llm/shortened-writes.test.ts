/**
 * What old `write` and `edit` calls carried is shortened inside a long turn, as old tool output is.
 *
 * Only tool results were trimmed between rounds, and a write's result is one line. The file text sits in the call's
 * arguments, which nothing touched; the overflow retry keeps the running turn and drops only history, so a long coding
 * turn (250 rounds are allowed) carried every file it wrote until the window ran out, and failed near its end.
 */

import { describe, expect, test } from "bun:test";
import { estimateMessagesTokens } from "@nouride/llm";
import { LLMError, messageText, type ChatMessage, type ChatParams, type LLMProvider, type Tool } from "@nouride/shared";
import { sendsShortenedArgument, trimToolResults } from "@/modules/llm/context.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { editTool, multiEditTool, writeTool } from "@/modules/tools/builtins/files.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

/** A file's text: lines of words, the way the estimator meets source code. */
const fileText = (tag: string, chars: number): string =>
  Array.from({ length: Math.ceil(chars / 20) }, (_, i) => `${tag} line ${i}: const value = compute(${i});`).join("\n").slice(0, chars);

const bulkOf = (name: string): readonly string[] | undefined =>
  ({ write: writeTool.bulkArguments, edit: editTool.bulkArguments, multi_edit: multiEditTool.bulkArguments })[name];

const SHORTENED = /^\[sent with this call and left out of the context to make room once it ran: (\d+) characters, (\d+) lines\. The call's result says what it did; read the file to see it as it is now\]$/;

function written(id: string, path: string, content: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "write", arguments: { path, content } }] },
    { role: "tool", content: `Created ${path} (${content.length} chars).`, toolCallId: id },
  ];
}

describe("the tools that carry a file's text say which arguments hold it", () => {
  test("write its content, edit its two strings, multi_edit its list", () => {
    expect(writeTool.bulkArguments).toEqual(["content"]);
    expect(editTool.bulkArguments).toEqual(["old_string", "new_string"]);
    expect(multiEditTool.bulkArguments).toEqual(["edits"]);
  });
});

describe("shortening old calls", () => {
  const conversation = (): ChatMessage[] => [
    { role: "user", content: "write the three files" },
    ...written("w1", "a.ts", fileText("A", 8_000)),
    ...written("w2", "b.ts", fileText("B", 8_000)),
    ...written("w3", "c.ts", fileText("C", 8_000)),
  ];

  test("the oldest first, only as far as needed, and every call keeps its id, its path and its result", () => {
    const messages = conversation();
    const result = trimToolResults(messages, { maxTokens: estimateMessagesTokens(messages) - 100, keepRecent: 3, bulkArguments: bulkOf });

    expect(result.shortened).toBe(1);
    expect(result.trimmed).toBe(0);
    const calls = result.messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((call) => call.id)).toEqual(["w1", "w2", "w3"]);
    expect(calls.map((call) => call.arguments.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    // Said as a call that ran: its size, where its outcome is, and where the text is now.
    const said = SHORTENED.exec(String(calls[0]!.arguments.content));
    expect(said?.[1]).toBe("8000");
    expect(said?.[2]).toBe(String(fileText("A", 8_000).split("\n").length));
    expect(calls[1]!.arguments.content).toBe(fileText("B", 8_000));
    // Results untouched: the success the model reads is still there beside the shortened call.
    expect(result.messages.filter((message) => message.role === "tool").map((message) => messageText(message.content))).toEqual(
      messages.filter((message) => message.role === "tool").map((message) => messageText(message.content)),
    );
    // The input is not changed under its caller.
    expect(messages[1]!.toolCalls![0]!.arguments.content).toBe(fileText("A", 8_000));
  });

  test("the newest round is as the model sent it, however full the context", () => {
    const result = trimToolResults(conversation(), { maxTokens: 0, keepRecent: 0, bulkArguments: bulkOf });
    const calls = result.messages.flatMap((message) => message.toolCalls ?? []);
    expect(SHORTENED.test(String(calls[0]!.arguments.content))).toBe(true);
    expect(SHORTENED.test(String(calls[1]!.arguments.content))).toBe(true);
    expect(calls[2]!.arguments.content).toBe(fileText("C", 8_000));
  });

  test("a call with no result yet is left whole: shortened, it would be a call the model never sees answered", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write", arguments: { path: "a.ts", content: fileText("A", 8_000) } }] },
      { role: "assistant", content: "next" },
    ];
    const result = trimToolResults(messages, { maxTokens: 0, keepRecent: 0, bulkArguments: bulkOf });
    expect(result.messages[1]!.toolCalls![0]!.arguments.content).toBe(fileText("A", 8_000));
  });

  test("an edit's two strings, and a multi_edit's list in its own shape, long strings only", () => {
    const old = fileText("OLD", 2_000);
    const messages: ChatMessage[] = [
      { role: "user", content: "change them" },
      { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "edit", arguments: { path: "a.ts", old_string: old, new_string: fileText("NEW", 3_000), replace_all: false } }] },
      { role: "tool", content: "Replaced 1 occurrence(s) in a.ts.", toolCallId: "e1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "m1", name: "multi_edit", arguments: { path: "b.ts", edits: [{ old_string: "short", new_string: fileText("LONG", 2_000) }] } }],
      },
      { role: "tool", content: "Applied 1 edit(s) to b.ts.", toolCallId: "m1" },
      ...written("w9", "c.ts", "tiny"),
    ];
    const calls = trimToolResults(messages, { maxTokens: 0, keepRecent: 0, bulkArguments: bulkOf }).messages.flatMap((message) => message.toolCalls ?? []);

    expect(SHORTENED.test(String(calls[0]!.arguments.old_string))).toBe(true);
    expect(SHORTENED.test(String(calls[0]!.arguments.new_string))).toBe(true);
    expect(calls[0]!.arguments.replace_all).toBe(false);
    const edits = calls[1]!.arguments.edits as { old_string: string; new_string: string }[];
    expect(edits).toHaveLength(1);
    expect(edits[0]!.old_string).toBe("short");
    expect(SHORTENED.test(edits[0]!.new_string)).toBe(true);
  });

  test("old tool output goes first; the calls only when that was not enough", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "read, then write" },
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read", arguments: { path: "x.ts" } }] },
      { role: "tool", content: fileText("READ", 8_000), toolCallId: "r1" },
      ...written("w1", "a.ts", fileText("A", 8_000)),
      ...written("w2", "b.ts", "tiny"),
    ];
    const fits = trimToolResults(messages, { maxTokens: estimateMessagesTokens(messages) - 100, keepRecent: 0, bulkArguments: bulkOf });
    expect(fits.trimmed).toBe(1);
    expect(fits.shortened).toBeUndefined();
  });

  test("without the tools' declaration no call is shortened — the result trimmer as it was", () => {
    const result = trimToolResults(conversation(), { maxTokens: 0, keepRecent: 0 });
    expect(result.shortened).toBeUndefined();
    expect(result.messages.flatMap((message) => message.toolCalls ?? []).every((call) => !SHORTENED.test(String(call.arguments.content)))).toBe(true);
  });
});

describe("the note sent back as text", () => {
  const note = (): string => {
    const result = trimToolResults(written("w1", "a.ts", fileText("A", 1_000)).concat(written("w2", "b.ts", "x")), { maxTokens: 0, keepRecent: 0, bulkArguments: bulkOf });
    return String(result.messages[0]!.toolCalls![0]!.arguments.content);
  };

  test("is recognised, in a write and inside a multi_edit's list", () => {
    expect(sendsShortenedArgument({ path: "a.ts", content: note() }, ["content"])).toBe(true);
    expect(sendsShortenedArgument({ path: "a.ts", edits: [{ old_string: "a", new_string: note() }] }, ["edits"])).toBe(true);
  });

  test("a file that quotes it, or an argument not carrying text, is not", () => {
    expect(sendsShortenedArgument({ content: `const marker = "${note()}";` }, ["content"])).toBe(false);
    expect(sendsShortenedArgument({ path: note(), content: "x" }, ["content"])).toBe(false);
  });
});

/** An endpoint with a window, which refuses a call without its result as the providers do, and records what it was sent. */
function endpoint(script: (round: number) => ChatParams["messages"][number]["toolCalls"] | string, windowTokens: number) {
  const seen: ChatMessage[][] = [];
  let round = 0;
  const provider = {
    async chat(params: ChatParams) {
      // A copy: what was sent, not the turn's list as it grows after.
      seen.push(structuredClone(params.messages));
      const calls = params.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id));
      const answered = params.messages.flatMap((message) => (message.role === "tool" && message.toolCallId ? [message.toolCallId] : []));
      if (calls.join() !== answered.join()) throw new LLMError("tool_use ids were found without tool_result blocks", 400);
      if (estimateMessagesTokens(params.messages) > windowTokens) {
        throw new LLMError("prompt is too long", 400, { failure: { class: "context_overflow", action: "shrink", alertOperator: false, operatorHint: "" } });
      }
      round += 1;
      const next = script(round);
      // No input count: one would teach the executor a token scale this test does not mean to set.
      const usage = { inputTokens: 0, outputTokens: 1, estimated: true as const };
      return typeof next === "string"
        ? { text: next, toolCalls: [], stopReason: "stop", usage, model: params.model }
        : { text: "", toolCalls: next, stopReason: "tool_use", usage, model: params.model };
    },
  } as unknown as LLMProvider;
  return { provider, seen };
}

function runTurn(provider: LLMProvider, wrote: string[]) {
  const write: Tool = {
    ...writeTool,
    requiresApproval: false,
    execute: async (args) => {
      wrote.push(String(args.path));
      return { content: `Created ${String(args.path)} (${String(args.content).length} chars).`, isError: false };
    },
  };
  const toolset = {
    definitions: [write.definition],
    get: (name: string) => (name === "write" ? write : undefined),
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as unknown as AgentToolset;
  const agent = fakeAgent();
  agent.config.llm = { provider: "nougate", model: "primary", maxTokens: 1024, temperature: 0, contextWindow: 40_000 };
  const activity: string[] = [];
  const result = new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 30, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onActivity: (kind, text) => void activity.push(`${kind}: ${text}`),
  }).run({
    agent, provider, toolset, history: [],
    userMessage: { role: "user", content: "write the module, file by file", timestamp: 1 },
    gateway: "web", gatewayId: "web:dashboard", chatId: "chat-1", chatType: "dm", sessionId: "s1", senderId: "u1",
  });
  return { result, activity };
}

describe("a long turn of large writes", () => {
  const WRITES = 14;
  const CHARS = 20_000;
  /** What the endpoint takes: the window less the reply, which every estimate of the messages must stay under. */
  const WINDOW = 40_000 * 0.8 - 1024;

  test("finishes under a window its writes alone would fill twice over, the newest round whole in every request", async () => {
    const { provider, seen } = endpoint(
      (round) => (round <= WRITES ? [{ id: `w${round}`, name: "write", arguments: { path: `src/f${round}.ts`, content: fileText(`F${round}`, CHARS) } }] : "all written"),
      WINDOW,
    );
    // The premise: carried whole, the writes are far past the window.
    expect(estimateMessagesTokens(written("w", "f.ts", fileText("F", CHARS))) * WRITES).toBeGreaterThan(WINDOW * 2);

    const wrote: string[] = [];
    const { result, activity } = runTurn(provider, wrote);

    expect((await result).text).toBe("all written");
    expect(wrote).toHaveLength(WRITES);
    expect(activity.some((line) => /shortened the text of \d+ earlier write\(s\) to make room/.test(line))).toBe(true);
    for (const messages of seen.slice(1)) {
      const newest = messages.findLast((message) => message.role === "assistant")!;
      expect(String(newest.toolCalls![0]!.arguments.content)).toHaveLength(CHARS);
    }
  });

  test("a write that sends the note back as its text is not run, and says why", async () => {
    let note = "";
    const { provider, seen } = endpoint((round) => {
      if (round <= 6) return [{ id: `w${round}`, name: "write", arguments: { path: `src/f${round}.ts`, content: fileText(`F${round}`, CHARS) } }];
      if (round === 7) {
        note = String(seen.at(-1)!.flatMap((message) => message.toolCalls ?? []).find((call) => SHORTENED.test(String(call.arguments.content)))?.arguments.content ?? "");
        return [{ id: "w7", name: "write", arguments: { path: "src/f1.ts", content: note } }];
      }
      return "done";
    }, WINDOW);

    const wrote: string[] = [];
    const { result } = runTurn(provider, wrote);
    await result;

    expect(note).not.toBe("");
    // The six real writes ran; the seventh, carrying the note, did not.
    expect(wrote).toHaveLength(6);
    const answer = seen.at(-1)!.find((message) => message.toolCallId === "w7");
    expect(messageText(answer!.content)).toStartWith("Not run: that is the note left in place of an earlier call's text, not the text.");
  });
});
