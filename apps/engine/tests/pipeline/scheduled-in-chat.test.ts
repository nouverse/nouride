/**
 * A scheduled job's turn put into its own chat (`session: "chat"`) is work nobody watches (0.8.0): it sends only to that
 * chat, names its job so a person can answer *always for this job*, and carries what they already allowed it. A chat
 * message is never taken for one, whatever it says.
 */

import { expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { scheduledInChat } from "@/modules/pipeline/job-turns.ts";

const envelope = (raw: unknown): MessageEnvelope =>
  ({ id: "m1", timestamp: 0, gateway: "telegram", gatewayId: "telegram:nouva", chatId: "-100team", chatType: "group", senderId: "nouride:system", senderName: "", text: "Sum up the mail.", raw }) as MessageEnvelope;

test("a dispatched job's turn: its chat, its job, and what is allowed it", () => {
  expect(scheduledInChat(envelope({ via: "cron dispatch", job: "cron_1", cronName: "mail", allowed: ["chat:telegram:nouva:555", 7] }))).toEqual({
    goal: "Sum up the mail.",
    sendsTo: { gatewayId: "telegram:nouva", chatId: "-100team" },
    jobId: "cron_1",
    allowed: ["chat:telegram:nouva:555"],
  });
});

test("anything else is not a job's run", () => {
  expect(scheduledInChat(envelope({ update_id: 1, message: { text: "hi" } }))).toBeUndefined();
  expect(scheduledInChat(envelope(null))).toBeUndefined();
});
