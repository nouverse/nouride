/**
 * The bubble while the model works after its steps (0.8.7), through the pipeline: a coding CLI's turn with a real CLI
 * process, and a model's turn — one bubble serves both.
 *
 * A person's bubble read `[nix] ✓ 1 step · 166s`: the one step took 18 s, and the other 148 s Claude Code wrote a long
 * reply with nothing on the bubble to say so. To a person waiting, it looked like a hang.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually, sleep } from "../wait.ts";

const FAKE = join(import.meta.dir, "../external-agents/fixtures/fake-cli.ts");
const benches: Bench[] = [];
const services: ExternalAgents[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const bench of benches.splice(0)) bench.dispose();
});

const said = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

async function turnOn(gateway: FakeGateway, bench: Bench): Promise<string[]> {
  bench.pipeline.attach();
  gateway.receive(envelope({ id: "m1", text: "who wrote the build script?", timestamp: Date.now() }));
  await eventually(() => bench.turns.forChat("telegram:main", "chat-1").some((turn) => turn.status !== "running"), 10_000, "the turn's end");
  await bench.pipeline.idle();
  return gateway.edits.map((edit) => edit.text);
}

describe("the bubble after the last step", () => {
  test("says a coding CLI is writing its reply, while it does", async () => {
    // One step, then a long reply written a letter at a time, every 15 ms. The bubble says "writing" only when a piece
    // came within half a tick of the tick (100 ms here), so the pieces come several times faster than that: three
    // pieces 250 ms apart needed a tick to land just after one, and on a busy machine none did.
    const REPLY = "Mira wrote it in March, and Nix fixed it since.";
    const script = [{ sessionUpdate: "tool_call", toolCallId: "t1", title: "git log", kind: "execute", name: "Bash", status: "in_progress", rawInput: { command: "git log" } }, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }, ...[...REPLY].flatMap((letter) => [{ sleep: 15 }, said(letter)])];
    const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", env: { FAKE_MODE: "script", FAKE_SCRIPT: JSON.stringify(script) }, modes: { folder: "yolo", risky: "default", all: "default" }, instructionFile: "AGENTS.md" };
    const gateway = new FakeGateway();
    const bench = await pipelineBench({
      gateway,
      agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n',
      deps: (made) => {
        const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => made.config.daemon.workspaceDir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} } });
        services.push(service);
        mkdirSync(privateWorkspace(made.config.daemon.workspaceDir, "nouva"), { recursive: true });
        return { externalAgents: service, progressIntervalMs: 1, progressQuietMs: 200 };
      },
    });
    benches.push(bench);
    const edits = await turnOn(gateway, bench);
    expect(edits.some((text) => /^\[nouva\] ⏳ ✍️ writing a reply… \d+s$/.test(text))).toBe(true);
    expect(gateway.sent.map((message) => message.text.replace(/ · \d+s$/, ""))).toEqual(["[nouva] ✓ 1 step", REPLY]);
  });

  test("says a model is thinking while its next request is out, and nothing new once it has answered", async () => {
    const gateway = new FakeGateway();
    let requests = 0;
    const bench = await pipelineBench({
      gateway,
      turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "Mira, in March." }],
      // The second request — the model reading its step's result — takes a while to come back.
      fetch: (scripted) => (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests += 1;
        // Fixed: the fake provider held past a few ticks — the time the bubble is to say something about.
        if (requests === 2) await sleep(350);
        return await scripted(url, init);
      }) as typeof fetch,
      deps: { progressIntervalMs: 1, progressQuietMs: 100 },
    });
    benches.push(bench);
    const edits = await turnOn(gateway, bench);
    expect(edits.some((text) => /^\[nouva\] ⏳ 💭 thinking… \d+s$/.test(text))).toBe(true);
    expect(gateway.sent.at(-1)?.text).toBe("Mira, in March.");
  });
});
