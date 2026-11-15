/**
 * A message of files alone, sent from the dashboard to one agent: no words came with it, so none are kept as what the
 * person wrote. The dashboard's connection names the agent a message is for by putting its name before the words
 * (`gateways/local.ts`); with no words that name was all there was, and "nix:" was recorded as the person's message,
 * drawn in their own bubble and handed to the model as what they said.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

const PICTURE = { type: "image" as const, path: "/tmp/does-not-matter.png", mimeType: "image/png", filename: "quiz.png" };

describe("a message of files alone from the dashboard", () => {
  test("the envelope holds no words: the agent it is for is its mention, not text", () => {
    const local = new LocalGateway();
    const seen: MessageEnvelope[] = [];
    local.onMessage((envelope) => void seen.push(envelope));
    local.dispatch({ agent: "nouva", chatId: "dash-1", attachments: [PICTURE] });
    local.dispatch({ agent: "nouva", chatId: "dash-1", text: "  ", attachments: [PICTURE] });
    local.dispatch({ agent: "nouva", chatId: "dash-1", text: "look at this", attachments: [PICTURE] });
    local.dispatch({ agent: "nouva", chatId: "dash-1", text: "/status" });
    expect(seen.map((envelope) => envelope.text)).toEqual(["", "  ", "nouva: look at this", "/status"]);
    // Routed to it all the same, words or none.
    expect(seen.map((envelope) => envelope.mentions)).toEqual([["nouva"], ["nouva"], ["nouva"], ["nouva"]]);
    expect(seen[0]!.attachments).toHaveLength(1);
  });

  test("its turn is recorded as files alone, and the model is never handed the agent's name as what the person said", async () => {
    const local = new LocalGateway();
    const bench = await pipelineBench({ gateways: [local], turns: [{ text: "A quiz about regression." }] });
    benches.push(bench);
    bench.pipeline.attach();
    const { chatId } = local.dispatch({ agent: "nouva", chatId: "dash-1", attachments: [PICTURE] });
    await eventually(() => bench.turns.forChat("web:dashboard", chatId).some((turn) => turn.status !== "running"), 10_000, "the turn to end");
    await bench.pipeline.idle();
    const [turn] = bench.turns.forChat("web:dashboard", chatId);
    expect(turn!.prompt).toBe("(attachment)");
    expect(turn!.reply).toBe("A quiz about regression.");
    const sent = JSON.stringify(bench.requests.at(-1)?.messages ?? []);
    expect(sent).not.toContain("nouva:");
    expect(sent).toContain("quiz.png");
  });
});
