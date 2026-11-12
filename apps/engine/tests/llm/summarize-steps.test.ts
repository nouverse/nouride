/**
 * Room made inside a running turn when its own steps fill the window (`modules/llm/summarize-steps.ts`).
 *
 * Clearing old tool output frees what the steps carried, not the steps. A turn of a few hundred calls ended on an
 * overflow that leaving out earlier turns could not clear, since the running turn is what that net keeps whole. Each
 * case is a way summing the steps up could go wrong: a call left without its result, the history before the turn
 * touched, the newest step lost, notes that cost more than they save, or a turn failed for tidying up.
 */

import { describe, expect, test } from "bun:test";
import { estimateMessagesTokens } from "@nouride/llm";
import type { ChatMessage, LLMProvider } from "@nouride/shared";
import { STEPS_NOTE, sumUpOldSteps } from "@/modules/llm/summarize-steps.ts";

/** A summarizer that keeps what it was asked and answers with `notes`. */
function summarizer(notes: string | (() => never) = "Headline: the disk was checked\n\n## Done\n- Read the logs of four services.") {
  const asked: { messages: ChatMessage[] }[] = [];
  const provider = {
    chat: async (params: { messages: ChatMessage[] }) => {
      asked.push({ messages: params.messages });
      return { text: typeof notes === "function" ? notes() : notes, toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "small" };
    },
  } as unknown as LLMProvider;
  return { provider, asked };
}

const HISTORY: ChatMessage[] = [
  { role: "user", content: "halo", timestamp: 1 },
  { role: "assistant", content: "halo juga", timestamp: 2 },
];
const ASKED: ChatMessage = { role: "user", content: "cek kenapa disk penuh", timestamp: 10 };

/** One step: what the model said and called, and what came back. `weight` is how long its words are. */
function step(n: number, weight = 400): ChatMessage[] {
  return [
    { role: "assistant", content: `step ${n}: ${"thinking about the logs. ".repeat(Math.ceil(weight / 24))}`, toolCalls: [{ id: `call_${n}`, name: "exec", arguments: { command: `du -sh /var/log/svc${n}` } }], timestamp: 10 + n * 2 },
    { role: "tool", content: `${n}G\t/var/log/svc${n}`, toolCallId: `call_${n}`, timestamp: 11 + n * 2 },
  ];
}

const turn = (steps: number, weight?: number): ChatMessage[] => [...HISTORY, ASKED, ...Array.from({ length: steps }, (_, n) => step(n + 1, weight)).flat()];
const START = HISTORY.length + 1;
/** Over its line already, unless a test says where the line is. */
const options = (provider: LLMProvider, fitTokens: number, startTokens = 0) => ({ provider, model: "small", fitTokens, startTokens });

/** Every tool result in `messages` has the call it answers in the reply right before its run of results. */
function pairsWhole(messages: ChatMessage[]): boolean {
  let open = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") open = new Set((message.toolCalls ?? []).map((call) => call.id));
    else if (message.role === "tool" && !open.has(message.toolCallId ?? "")) return false;
  }
  return true;
}

