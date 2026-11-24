/**
 * A tool result that is the turn's alone (`ToolResult.turnOnly`), through the real pipeline: the model is shown it for
 * the rest of the turn that asked, and nothing that outlasts the turn holds it.
 *
 * It is what one person told an agent in private, read in a group on a turn they are the one speaking. The next
 * person's turn reads the same conversation, the same journal after a restart, and the same folder of kept tool
 * output: each is looked at here for the words the result held.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, Tool } from "@nouride/shared";
import { pruneToolOutputs, trimToolResults } from "@/modules/llm/context.ts";
import { keptOf, withinRoom } from "@/modules/llm/executor/turn-only.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope as envelopeAt, tempDir } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

/** A message of now: one older than the daemon is not answered. */
const envelope = (overrides: Parameters<typeof envelopeAt>[0] = {}) => envelopeAt({ timestamp: Date.now(), ...overrides });

const benches: Bench[] = [];
afterEach(async () => {
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

const SECRET = "PLATE-BG-1891-ZD";
const LINE = "[What was read here was one person's own, shown for that turn only.]";

/** Every file under a folder, read: what a later turn's `read` could open. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [readFileSync(full, "utf8")];
  });
}

/** The turn journal's rows as each request to the model went out: read while the turn runs, since a turn that ends clears them. */
const journalAt: string[] = [];

async function daemon(turns: NonNullable<Parameters<typeof pipelineBench>[0]>["turns"], result: () => string) {
  journalAt.length = 0;
  let made: Bench | undefined;
  const own: Tool = {
    requiresApproval: false,
    definition: { name: "own", description: "reads what is the speaker's own", parameters: { type: "object", properties: {} } },
    async execute() {
      return { content: result(), isError: false, turnOnly: LINE };
    },
  };
  const bench = await pipelineBench({
    turns,
    fetch: (scripted) =>
      (async (...args: Parameters<typeof fetch>) => {
        journalAt.push(made ? JSON.stringify(made.db.prepare<Record<string, unknown>>("SELECT * FROM turn_journal").all()) : "");
        return await scripted(...args);
      }) as typeof fetch,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["own"]\napproval_required = []\n',
    configure: (config) => {
      config.queue.steerReply = false;
    },
    deps: ({ dataDir }) => ({ spill: new ToolOutputSpill(join(dataDir, "tool-output")) }),
  });
  made = bench;
  benches.push(bench);
  const tools = createBuiltinTools({ security: bench.config.security });
  tools.set("own", own);
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  return bench;
}

const sent = (bench: Bench, n: number) => JSON.stringify(bench.requests[n] ?? null);
const ASK = [{ toolCalls: [{ id: "c1", name: "own", args: {} }] }, { text: "Here it is." }, { text: "Nothing of that here." }];

describe("a result that is the turn's alone", () => {
  test("is in the turn's own next request, and neither in the conversation kept nor in the next turn's request", async () => {
    const bench = await daemon(ASK, () => `The car's plate is ${SECRET}.`);

    bench.gateway.receive(envelope({ id: "m1", text: "what is my plate" }));
    await bench.pipeline.idle();
    expect(sent(bench, 1)).toContain(SECRET);

    const kept = bench.sessions.load({ agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" }).messages;
    const result = kept.find((message) => message.role === "tool")!;
    expect(result).toMatchObject({ role: "tool", content: LINE, toolCallId: "c1" });
    expect(result).not.toHaveProperty("turnOnly");
    expect(JSON.stringify(kept)).not.toContain(SECRET);

    bench.gateway.receive(envelope({ id: "m2", senderId: "user-2", senderName: "Rina", text: "what did it read just now?" }));
    await bench.pipeline.idle();
    expect(bench.requests).toHaveLength(3);
    expect(sent(bench, 2)).toContain(LINE);
    expect(sent(bench, 2)).not.toContain(SECRET);
  });

  test("is journaled as its line: a turn brought back after a restart holds none of it", async () => {
    const bench = await daemon(ASK, () => `The car's plate is ${SECRET}.`);
    bench.gateway.receive(envelope({ id: "m1", text: "what is my plate" }));
    await bench.pipeline.idle();
    // As the turn's second request went out, the result was in the journal: as its line.
    expect(journalAt).toHaveLength(2);
    expect(journalAt[1]).toContain("What was read here was one person");
    expect(journalAt[1]).not.toContain(SECRET);
  });

  test("too long for a result's room, it is cut and said so, and written to no file", async () => {
    const long = `${`${SECRET} `.repeat(40_000)}THE-END`;
    const bench = await daemon(ASK, () => long);
    bench.gateway.receive(envelope({ id: "m1", text: "everything about my car" }));
    await bench.pipeline.idle();

    expect(sent(bench, 1)).toContain(SECRET);
    expect(sent(bench, 1)).not.toContain("THE-END");
    expect(sent(bench, 1)).toContain("Cut here: the rest is not kept anywhere, since this is one person's own.");
    expect(filesUnder(join(bench.dataDir, "tool-output")).filter((text) => text.includes(SECRET))).toEqual([]);
  });

  test("the same tool's result with no such mark is kept whole and written to a file, as every result is", async () => {
    // What the three tests above would pass against if nothing were ever kept: an ordinary long result is.
    const long = `${`${SECRET} `.repeat(40_000)}THE-END`;
    const plain: Tool = {
      requiresApproval: false,
      definition: { name: "own", description: "reads a long thing", parameters: { type: "object", properties: {} } },
      execute: async () => ({ content: long, isError: false }),
    };
    const bench = await daemon(ASK, () => "");
    const tools = createBuiltinTools({ security: bench.config.security });
    tools.set("own", plain);
    bench.pipeline.setTools(tools);
    bench.gateway.receive(envelope({ id: "m1", text: "everything about my car" }));
    await bench.pipeline.idle();
    expect(filesUnder(join(bench.dataDir, "tool-output")).some((text) => text.includes("THE-END"))).toBe(true);
    expect(JSON.stringify(bench.sessions.load({ agentId: "nouva", chatId: "chat-1", gatewayId: "telegram:main" }).messages)).toContain(SECRET);
  });
});

describe("the pieces", () => {
  const message = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "tool", content: `${SECRET} `.repeat(2_000), toolCallId: "c1", timestamp: 1, ...extra });

  test("what the conversation keeps of a message: its line and no mark, or the message as it is", () => {
    expect(keptOf(message({ turnOnly: LINE }))).toEqual({ role: "tool", content: LINE, toolCallId: "c1", timestamp: 1 });
    const plain = message();
    expect(keptOf(plain)).toBe(plain);
  });

  test("a result within its room is left alone, and one past it is cut at a word", () => {
    const short = { content: "A short one.", isError: false, turnOnly: LINE };
    expect(withinRoom(short, 1_000)).toBe(short);
    const cut = withinRoom({ content: "word ".repeat(1_000), isError: false, turnOnly: LINE }, 200);
    expect(cut.content.length).toBeLessThan(400);
    expect(cut.content).toContain("[Cut here: the rest is not kept anywhere");
    expect(cut.turnOnly).toBe(LINE);
  });

  test("cleared to make room, it is kept in no file, where an ordinary result is", () => {
    const root = tempDir("turn-only-spill");
    const spill = new ToolOutputSpill(root);
    const scope = { agentId: "nouva", sessionId: "s1" };
    const conversation = (extra: Partial<ChatMessage>): ChatMessage[] => [
      { role: "user", content: "one" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "own", arguments: {} }] },
      message(extra),
      { role: "user", content: "two" },
      { role: "assistant", content: "done" },
    ];

    const between = pruneToolOutputs(conversation({ turnOnly: LINE }), { protectTokens: 0, minSavingsTokens: 1, keep: spill.keeperFor(scope) });
    expect(between.pruned).toBe(1);
    const inTurn = trimToolResults(conversation({ turnOnly: LINE }), { maxTokens: 10, targetTokens: 10, keepRecent: 0, keep: spill.keeperFor(scope) });
    expect(JSON.stringify(inTurn.messages)).not.toContain(SECRET);
    expect(filesUnder(root)).toEqual([]);
    // And it is still the turn's alone after being cleared: the line takes its place at the turn's end.
    expect(keptOf(between.messages[2]!).content).toBe(LINE);

    pruneToolOutputs(conversation({}), { protectTokens: 0, minSavingsTokens: 1, keep: spill.keeperFor(scope) });
    expect(filesUnder(root).some((text) => text.includes(SECRET))).toBe(true);
  });
});
