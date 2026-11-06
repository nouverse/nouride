/**
 * A reply in a cron session goes where the job delivers.
 *
 * A scheduled run with `session: "isolated"` or `"fresh"` works in `cron:<jobId>`. A background job it
 * starts wakes its agent there when it finishes, and that turn's reply was sent to `cron:<jobId>` — an
 * address on no platform — so the job's result reached nobody.
 */

import { describe, expect, test } from "bun:test";
import type { Gateway, Job, MessageEnvelope, OutboundMessage } from "@nouride/shared";
import { SYSTEM_SENDER, type PipelineDeps } from "@/modules/pipeline/deps.ts";
import { Voice } from "@/modules/pipeline/voice.ts";

function setup(delivery: Job["delivery"] | null, publicUrl = "") {
  const sent: OutboundMessage[] = [];
  const gateway = {
    id: "telegram:nouva",
    platform: "telegram",
    status: "connected",
    send: async (message: OutboundMessage) => {
      sent.push(message);
      return ["1"];
    },
  } as unknown as Gateway;
  const job = delivery
    ? ({ id: "j1", agentId: "nouva", target: { gatewayId: "telegram:nouva", chatId: "42" }, delivery } as unknown as Job)
    : null;
  const voice = new Voice({
    config: { gateways: [], dashboard: { publicUrl } },
    gateways: new Map([["telegram:nouva", gateway]]),
    cronJobs: { get: () => job },
  } as unknown as PipelineDeps);
  return { voice, sent };
}

const wake = {
  id: "msg_1",
  timestamp: 0,
  gateway: "telegram",
  gatewayId: "telegram:nouva",
  chatId: "cron:j1",
  chatType: "dm",
  senderId: SYSTEM_SENDER,
  senderName: "Nouride",
  text: "",
} as unknown as MessageEnvelope;

describe("a reply in a cron session", () => {
  test("goes to the job's target when it announces", async () => {
    const { voice, sent } = setup({ mode: "announce" });
    expect(await voice.reply(wake, "the build passed")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ gatewayId: "telegram:nouva", chatId: "42", text: "the build passed" });
  });

  test("goes to the delivery override when the job names one", async () => {
    const { voice, sent } = setup({ mode: "announce", gatewayId: "telegram:nouva", chatId: "-100777" });
    await voice.reply(wake, "done");
    expect(sent[0]?.chatId).toBe("-100777");
  });

  test("goes nowhere for a job that delivers to no chat — and that is not a failure", async () => {
    const { voice, sent } = setup({ mode: "none" });
    expect(await voice.reply(wake, "done")).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("is not delivered when the job is gone, and says so", async () => {
    const { voice, sent } = setup(null);
    expect(await voice.reply(wake, "done")).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
