/**
 * `/effort` for an agent its own model answers (0.8.17), through the real pipeline: the chat's level is what its
 * requests carry, over `[llm] effort`. A model that refuses it is asked again without (`EffortGuard`), and the answer
 * arrives with one line saying so, once; the conversation keeps the model's own words, and `/effort` says it after.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const NOTE = "`test-model` refused effort `high`, so it is sent none. `/effort default` clears this chat's level.";

/** The agent on `[llm] effort = "low"`; `refuses`: its endpoint answers 400 to a request that carries `high`. */
async function bench(options: { refuses?: boolean; own?: string } = {}) {
  /** What each request carried as its effort, refused ones included. */
  const carried: (string | undefined)[] = [];
  const made = await pipelineBench({
    turns: [{ text: "first answer" }, { text: "second answer" }, { text: "third answer" }],
    agentToml: `[llm]\nprovider = "test"\neffort = "${options.own ?? "low"}"\n`,
    maxAttempts: 1,
    fetch: (scripted) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { reasoning_effort?: string };
        carried.push(body.reasoning_effort);
        if (options.refuses && body.reasoning_effort === "high") {
          return Response.json({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }, { status: 400 });
        }
        return await scripted(url, init);
      }) as typeof fetch,
  });
  cleanup.push(made.dispose);
  made.pipeline.attach();
  let n = 0;
  const say = async (text: string) => {
    made.gateway.receive(envelope({ id: `m${++n}`, timestamp: Date.now() + n, text, chatType: "dm", senderId: "operator", gatewayId: made.gateway.id }));
    await made.pipeline.idle();
    return made.gateway.lastText();
  };
  const stored = () => JSON.stringify(made.sessions.load({ agentId: "nouva", gatewayId: made.gateway.id, chatId: "chat-1" }).messages);
  return { ...made, carried, say, stored };
}

describe("/effort for an agent its own model answers", () => {
  test("its requests carry this chat's level over the agent's, until default puts the agent's back", async () => {
    const h = await bench();
    await h.say("hello");
    expect(await h.say("/effort high")).toBe("Effort for this chat is now `high`, from the next message.");
    await h.say("again");
    expect(await h.say("/effort default")).toBe("Back to the agent's effort, `low`.");
    await h.say("and again");
    expect(h.carried).toEqual(["low", "high", "low"]);
  });

  test("a model that refuses it is asked again without, and the answer says so once, outside the conversation", async () => {
    const h = await bench({ refuses: true });
    await h.say("/effort high");
    expect(await h.say("q1")).toBe(`first answer\n\n${NOTE}`);
    // Asked with it, refused, asked again without; then sent none, and the chat is not told again.
    expect(h.carried).toEqual(["high", undefined]);
    expect(await h.say("q2")).toBe("second answer");
    expect(h.carried).toEqual(["high", undefined, undefined]);
    expect(await h.say("/effort")).toBe("Effort for this chat: `high`, set in this chat. `test-model` refused it, so it is sent none.");
    // The model's own words are what the conversation keeps; the dashboard's record has what the chat was sent.
    expect(h.stored()).toContain("first answer");
    expect(h.stored()).not.toContain("refused effort");
    expect(h.turns.forChat(h.gateway.id, "chat-1").map((turn) => turn.reply)).toContain(`first answer\n\n${NOTE}`);
  });

  test("a level from `[llm] effort` it refuses is the log's: the chat is told nothing", async () => {
    const h = await bench({ refuses: true, own: "high" });
    expect(await h.say("q1")).toBe("first answer");
    expect(h.carried).toEqual(["high", undefined]);
  });
});
