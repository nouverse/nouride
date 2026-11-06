/**
 * How an agent is told to write is the line its connection gives (`Gateway.formatting`) — through a real turn, as the
 * provider receives the prompt. The engine kept a line per platform, by name, until 0.7.11.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

async function promptFor(formatting: string | undefined): Promise<string> {
  const gateway = new FakeGateway();
  if (formatting) gateway.formatting = formatting;
  const bench = await pipelineBench({ turns: [{ text: "ok" }], gateway });
  benches.push(bench);
  bench.pipeline.attach();
  // Sent now: the bench has the inbox a daemon has, and a message from long ago is a backlog it notices, not answers.
  gateway.receive(envelope({ text: "hi", timestamp: Date.now() }));
  await bench.pipeline.idle();
  return JSON.stringify(bench.requests[0]);
}

describe("how the agent is told to write", () => {
  test("is the line its connection gives", async () => {
    expect(await promptFor("Formatting: the adapter's own line.")).toContain("Formatting: the adapter's own line.");
  });

  test("and the browser's when the connection says nothing", async () => {
    expect(await promptFor(undefined)).toContain("Formatting: plain markdown, rendered in a browser");
  });
});
