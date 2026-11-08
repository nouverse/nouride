/**
 * What a coding CLI writes before a step, through the pipeline with a real CLI process (0.8.7).
 *
 * Twice a person saw only an agent's closing line: its explanation, written before a tool call, was gone. Each
 * message a CLI writes before a step goes to the chat on its own (0.8.5), and the turn's answer was what was left — so
 * the turn's record kept the closing line alone. The dashboard reads a turn's reply from that record, and on its own
 * connection that is the only way a reply reaches anybody: the explanation reached nobody there.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import { privateWorkspace } from "@nouride/persona";
import type { Gateway, OutboundMessage } from "@nouride/shared";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const FAKE = join(import.meta.dir, "../external-agents/fixtures/fake-cli.ts");
const EXPLANATION = "The build failed on step two: the cache held an old lockfile, so I clear it and run it again.";
const CLOSING = "Green now.";

const benches: Bench[] = [];
const services: ExternalAgents[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const bench of benches.splice(0)) bench.dispose();
});

/** Nouva answered by the fake CLI in `explain` mode: its explanation, a command, then its closing line. */
async function cliBench(gateways: Gateway[]): Promise<Bench> {
  const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", env: { FAKE_MODE: "explain" }, modes: { folder: "yolo", risky: "default", all: "default" }, instructionFile: "AGENTS.md" };
  const bench = await pipelineBench({
    gateways,
    agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n',
    deps: (made) => {
      const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => made.config.daemon.workspaceDir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} } });
      services.push(service);
      mkdirSync(privateWorkspace(made.config.daemon.workspaceDir, "nouva"), { recursive: true });
      return { externalAgents: service, progressIntervalMs: 1 };
    },
  });
  benches.push(bench);
  bench.pipeline.attach();
  return bench;
}

const ended = async (bench: Bench, gatewayId: string, chatId: string) => {
  await eventually(() => bench.turns.forChat(gatewayId, chatId).some((turn) => turn.status !== "running"), 10_000, "the CLI's turn to end");
  await bench.pipeline.idle();
  return bench.turns.forChat(gatewayId, chatId);
};

describe("a coding CLI's words before a step", () => {
  test("reach a person on the dashboard, where a reply is read from the turn's record — not the closing line alone", async () => {
    const local = new LocalGateway();
    const bench = await cliBench([local]);
    const { chatId } = local.dispatch({ text: "fix the build", chatId: "dash-1" });
    const turns = await ended(bench, "web:dashboard", chatId);
    expect(turns.map((turn) => turn.reply)).toEqual([`${EXPLANATION}\n\n${CLOSING}`]);
  });

  test("go out on a platform as a message of their own, before the step, and the record keeps them with the answer", async () => {
    const gateway = new FakeGateway();
    const bench = await cliBench([gateway]);
    gateway.receive(envelope({ id: "m1", text: "fix the build", timestamp: Date.now() }));
    const turns = await ended(bench, "telegram:main", "chat-1");
    // Each said once, in order; whatever the bubble showed is between them.
    expect(gateway.sent.map((message) => message.text).filter((text) => !text.startsWith("[nouva]"))).toEqual([EXPLANATION, CLOSING]);
    expect(turns.map((turn) => turn.reply)).toEqual([`${EXPLANATION}\n\n${CLOSING}`]);
  });

  test("a reply that went out in part is not owed again after a restart: its head would be said twice", async () => {
    // The closing line does not land; the record holds the explanation too, which already did.
    class ClosingFails extends FakeGateway {
      override async send(message: OutboundMessage): Promise<string[]> {
        if (message.text === CLOSING) throw new Error("Bad Gateway");
        return super.send(message);
      }
    }
    const gateway = new ClosingFails();
    const bench = await cliBench([gateway]);
    gateway.receive(envelope({ id: "m1", text: "fix the build", timestamp: Date.now() }));
    await ended(bench, "telegram:main", "chat-1");
    expect(gateway.sent.map((message) => message.text)).toContain(EXPLANATION);
    expect(bench.durable.delivery.undelivered(0)).toEqual([]);
  });
});