describe("a running turn whose steps fill the window", () => {
  test("its oldest steps become notes at the head of the oldest reply kept, and the newest stay whole", async () => {
    const working = turn(10);
    const { provider, asked } = summarizer();
    const room = (await sumUpOldSteps(working, START, options(provider, estimateMessagesTokens(working) / 3)))!;

    expect(room.steps).toBeGreaterThanOrEqual(5);
    expect(room.steps).toBeLessThan(10);
    expect(room.tokens).toBe(estimateMessagesTokens(room.messages));
    expect(room.tokens).toBeLessThan(estimateMessagesTokens(working));
    // What came before the turn, and what it was asked: the same messages, in place.
    expect(room.messages.slice(0, START)).toEqual(working.slice(0, START));
    for (let index = 0; index < START; index += 1) expect(room.messages[index]).toBe(working[index]!);
    // Then the oldest reply kept, with the notes in front of its own words and its call still on it.
    const oldest = room.messages[START]!;
    const kept = 10 - room.steps;
    expect(oldest.role).toBe("assistant");
    expect(oldest.content as string).toStartWith(`${STEPS_NOTE}\n\nHeadline: the disk was checked`);
    expect(oldest.content as string).toContain(`step ${room.steps + 1}: thinking about the logs.`);
    expect(oldest.toolCalls).toEqual(working[START + room.steps * 2]!.toolCalls);
    // And every step after it as it was.
    expect(room.messages.slice(START + 1)).toEqual(working.slice(START + room.steps * 2 + 1));
    expect(room.messages).toHaveLength(START + kept * 2);
    expect(pairsWhole(room.messages)).toBe(true);
    expect(asked).toHaveLength(1);
  });

  test("the summarizer reads what the turn was asked and the steps that leave, as words: no call or result as a block", async () => {
    const working = turn(10);
    const { provider, asked } = summarizer();
    const room = (await sumUpOldSteps(working, START, options(provider, estimateMessagesTokens(working) / 3)))!;
    const sent = asked[0]!.messages;
    expect(sent.map((message) => message.role)).toEqual(["system", "user"]);
    expect(sent.every((message) => typeof message.content === "string" && message.toolCalls === undefined && message.toolCallId === undefined)).toBe(true);
    const read = sent[1]!.content as string;
    expect(read).toContain("cek kenapa disk penuh");
    expect(read).toContain("→ exec({\"command\":\"du -sh /var/log/svc1\"})");
    expect(read).toContain(`tool result: ${room.steps}G\t/var/log/svc${room.steps}`);
    // What stays is not sent to be summed up, and neither is the conversation before the turn.
    expect(read).not.toContain(`svc${room.steps + 1}`);
    expect(read).not.toContain("halo juga");
  });

  test("the newest steps are kept beside what came before the turn: the room is what that leaves", async () => {
    // A history that takes most of the room, and room left for exactly two steps.
    const long: ChatMessage[] = Array.from({ length: 10 }, (_, n) => ({ role: n % 2 === 0 ? "user" : "assistant", content: `earlier ${n}: ${"x".repeat(1_000)}`, timestamp: n }) as ChatMessage);
    const steps = Array.from({ length: 12 }, (_, n) => step(n + 1));
    const working = [...long, ASKED, ...steps.flat()];
    const fit = estimateMessagesTokens([...long, ASKED]) + estimateMessagesTokens([...steps[10]!, ...steps[11]!]) + 2;
    const { provider } = summarizer();
    const room = (await sumUpOldSteps(working, long.length + 1, options(provider, fit)))!;
    expect(room.steps).toBe(10);
    expect(room.messages.slice(0, long.length + 1)).toEqual([...long, ASKED]);
  });

  test("the newest step stays however large it is: its results are what the model has not read yet", async () => {
    const working = [...turn(3), ...step(4, 40_000)];
    const { provider } = summarizer();
    const room = (await sumUpOldSteps(working, START, options(provider, 200)))!;
    expect(room.steps).toBe(3);
    expect(room.messages.slice(START + 1)).toEqual(working.slice(-1));
    expect(room.messages[START]!.toolCalls?.[0]?.id).toBe("call_4");
    expect(pairsWhole(room.messages)).toBe(true);
  });

  test("a message the harness put after a step's results leaves or stays with that step", async () => {
    const opened: ChatMessage = { role: "user", content: "[harness] The pictures you opened are below.", timestamp: 20 };
    const working = [...HISTORY, ASKED, ...step(1), opened, ...step(2), ...step(3), ...step(4)];
    const { provider, asked } = summarizer();
    const room = (await sumUpOldSteps(working, START, options(provider, estimateMessagesTokens([...HISTORY, ASKED, ...step(3), ...step(4)]) + 5)))!;
    expect(room.steps).toBe(2);
    expect(asked[0]!.messages[1]!.content as string).toContain("The pictures you opened are below.");
    expect(room.messages.some((message) => message === opened)).toBe(false);
    // No two messages of one role in a row where the notes went in.
    const roles = room.messages.slice(START - 1).map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
  });

  test("a second time in the same turn, the notes written before are read again and folded into the new ones", async () => {
    const first = summarizer("Headline: first notes\n\n## Done\n- svc1 to svc6 are small.");
    const once = (await sumUpOldSteps(turn(10), START, options(first.provider, 600)))!;
    const longer = [...once.messages, ...step(11), ...step(12), ...step(13), ...step(14)];
    const second = summarizer("Headline: second notes");
    const twice = (await sumUpOldSteps(longer, START, options(second.provider, 600)))!;
    expect(second.asked[0]!.messages[1]!.content as string).toContain("Headline: first notes");
    expect(twice.messages[START]!.content as string).toStartWith(`${STEPS_NOTE}\n\nHeadline: second notes`);
    expect((twice.messages[START]!.content as string).split(STEPS_NOTE)).toHaveLength(2);
    expect(pairsWhole(twice.messages)).toBe(true);
  });
});

