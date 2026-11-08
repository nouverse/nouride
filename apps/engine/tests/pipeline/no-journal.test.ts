/**
 * A turn that dies keeps the question it was answering, where the daemon has no journal (`PipelineDeps.journal` is
 * optional). With one, the journal holds the question and the failure path folds it in; without, the composed message
 * on the turn's state is all there is (`TurnState.asked`, `TurnContext.closeUnfinished`). The bench wires a journal,
 * so nothing else reaches this path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

describe("without a journal", () => {
  test("a turn its provider fails keeps the person's question in the conversation", async () => {
    const h = (bench = await pipelineBench({
      turns: [],
      maxAttempts: 1,
      fetch: () => (async () => Response.json({ error: { message: "the model is gone" } }, { status: 404 })) as unknown as typeof fetch,
      deps: { journal: undefined },
    }));
    h.pipeline.setTools(new Map());
    h.pipeline.attach();

    h.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "rewrite the docs, they are bad", timestamp: Date.now() }));
    await h.pipeline.idle();

    const stored = JSON.stringify(h.sessions.load({ agentId: "nouva", gatewayId: h.gateway.id, chatId: "chat-1" }).messages);
    expect(stored).toContain("rewrite the docs, they are bad");
    expect(h.turns.forChat(h.gateway.id, "chat-1", 1)[0]?.status).toBe("failed");
  });
});
