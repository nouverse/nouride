/**
 * The Telegram adapter started with Telegram's half answered here — `init` says who the bot is, `start` is a poll that
 * never ends — so an update goes in through `handleUpdate`, the way a poll hands one over, and every call the adapter
 * makes back to Telegram is recorded and answered instead of sent (`calls`). For the tests of edits and buttons (G11).
 */

import { spyOn } from "bun:test";
import { Bot } from "grammy";
import type { MessageEnvelope } from "@nouride/shared";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";

export const ME = { id: 1, is_bot: true, first_name: "Nouva", username: "nouva_bot", can_read_all_group_messages: true } as Bot["botInfo"];

/** One call the adapter made to Telegram: the method, and what it sent. */
export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Telegram's answer to a call: what it returns, or its refusal — which grammY throws as a `GrammyError`. */
export type ApiAnswer = { result: unknown } | { refused: { code: number; description: string } };

let sentId = 100;
/** What Telegram answers by default: a sent message for a send, `true` for anything else. */
const telegramDefault = (call: ApiCall): ApiAnswer =>
  call.method.startsWith("send") ? { result: { message_id: ++sentId, date: 0, chat: { id: Number(call.payload.chat_id), type: "private" } } } : { result: true };

export async function startedTelegram(answer: (call: ApiCall) => ApiAnswer = telegramDefault) {
  const init = spyOn(Bot.prototype, "init").mockImplementation(async function (this: Bot) {
    this.botInfo = ME;
  });
  const start = spyOn(Bot.prototype, "start").mockImplementation(() => new Promise<void>(() => {}));
  const stop = spyOn(Bot.prototype, "stop").mockImplementation(async () => {});
  const gateway = new TelegramGateway({
    id: "telegram:main",
    platform: "telegram",
    token: "1:a",
    mode: "polling",
    resilience: { healthCheckIntervalMs: 3_600_000, reconnectBackoffMs: 3_600_000, reconnectBackoffMaxMs: 3_600_000 },
  });
  const envelopes: MessageEnvelope[] = [];
  gateway.onMessage((envelope) => envelopes.push(envelope));
  await gateway.start();
  const bot = (gateway as unknown as { bot: Bot }).bot;
  const calls: ApiCall[] = [];
  // Outermost, so nothing reaches the network: every call is recorded and answered here.
  bot.api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    const answered = answer(call);
    return ("refused" in answered ? { ok: false, error_code: answered.refused.code, description: answered.refused.description } : { ok: true, result: answered.result }) as never;
  });
  let updateId = 0;
  return {
    gateway,
    bot,
    envelopes,
    calls,
    /** The calls of one method, in order. */
    called: (method: string) => calls.filter((call) => call.method === method),
    /** One update, as a poll delivers it. */
    update: (update: Record<string, unknown>) => bot.handleUpdate({ update_id: ++updateId, ...update } as never),
    restore: async () => {
      await gateway.stop();
      init.mockRestore();
      start.mockRestore();
      stop.mockRestore();
    },
  };
}
