/**
 * `/mission <goal>` through the pipeline: it starts no mission. The agent addressed gets a turn whose words ask it to
 * draft one from the goal (`draftAsked`), and the message the person sent is what the chat shows they asked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { draftAsked } from "@/modules/hooks/builtins/mission.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

describe("/mission <goal> in a chat", () => {
  test("is a turn that asks the agent for a draft, and nothing is started", async () => {
    const started: unknown[] = [];
    const missionCommands = { start: (request: unknown) => (started.push(request), { refused: "not here" }), forChat: () => [], load: () => ({ running: 0, atOnce: 2 }), running: () => [] };
    const bench = await pipelineBench({ turns: [{ text: "Which folder are the logs in?" }], deps: { missionCommands } as never });
    benches.push(bench);
    bench.pipeline.attach();
    bench.gateway.receive(envelope({ id: "m1", text: "/goal tidy the old logs", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length >= 1, 4_000, "the agent's answer");
    await bench.pipeline.idle();

    expect(started).toEqual([]);
    expect(bench.requests).toHaveLength(1);
    const user = bench.requests[0]!.messages.filter((message: { role: string }) => message.role === "user").at(-1) as { content: unknown };
    expect(JSON.stringify(user.content)).toContain(JSON.stringify(draftAsked("tidy the old logs")).slice(1, -1));
    expect(bench.gateway.sent.map((message) => message.text)).toContain("Which folder are the logs in?");
  });
});
