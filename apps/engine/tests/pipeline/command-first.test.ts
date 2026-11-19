/**
 * A command sent to an agent in a chat with no message yet (found in a live run): `/status` was answered and written down
 * as a turn, but no conversation was made, so the dashboard listed the turn under nothing and `DELETE /sessions/<id>`
 * answered "no such session" until the retention sweep. The command now makes the conversation, as `/model` already
 * did: the dashboard reads a command's answer from its turn records after a reload, so dropping the turn instead would
 * lose the answer the record was written for.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sessionIdFor } from "@nouride/shared";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

const KEY = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" };
const ID = sessionIdFor(KEY);

async function daemon(turns: { text: string }[] = []): Promise<Bench> {
  const bench = await pipelineBench({ turns });
  benches.push(bench);
  bench.pipeline.attach();
  return bench;
}

describe("a command in a chat with no conversation yet", () => {
  test("makes the conversation: listed, opened by the sender, and deleted with its turn", async () => {
    const bench = await daemon();
    bench.gateway.receive(envelope({ id: "m1", text: "/status", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length >= 1, 4_000, "the answer");
    await bench.pipeline.idle();

    expect(bench.turns.forSession(ID).map((turn) => turn.prompt)).toEqual(["/status"]);
    const row = bench.sessions.find(ID);
    expect(row).toMatchObject({ id: ID, agentId: "nouva", startedAt: 0, openedBy: "telegram:user-1" });
    expect(bench.sessions.list().map((session) => session.id)).toContain(ID);

    const ended = await bench.pipeline.endConversation({ ...KEY, sessionId: ID }, "delete");
    expect(ended.turns).toBe(1);
    expect(bench.sessions.find(ID)).toBeNull();
    expect(bench.turns.forSession(ID)).toEqual([]);
  });

  test("the first message after it starts the conversation then, and a command in one that exists leaves it as it was", async () => {
    const bench = await daemon([{ text: "hai" }]);
    bench.gateway.receive(envelope({ id: "m1", text: "/status", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length >= 1, 4_000, "the answer");
    await bench.pipeline.idle();
    bench.gateway.receive(envelope({ id: "m2", text: "halo", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length >= 2, 4_000, "the turn's reply");
    await bench.pipeline.idle();
    const started = bench.sessions.find(ID)!;
    expect(started.startedAt).toBeGreaterThan(0);

    bench.gateway.receive(envelope({ id: "m3", text: "/status", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length >= 3, 4_000, "the second answer");
    await bench.pipeline.idle();
    expect(bench.sessions.find(ID)).toEqual(started);
  });
});
