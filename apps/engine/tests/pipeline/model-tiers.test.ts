/**
 * The three model tiers (0.8.0, SIMPLIFY §3), through the real pipeline: the agent picks one with `tier` on the work it
 * starts, and the work runs on that model — a helper on its own agent's, an asked agent on that agent's. The install
 * names `small_model` and `high_model` in `[llm.defaults]`; a pack's own beats them; unsaid is `default`, the agent's
 * model. And the agent is told the three, what each is for, and which models they are.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { peersFrom } from "@/modules/tools/builtins/ask-agent.ts";
import { envelope } from "../helpers.ts";
import { eventually } from "../wait.ts";
import { pipelineBench, type Bench, type BenchOptions } from "../pipeline-bench.ts";

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "ask_agent"]\napproval_required = []\n';
/** Nox names its own small model, and leaves high to the install. */
const NOX = '[llm]\nprovider = "test"\nsmall_model = "nox-small"\n\n[tools]\nenabled = ["delegate"]\napproval_required = []\n';

const benches: Bench[] = [];
afterEach(async () => {
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

async function daemon(turns: NonNullable<BenchOptions["turns"]>): Promise<Bench> {
  const bench = await pipelineBench({
    turns,
    agents: [
      { id: "nouva", configToml: PACK },
      { id: "nox", configToml: NOX },
    ],
    config: {
      daemon: { orchestrator: "nouva" },
      agents: { mentions_enabled: true },
      llm: { defaults: { provider: "test", model: "test-model", small_model: "m-small", high_model: "m-high" } },
    },
  });
  benches.push(bench);
  const tools = createBuiltinTools({
    security: bench.config.security,
    runSubagent: bench.pipeline.subagentRunner(),
    askAgent: { run: bench.pipeline.peerTurnRunner(), ...peersFrom(bench.registry, () => true) },
  });
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  return bench;
}

const BRIEF = { goal: "Check the free disk on the box.", context: "The data lives under /srv.", deliverable: "Free space, in GB." };

async function ask(bench: Bench, text: string, answer: string): Promise<void> {
  bench.gateway.receive(envelope({ id: "m1", text, timestamp: Date.now() }));
  await eventually(() => bench.gateway.sent.some((message) => message.text === answer), 5_000, "the agent's answer");
}

const systemOf = (request: { messages: { role: string; content: unknown }[] }) => {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
};

describe("a helper on a tier", () => {
  test("`small` runs it on the install's small model; the agent itself stays on its own", async () => {
    const bench = await daemon([
      { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [BRIEF], tier: "small" } }] },
      { text: "40 GB free." },
      { text: "Masih 40 GB." },
    ]);
    await ask(bench, "disk masih lega?", "Masih 40 GB.");
    expect(bench.requests.map((request) => request.model)).toEqual(["test-model", "m-small", "test-model"]);
  });

  test("unsaid, it is `default` — the agent's own model, as every helper ran before tiers", async () => {
    const bench = await daemon([
      { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [BRIEF] } }] },
      { text: "40 GB free." },
      { text: "Masih 40 GB." },
    ]);
    await ask(bench, "disk masih lega?", "Masih 40 GB.");
    expect(bench.requests[1]?.model).toBe("test-model");
  });

  test("a tier that is not one is refused, with the three named, and nothing starts", async () => {
    const bench = await daemon([
      { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [BRIEF], tier: "cheap" } }] },
      { text: "Salah tier." },
    ]);
    await ask(bench, "disk masih lega?", "Salah tier.");
    expect(bench.requests).toHaveLength(2);
    const told = JSON.stringify(bench.requests[1]?.messages.at(-1));
    expect(told).toContain("`tier` is one of small, default, high");
  });
});

describe("another agent asked on a tier", () => {
  test("answers on its own model of that tier: its pack's small, the install's high", async () => {
    const bench = await daemon([
      { toolCalls: [{ id: "a1", name: "ask_agent", args: { agent: "nox", task: "Is the build green? Say yes or no.", tier: "small" } }] },
      { text: "yes" },
      { toolCalls: [{ id: "a2", name: "ask_agent", args: { agent: "nox", task: "Review the release notes for mistakes.", tier: "high" } }] },
      { text: "two typos" },
      { text: "Build hijau, notes ada dua typo." },
    ]);
    await ask(bench, "cek build sama notes ya", "Build hijau, notes ada dua typo.");
    expect(bench.requests.map((request) => request.model)).toEqual(["test-model", "nox-small", "test-model", "m-high", "test-model"]);
  });
});

describe("what the agent is told", () => {
  test("the three tiers, what each is for, what each costs against the others, and which models they are here", async () => {
    const bench = await daemon([{ text: "Halo." }]);
    await ask(bench, "halo", "Halo.");
    const system = systemOf(bench.requests[0]!);
    expect(system).toContain("Work you hand off with `delegate` and `ask_agent` runs on one of three model tiers, chosen with `tier`");
    expect(system).toContain("`small` is the cheapest, for quick and simple work");
    expect(system).toContain("`default` is for most work, and is what runs when you leave `tier` out");
    expect(system).toContain("`high` is the strongest and the dearest, for hard work that has to be right");
    expect(system).toContain("Pick the cheapest that will do the job well");
    expect(system).toContain("Your tiers here: small is m-small, default is test-model, high is m-high.");
    expect(system).toContain("With `ask_agent` the tier is the other agent's own: its small, default or high model.");
    // Words, never money: Nouride does not know what a box's models cost.
    expect(system).not.toMatch(/\$\d|per million|USD/);
  });
});
