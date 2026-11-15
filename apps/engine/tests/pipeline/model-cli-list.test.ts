/**
 * `/model` in a chat with an agent a coding CLI answers, through the pipeline: the name is held to what that agent's CLI
 * offered, read from the CLIs' service. The command took any word, and a name the CLI does not have was found out by
 * the next message failing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

const OFFERED: Record<string, { value: string; name?: string }[]> = { nouva: [{ value: "default", name: "Default" }, { value: "fable", name: "Fable 5.2" }] };

async function asked(text: string): Promise<{ reply: string; askedFor: string[] }> {
  const gateway = new FakeGateway();
  const askedFor: string[] = [];
  const bench = await pipelineBench({
    gateways: [gateway],
    agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "claude-code"\n',
    deps: {
      externalAgents: {
        runnerFor: () => null,
        answering: () => ({ cli: "Claude Code", running: null, model: null, context: null }),
        models: { of: (agentId: string) => (askedFor.push(agentId), OFFERED[agentId] ?? []) },
      } as never,
    },
  });
  benches.push(bench);
  bench.pipeline.attach();
  gateway.receive(envelope({ id: "m1", text, timestamp: Date.now() }));
  await eventually(() => gateway.sent.length > 0, 5_000, "the command's reply");
  return { reply: gateway.sent[0]!.text, askedFor };
}

describe("/model to an agent a coding CLI answers, in a chat", () => {
  test("a name its CLI does not offer is refused with what it offers, this agent's list", async () => {
    const { reply, askedFor } = await asked("/model fable5");
    expect(reply).toBe("`fable5` is not a model Claude Code offers here. Claude Code offers: `default` (Default), `fable` (Fable 5.2).");
    expect(askedFor).toEqual(["nouva"]);
  });

  test("one it offers is taken, said with what it stands for", async () => {
    expect((await asked("/model fable")).reply).toBe("Model for this chat is now `fable` (Fable 5.2).");
  });
});
