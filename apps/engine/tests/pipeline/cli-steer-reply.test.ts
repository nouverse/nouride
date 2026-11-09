/**
 * A message sent to a coding CLI's turn while its prompt runs (0.8.10), through the pipeline with a real CLI process: the
 * line in the agent's own words is said in the chat, and the CLI reads the message with it — and with the rule that a
 * question in it is answered.
 *
 * Live (2026-10-31): "btw yg terkait artifacts tadi udah dipush ya?" went into Claude Code the moment it came — no
 * tool call was open — so the line, ready five seconds later, was dropped as late, and the person had an English
 * "Got it" and nothing in Nix's words. Claude Code looked into the question and its reply never answered it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { STEER_ACK } from "@/modules/pipeline/steering.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const FAKE = join(import.meta.dir, "../external-agents/fixtures/fake-cli.ts");
const benches: Bench[] = [];
const services: ExternalAgents[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const bench of benches.splice(0)) bench.dispose();
});

const LINE = "Oke, gw cek dulu status push-nya.";

describe("a message for a coding CLI's running prompt", () => {
  test("the agent's own line is said first, and the CLI reads the message with it", async () => {
    // The CLI's prompt says "Working." and waits for a steer, which it answers as "Steered: <what it was handed>".
    const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", env: { FAKE_MODE: "steer", FAKE_STEER: "injected", FAKE_STEER_WAIT_MS: "8000" }, modes: { folder: "yolo", risky: "default", all: "default" }, instructionFile: "AGENTS.md" };
    const gateway = new FakeGateway();
    const bench = await pipelineBench({
      gateway,
      agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n',
      // The CLI answers the turn; the model is asked only for the line. However quick, it is written after a CLI with no
      // tool call open would have taken the message: that took it in the same tick it came.
      fetch: () =>
        (async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: LINE }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 9 } }), {
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      configure: (config) => {
        config.queue.steerReply = true;
      },
      deps: (made) => {
        const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => made.config.daemon.workspaceDir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} } });
        services.push(service);
        mkdirSync(privateWorkspace(made.config.daemon.workspaceDir, "nouva"), { recursive: true });
        return { externalAgents: service };
      },
    });
    benches.push(bench);
    bench.pipeline.attach();
    gateway.receive(envelope({ id: "m1", text: "why may an orchestrator not be external?", timestamp: Date.now() }));
    await eventually(() => bench.events.list({ limit: 1_000 }).some((row) => row.kind === "reply"), 10_000, "the CLI's prompt to begin");
    gateway.receive(envelope({ id: "m2", text: "btw yg terkait artifacts tadi udah dipush ya?", timestamp: Date.now() }));
    await eventually(() => bench.turns.forChat("telegram:main", "chat-1").some((turn) => turn.status !== "running"), 15_000, "the turn's end");
    await bench.pipeline.idle();

    // "Got it" at once, then the agent's own line over it.
    expect(gateway.posted).toContain(STEER_ACK);
    expect(gateway.edits.map((edit) => edit.text)).toContain(`↪ ${LINE}`);
    // Handed to the CLI after the line was said: with it, and with the rule for a question — in the one running prompt.
    const answer = gateway.sent.map((message) => message.text).join("\n");
    expect(answer).toContain("Steered: [Gading sent this while you were working.");
    expect(answer).toContain("If it asks you something, answer it in your reply.");
    expect(answer).toContain(`A quick reply went to them in your name before you read this: "${LINE}"`);
    expect(answer).toContain("btw yg terkait artifacts tadi udah dipush ya?");
    expect(bench.turns.forChat("telegram:main", "chat-1")).toHaveLength(1);
  }, 30_000);
});