describe("where there is nothing to gain", () => {
  test("under the line that starts it, the turn goes on as it is, though its steps would not all fit the room", async () => {
    const working = turn(10);
    const weighs = estimateMessagesTokens(working);
    const { provider, asked } = summarizer();
    expect(await sumUpOldSteps(working, START, options(provider, weighs / 3, weighs))).toBeNull();
    expect(await sumUpOldSteps(working, START, options(provider, weighs / 3, weighs + 500))).toBeNull();
    expect(asked).toHaveLength(0);
    // One token past it, and it is.
    expect(await sumUpOldSteps(working, START, options(provider, weighs / 3, weighs - 1))).not.toBeNull();
  });

  test("one step, or none: nothing is asked of a model", async () => {
    for (const steps of [0, 1]) {
      const { provider, asked } = summarizer();
      expect(await sumUpOldSteps(turn(steps), START, options(provider, 1))).toBeNull();
      expect(asked).toHaveLength(0);
    }
  });

  test("every step fits beside what came before: nothing is asked", async () => {
    const working = turn(6);
    const { provider, asked } = summarizer();
    expect(await sumUpOldSteps(working, START, options(provider, estimateMessagesTokens(working) + 10))).toBeNull();
    expect(asked).toHaveLength(0);
  });

  test("what came before the turn is what fills the window: its few small steps are not summed up, request after request", async () => {
    // A long history the turn began with, and three small steps: summing them up frees nothing worth a model call.
    const long: ChatMessage[] = Array.from({ length: 40 }, (_, n) => ({ role: n % 2 === 0 ? "user" : "assistant", content: `earlier ${n}: ${"x".repeat(2_000)}`, timestamp: n }) as ChatMessage);
    const working = [...long, ASKED, ...step(1, 40), ...step(2, 40), ...step(3, 40)];
    const { provider, asked } = summarizer();
    expect(await sumUpOldSteps(working, long.length + 1, options(provider, 8_000))).toBeNull();
    expect(asked).toHaveLength(0);
  });

  test("notes no smaller than the steps they would stand for are not kept: the steps stay as they were", async () => {
    const working = turn(4, 40);
    const { provider, asked } = summarizer(`Headline: everything, at length\n\n${"A very long restatement of very little. ".repeat(400)}`);
    expect(await sumUpOldSteps(working, START, options(provider, 50))).toBeNull();
    expect(asked).toHaveLength(1);
  });

  test("a turn whose own messages do not begin with a reply is no shape to cut", async () => {
    const working = [...HISTORY, ASKED, { role: "tool", content: "orphan", toolCallId: "x", timestamp: 12 } as ChatMessage, ...step(1), ...step(2), ...step(3)];
    const { provider, asked } = summarizer();
    expect(await sumUpOldSteps(working, START, options(provider, 10))).toBeNull();
    expect(asked).toHaveLength(0);
  });

  test("a summarizer that fails is the caller's to hear of", async () => {
    const { provider } = summarizer(() => {
      throw new Error("the summarizer is down");
    });
    await expect(sumUpOldSteps(turn(10), START, options(provider, 100))).rejects.toThrow("the summarizer is down");
  });
});
