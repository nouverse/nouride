/**
 * What an agent keeps in its MEMORY.md is in the prompt of its next turn, in every chat, through the real pipeline.
 *
 * The file was read as the pack loaded and never again: an agent kept a standing request with `memory_write`, said it
 * was kept for every chat, and the next chat that asked knew nothing of it until the daemon restarted. The agent's own
 * prompt says the copy it is shown is stale only for the rest of the turn that wrote it.
 */

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeTextFile } from "@nouride/runtime";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope as envelopeAt } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

/** A message of now: one older than the daemon is not answered. */
const envelope = (overrides: Parameters<typeof envelopeAt>[0] = {}) => envelopeAt({ timestamp: Date.now(), ...overrides });

const benches: Bench[] = [];
afterEach(async () => {
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";

/** The system prompt of the `n`th request the model was sent. */
function systemOf(bench: Bench, n: number): string {
  const messages = (bench.requests[n] as { messages?: { role: string; content: unknown }[] } | undefined)?.messages ?? [];
  return messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n");
}

async function daemon(turns: NonNullable<Parameters<typeof pipelineBench>[0]>["turns"], tools: string[]): Promise<Bench> {
  const bench = await pipelineBench({
    turns,
    agents: [{ id: "nouva", memory: "# Memory\n\nA line kept before the daemon started.\n" }],
    agentToml: `[llm]\nprovider = "test"\n\n[tools]\nenabled = [${tools.map((name) => `"${name}"`).join(", ")}]\napproval_required = []\n`,
    configure: (config) => {
      config.queue.steerReply = false;
    },
  });
  benches.push(bench);
  bench.pipeline.setTools(createBuiltinTools({ security: bench.config.security }));
  bench.pipeline.attach();
  return bench;
}

const KEPT = "Standing request: send the car's fuel code when its owner asks.";

test("a line kept with memory_write is in the next turn's prompt, in the chat that kept it and in another", async () => {
  const bench = await daemon(
    [{ toolCalls: [{ id: "c1", name: "memory_write", args: { mode: "append", content: KEPT } }] }, { text: "Kept." }, { text: "Here it is." }, { text: "Here too." }],
    ["memory_write"],
  );

  bench.gateway.receive(envelope({ id: "m1", text: "keep this for every chat" }));
  await bench.pipeline.idle();
  // The turn that wrote it: its prompt was built before the write, and the agent is told so.
  expect(systemOf(bench, 0)).toContain("A line kept before the daemon started.");
  expect(systemOf(bench, 1)).not.toContain(KEPT);

  bench.gateway.receive(envelope({ id: "m2", text: "send the code" }));
  await bench.pipeline.idle();
  expect(systemOf(bench, 2)).toContain(KEPT);
  expect(systemOf(bench, 2)).toContain("A line kept before the daemon started.");

  bench.gateway.receive(envelope({ id: "m3", chatId: "chat-2", senderId: "user-2", senderName: "Rina", text: "what do you keep?" }));
  await bench.pipeline.idle();
  expect(bench.requests).toHaveLength(4);
  expect(systemOf(bench, 3)).toContain(KEPT);
});

test("a MEMORY.md changed on disk between two turns, by anything, is what the next turn reads", async () => {
  const bench = await daemon([{ text: "First." }, { text: "Second." }], []);

  bench.gateway.receive(envelope({ id: "m1", text: "hello" }));
  await bench.pipeline.idle();
  expect(systemOf(bench, 0)).toContain("A line kept before the daemon started.");

  await writeTextFile(join(bench.agentsDir, "nouva", "MEMORY.md"), `# Memory\n\n${KEPT}\n`);

  bench.gateway.receive(envelope({ id: "m2", text: "hello again" }));
  await bench.pipeline.idle();
  expect(systemOf(bench, 1)).toContain(KEPT);
  expect(systemOf(bench, 1)).not.toContain("A line kept before the daemon started.");
});
