/**
 * A message to an agent's own bot that names somebody's handle is answered (`router/index.ts`, "somebody was tagged
 * and it was not us"), through the whole pipeline.
 *
 * On a live install a person wrote to an agent on Telegram, one-to-one, with a GitHub handle in the text. Telegram
 * marks any `@word` as a mention, the router read "somebody else was tagged", and the message was settled the second
 * it came: no turn, no answer, no line in the log. Sent again, the same. In a room that silence is right, since the
 * message is for another bot there. In a one-to-one chat nobody else is there.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

const ASKED = "Fixed in 0.8.34. @qisthidev your instance is on it now. tolong kasih balasan ke qisthi lagi";

async function said(chatType: "dm" | "group") {
  const bot = new FakeGateway("telegram:nouva", "telegram");
  bench = await pipelineBench({ turns: [{ text: "Posted the reply." }], gateway: bot });
  bench.pipeline.attach();
  bot.receive(envelope({ id: "m1", gatewayId: bot.id, chatId: "814", senderId: "814", chatType, timestamp: Date.now(), text: ASKED, mentions: ["qisthidev"] }));
  await bench.pipeline.idle();
  return { bot, requests: bench.requests };
}

describe("a message that names somebody's handle", () => {
  test("to an agent's own bot, one-to-one: it gets its turn, the handle as written in what the model reads, and its answer", async () => {
    const { bot, requests } = await said("dm");
    expect(bot.lastText()).toBe("Posted the reply.");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.messages)).toContain("@qisthidev your instance is on it now");
  });

  test("in a group it is somebody else's message, as before: no turn and no word from this bot", async () => {
    const { bot, requests } = await said("group");
    expect(requests).toHaveLength(0);
    expect(bot.sent).toEqual([]);
  });
});
