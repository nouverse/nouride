/**
 * An automation a person turned on is not asked again for what its runs send.
 *
 * The live case, end to end through a real pipeline. A person asked, from the dashboard, for a news digest on their
 * WhatsApp every morning; the agent proposed a job whose run sends it there with `send_message`; the person turned it
 * on. Every run then read the web, wrote the digest, and was refused the send: a run was held, at every approval
 * level, for a message to any chat but the one its job was made in, and its page offered "Always allow for this job"
 * for a yes the person had already given by turning it on.
 *
 * So, with an install's defaults: the run's message to another chat goes, after outside content too; nothing is held
 * on the run; and no model is asked to look at it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { createSendMessageTool } from "@/modules/tools/builtins/send-message.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

async function digestRun(o: { config?: Record<string, unknown> } = {}) {
  const telegram = new FakeGateway("telegram:main", "telegram");
  const whatsapp = new FakeGateway("whatsapp:main", "whatsapp");
  bench = await pipelineBench({
    turns: [
      { text: "Halo semua!" },
      { toolCalls: [{ id: "s1", name: "send_message", args: { to: "whatsapp:main:1203@g.us", text: "Berita pagi: harga jeruk turun." } }] },
      { text: "Sent to the group." },
    ],
    agentToml: '[llm]\nprovider = "test"\nhigh_model = "big-1"\n\n[tools]\nenabled = ["send_message"]\n',
    config: { agents: { groups_require_mention: false }, ...o.config },
    gateways: [telegram, whatsapp],
    deps: ({ db }) => ({ roomMessages: new RoomMessageStore(db) }),
  });
  bench.pipeline.setTools(new Map([["send_message", createSendMessageTool(bench.pipeline.messageSender())]]));
  bench.pipeline.attach();
  // The agent has talked in the group before: it is a chat it can reach.
  whatsapp.receive(envelope({ id: "wa-1", timestamp: Date.now(), gateway: "whatsapp", gatewayId: "whatsapp:main", chatId: "1203@g.us", chatType: "group", senderId: "62811@s.whatsapp.net", senderName: "Mira", text: "halo nouva", mentions: ["nouva"] }));
  await bench.pipeline.idle();

  // Made in the Telegram one-to-one, so that is the chat it reports to; what it sends goes to the group.
  const store = new CronStore({ db: bench.db, config: bench.config.cron, timezone: "UTC" });
  const job = store.create({
    agentId: "nouva",
    name: "Morning digest",
    trigger: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
    payload: { kind: "agentTurn", message: "Read today's news and send a digest to the family's WhatsApp group with send_message." },
    target: { gatewayId: telegram.id, chatId: "814" },
    session: "isolated",
    createdBy: "agent:nouva",
  });
  const result = await bench.pipeline.cronExecutors().runTurn({
    job,
    session: { gatewayId: telegram.id, chatId: `cron:${job.id}` },
    message: "Read today's news and send a digest to the family's WhatsApp group with send_message.",
    signal: new AbortController().signal,
    // It read the web before it sent: the case the second look was made for.
    outsideContent: ["a web page"],
  });
  return { result, whatsapp, bench };
}

describe("a run of an automation a person turned on", () => {
  test("sends to a chat that is not its job's, after outside content too: nothing held, no model asked to look", async () => {
    const { result, whatsapp, bench } = await digestRun();
    expect(whatsapp.sent.slice(1).map((sent) => ({ chatId: sent.chatId, text: sent.text }))).toEqual([{ chatId: "1203@g.us", text: "Berita pagi: harga jeruk turun." }]);
    expect(result.held).toBeUndefined();
    expect(result.text).toBe("Sent to the group.");
    // The group's hello, the run's call and its reply: no request between them went to the look's model.
    expect(bench.requests.map((request) => request.model)).not.toContain("big-1");
    expect(JSON.stringify(bench.requests.at(-1))).toContain("Delivered to the whatsapp group");
    expect(JSON.stringify(bench.requests.at(-1))).not.toContain("needs approval");
  });

  test("is refused the send where the install says a run answers nothing by itself: that switch is the operator's", async () => {
    const { result, whatsapp, bench } = await digestRun({ config: { cron: { unattended_approval: "deny" } } });
    expect(whatsapp.sent.slice(1)).toEqual([]);
    expect(JSON.stringify(bench.requests.at(-1))).toContain("needs approval and this is a scheduled run, so there is nobody to ask");
    // Refused as everything that asks is there, and not as something to allow for the job.
    expect(result.held).toBeUndefined();
  });
});
