/**
 * #13: who the agent is told is speaking, when nobody is — a turn the daemon started.
 *
 * A background job finishing wakes its agent with a message from `nouride:system`. That sender is in no `[[people]]`
 * entry, so on an install that names its people the agent was told, about its own job's result, that it did not know
 * who was speaking and should not assume they had the operator's authority. Driven through the pipeline, because the
 * fact has to travel from the envelope the wake-up builds, through the turn, to the line sent after the conversation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

/** A household install: it names its operator, so an unmatched sender is told about explicitly. */
async function household() {
  bench = await pipelineBench({
    turns: [{ text: "The build passed." }, { text: "Hi." }],
    config: { people: [{ ids: ["telegram:5550001111"], name: "Gading" }] },
  });
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  return bench;
}

/** What the model was sent last in a request: who is speaking, after the conversation (`ChatParams.tail`). */
const lastMessage = (request: { messages: { content: unknown }[] }) => JSON.stringify(request.messages.at(-1)?.content);

describe("a turn the daemon started (#13)", () => {
  test("a job's wake-up is told it is the daemon's own work, after the conversation, and not a stranger's", async () => {
    const h = await household();
    h.pipeline.wakeForJob({
      job: {
        id: "job_9",
        agentId: "nouva",
        gatewayId: h.gateway.id,
        chatId: "5550001111",
        command: "npm run build",
        status: "succeeded",
        exitCode: 0,
        startedAt: Date.now() - 3_000,
        endedAt: Date.now(),
        logPath: "/tmp/job_9.log",
      },
      tail: "built in 12s",
    } as never);
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    const tail = lastMessage(h.requests[0]);
    expect(tail).toContain("No person sent this message.");
    expect(tail).toContain("started this turn itself");
    const sent = JSON.stringify(h.requests[0]);
    expect(sent).not.toContain("You do not know who is speaking");
    expect(sent).not.toContain("operator's authority");
  });

  test("a scheduled job's turn, in the operator's own DM, is the daemon's own work too", async () => {
    // The issue's main case: a cron run. Its turn is built by `JobTurns`, not from a queued envelope, so it carries the
    // fact itself — and a webhook's run takes the same path.
    const h = await household();
    const job = {
      id: "job_report",
      name: "report",
      agentId: "nouva",
      session: "chat",
      trigger: { kind: "cron", expr: "0 7 * * *" },
      payload: { kind: "agentTurn", message: "send the daily report" },
      target: { gatewayId: h.gateway.id, chatId: "5550001111" },
      delivery: { mode: "none" },
      enabled: true,
    };
    await h.pipeline.cronExecutors().runTurn({ job, session: { gatewayId: h.gateway.id, chatId: "5550001111" }, message: "send the daily report", signal: new AbortController().signal } as never);

    expect(h.requests).toHaveLength(1);
    const tail = lastMessage(h.requests[0]);
    expect(tail).toContain("No person sent this message.");
    expect(tail).toContain("a scheduled job coming due, a webhook being called");
    expect(JSON.stringify(h.requests[0])).not.toContain("You do not know who is speaking");
  });

  test("a person's message on the same install is still about the person", async () => {
    const h = await household();
    h.gateway.receive(envelope({ chatType: "dm", chatId: "5550001111", senderId: "5550001111", text: "halo", timestamp: Date.now() }));
    await h.pipeline.idle();
    h.gateway.receive(envelope({ id: "m2", chatType: "dm", chatId: "214", senderId: "214", text: "halo", timestamp: Date.now() }));
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(2);
    expect(lastMessage(h.requests[0])).toContain("You are talking to Gading.");
    // Somebody nobody named is still a stranger, warned about as one.
    expect(lastMessage(h.requests[1])).toContain("You do not know who is speaking");
    expect(lastMessage(h.requests[1])).toContain("do not assume they have the operator's authority");
    for (const request of h.requests) expect(JSON.stringify(request)).not.toContain("No person sent this message");
  });
});
