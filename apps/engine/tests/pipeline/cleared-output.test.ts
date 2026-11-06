/**
 * A long turn that clears its own tool output keeps it, and the agent can open it again (0.7.25) — through the real
 * pipeline: the trim before each round, the spill store boot gives every daemon, and the `read` tool in the turn's own
 * sandbox. Live, before: the marker said "read it again", and the agent re-ran commands to get back what it had lost.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTextFileIfExists } from "@nouride/runtime";
import type { Tool } from "@nouride/shared";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

/** `lines` lines a call, each output different and remembered whole, as the tool returned it. */
function dump(lines: number, outputs: string[]): Tool {
  return {
    requiresApproval: false,
    definition: { name: "dump", description: "returns a lot", parameters: { type: "object", properties: {} } },
    async execute() {
      const call = outputs.length + 1;
      outputs.push(`PAYLOAD-${call}\n${Array.from({ length: lines }, (_, i) => `${call}:${i} ${"x".repeat(34)}`).join("\n")}`);
      return { content: outputs.at(-1)!, isError: false };
    },
  };
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";

type Request = { messages: { role: string; content: unknown; tool_call_id?: string }[] };
const resultOf = (request: Request | undefined, id: string) => textOf(request?.messages.find((m) => m.tool_call_id === id)?.content);
const KEPT_AT = /kept at (\S+?);/;

/**
 * `dumps` calls of `lines` lines, then a `read` of the path the latest request's marker names, then an answer. The
 * budget is the trim test's in `pipeline.test.ts`: tight, with the newest result kept.
 */
async function run(lines: number, dumps: number) {
  let requests: Request[] = [];
  const outputs: string[] = [];
  const bench = await pipelineBench({
    turns: [
      ...Array.from({ length: dumps }, (_, i) => ({ toolCalls: [{ id: `c${i + 1}`, name: "dump", args: {} }] })),
      {
        // Asked for once the marker is in front of the model, as a model would.
        get toolCalls() {
          return [{ id: "r1", name: "read", args: { path: KEPT_AT.exec(JSON.stringify(requests.at(-1)))?.[1] ?? "missing", offset: 1, limit: 3 } }];
        },
      },
      { text: "read it back" },
    ],
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["dump", "read"]\n',
    config: {
      llm: {
        defaults: { provider: "test", model: "test-model" },
        context: { max_context_ratio: 0.5, compact_at_ratio: 0.5, preserve_recent_tool_results: 1 },
      },
    },
    deps: ({ dataDir }) => ({ spill: new ToolOutputSpill(join(dataDir, "tool-output")) }),
  });
  benches.push(bench);
  requests = bench.requests;
  const tools = createBuiltinTools({ security: bench.config.security });
  tools.set("dump", dump(lines, outputs));
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  bench.gateway.receive(envelope({ text: "dump everything", timestamp: Date.now() }));
  await bench.pipeline.idle();

  const asked = bench.requests as Request[];
  // The request that asked for the read: the first result is a marker there, naming a file.
  const marker = resultOf(asked[dumps], "c1");
  return { bench, asked, outputs, marker, path: KEPT_AT.exec(marker)?.[1], read: resultOf(asked[dumps + 1], "r1") };
}

describe("a tool result cleared inside a long turn", () => {
  test("is moved to a file, whole, the marker says where, and `read` opens it in the next step", async () => {
    // Small enough to reach the context whole, so the trim is what writes the file.
    const r = await run(90, 3);

    expect(resultOf(r.asked[1], "c1")).toBe(r.outputs[0]!);
    expect(r.marker).toStartWith("[earlier tool output moved out of context to make room: 91 lines");
    expect(r.marker).not.toContain("PAYLOAD-1");
    expect(r.path?.startsWith(join(r.bench.dataDir, "tool-output", "nouva") + "/")).toBe(true);
    expect(r.path!.split("/").at(-1)).toStartWith("cleared-c1-");
    expect(await readTextFileIfExists(r.path!)).toBe(r.outputs[0]!);

    // The agent's own `read` opens it: the path is inside a root its sandbox reads.
    expect(r.read).toContain("PAYLOAD-1");
    expect(r.read).toContain("1:0 ");

    // The stored conversation keeps the marker with its path, for a later turn to follow.
    const stored = r.bench.sessions.load({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" }).messages;
    expect(stored.some((m) => m.role === "tool" && textOf(m.content).includes(`kept at ${r.path};`))).toBe(true);
  });

  test("one that was spilled already points at its spilled file, which holds the whole output", async () => {
    const r = await run(200, 2);

    expect(resultOf(r.asked[1], "c1")).toStartWith("[output too large for the context: 201 lines");
    expect(r.marker).toStartWith("[earlier tool output moved out of context to make room: 201 lines");
    expect(r.path!.split("/").at(-1)).toBe("c1.txt");
    expect(await readTextFileIfExists(r.path!)).toBe(r.outputs[0]!);
    expect(r.read).toContain("PAYLOAD-1");
  });
});
