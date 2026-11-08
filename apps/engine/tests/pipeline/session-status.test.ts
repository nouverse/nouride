/**
 * `session_status` reads the conversation as it stands (`ToolPorts.sessionStatus`): which agent, the model it answers
 * on — the chat's `/model` when it has one — and how many times the person has spoken there. Read through the
 * pipeline, as `boot/tools.ts` hands it to the tool.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

describe("session_status", () => {
  test("after two turns in a chat: two of the person's messages, on the agent's own model", async () => {
    const h = (bench = await pipelineBench({ turns: [{ text: "One." }, { text: "Two." }] }));
    h.pipeline.setTools(new Map());
    h.pipeline.attach();
    for (const [id, text] of [["m1", "first"], ["m2", "second"]] as const) {
      h.gateway.receive(envelope({ id, chatType: "dm", chatId: "chat-1", text, timestamp: Date.now() }));
      await h.pipeline.idle();
    }

    const status = h.pipeline.sessionStatus({ agentId: "nouva", chatId: "chat-1", gatewayId: h.gateway.id });
    const agent = h.registry.get("nouva")!;
    expect(status.turns).toBe(2);
    expect(status.model).toBe(agent.config.llm.model);
    expect(status.provider).toBe(agent.config.llm.provider);
    expect(status.chatId).toBe("chat-1");
    expect(status.gateway).toBe(h.gateway.id);
  });

  test("a chat nobody has spoken in: no turns, and the agent named by its id when it is unknown", async () => {
    const h = (bench = await pipelineBench());
    const status = h.pipeline.sessionStatus({ agentId: "nobody", chatId: "chat-9", gatewayId: h.gateway.id });
    expect(status.turns).toBe(0);
    expect(status.agent).toBe("nobody");
    expect(status.model).toBe("unknown");
  });
});
