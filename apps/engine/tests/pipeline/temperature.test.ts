/**
 * A turn on a model that takes no temperature, through the real pipeline: every request carries
 * `[llm.defaults] temperature`, Claude Sonnet 5.5 and Haiku 5.5 answered each with 400, and the chat got "Something is
 * wrong with how I am building requests" for every message. The request is asked again without it (`TemperatureGuard`),
 * the chat gets its answer and nothing else, and the model is sent none after.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

/** `refuses`: the endpoint answers 400 to a request that carries a temperature, whatever its value. */
async function bench(options: { refuses: boolean; agentToml?: string }) {
  /** What each request carried as its temperature, refused ones included. */
  const carried: (number | undefined)[] = [];
  const made = await pipelineBench({
    turns: [{ text: "first answer" }, { text: "second answer" }],
    ...(options.agentToml ? { agentToml: options.agentToml } : {}),
    maxAttempts: 1,
    fetch: (scripted) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { temperature?: number };
        carried.push(body.temperature);
        if (options.refuses && "temperature" in body) return Response.json({ error: { message: "invalid request" } }, { status: 400 });
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
  return { ...made, carried, say };
}

describe("a turn on a model that takes no temperature", () => {
  test("is answered: asked again without it, the chat told nothing, and the model sent none after", async () => {
    const h = await bench({ refuses: true });
    const set = h.config.llm.defaults.temperature;
    expect(await h.say("q1")).toBe("first answer");
    expect(h.carried).toEqual([set, undefined]);
    expect(await h.say("q2")).toBe("second answer");
    expect(h.carried).toEqual([set, undefined, undefined]);
  });

  test("the agent's own temperature is what a model that takes one is sent", async () => {
    const h = await bench({ refuses: false, agentToml: '[llm]\nprovider = "test"\ntemperature = 0.2\n' });
    expect(await h.say("q1")).toBe("first answer");
    expect(h.carried).toEqual([0.2]);
  });
});
