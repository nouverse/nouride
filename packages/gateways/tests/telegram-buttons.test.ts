/**
 * Buttons on Telegram: an inline keyboard under the last part of a message, a press on one — a `callback_query`,
 * asked for by the poll — handed to the engine and always answered, and a message settled with its keyboard taken away.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ButtonPress, MessageButton, PressAnswer } from "@nouride/shared";
import { pollingOptions } from "../src/channels/telegram/gateway.ts";
import { startedTelegram, type ApiAnswer, type ApiCall } from "./telegram-harness.ts";
import { eventually } from "./wait.ts";

const restores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) await restore();
});

async function started(answer?: (call: ApiCall) => ApiAnswer) {
  const t = await startedTelegram(answer);
  restores.push(t.restore);
  return t;
}

/** Telegram has been told about `count` presses — the adapter answers each after the engine has, not as it arrives. */
const answered = (t: Awaited<ReturnType<typeof started>>, count: number, edits = 0) =>
  eventually(() => t.called("answerCallbackQuery").length === count && t.called("editMessageText").length === edits, 2_000, "the press answered");

const BUTTONS: MessageButton[] = [
  { label: "Approve", data: "approval:once:apr_1", style: "positive" },
  { label: "Deny", data: "approval:deny:apr_1", style: "negative" },
];
const KEYBOARD = { inline_keyboard: [[{ text: "Approve", callback_data: "approval:once:apr_1" }, { text: "Deny", callback_data: "approval:deny:apr_1" }]] };

/** A press on message 7 in chat 42, as a poll delivers it. */
const pressing = (over: Record<string, unknown> = {}) => ({
  callback_query: {
    id: "cq1",
    chat_instance: "ci",
    from: { id: 9, is_bot: false, first_name: "Ann" },
    data: "approval:once:apr_1",
    message: { message_id: 7, date: 1_700_000_000, chat: { id: 42, type: "private" }, text: "approve?" },
    ...over,
  },
});

describe("a message with buttons", () => {
  test("carries them as an inline keyboard — on its last part only; the adapter says it can (`Gateway.buttons`)", async () => {
    const t = await started();
    expect(t.gateway.buttons).toBe(true);
    await t.gateway.send({ gatewayId: "telegram:main", chatId: "42", text: "approve?", buttons: BUTTONS });
    expect(t.called("sendMessage").map((call) => call.payload.reply_markup)).toEqual([KEYBOARD]);

    // Another chat, so Telegram's pace of one message a second in a chat waits only between this one's own parts.
    await t.gateway.send({ gatewayId: "telegram:main", chatId: "43", text: `${"a".repeat(4_000)}\n\n${"b".repeat(1_000)}`, buttons: BUTTONS });
    const parts = t.called("sendMessage").slice(1);
    expect(parts).toHaveLength(2);
    expect(parts.map((call) => call.payload.reply_markup)).toEqual([undefined, KEYBOARD]);
  });

  test("keeps them when its formatting is refused and it is sent again plain", async () => {
    let refused = false;
    const t = await started((call) =>
      call.method === "sendMessage" && call.payload.parse_mode && !refused
        ? ((refused = true), { refused: { code: 400, description: "Bad Request: can't parse entities" } })
        : { result: { message_id: 8, date: 0, chat: { id: 42, type: "private" } } },
    );
    await t.gateway.send({ gatewayId: "telegram:main", chatId: "42", text: "approve?", buttons: BUTTONS });
    expect(t.called("sendMessage").map((call) => [Boolean(call.payload.parse_mode), call.payload.reply_markup])).toEqual([
      [true, KEYBOARD],
      [false, KEYBOARD],
    ]);
  });
});

describe("a press", () => {
  test("goes to the engine as the press it is, is answered with the engine's notice, and settles the message it says to", async () => {
    const t = await started();
    const presses: ButtonPress[] = [];
    t.gateway.onPress(async (press) => (presses.push(press), { notice: "Approved.", settled: "✅ Approved by **Ann**" }));
    await t.update(pressing());
    await answered(t, 1, 1);

    expect(presses).toEqual([{ gatewayId: "telegram:main", chatId: "42", chatType: "dm", messageId: "7", data: "approval:once:apr_1", senderId: "9", senderName: "Ann" }]);
    expect(t.called("answerCallbackQuery").map((call) => call.payload)).toEqual([{ callback_query_id: "cq1", text: "Approved." }]);
    expect(t.called("editMessageText").map((call) => call.payload)).toEqual([
      { chat_id: "42", message_id: 7, text: "✅ Approved by <b>Ann</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } },
    ]);
  });

  test("in a topic, its chat is the topic; in a group, a group", async () => {
    const t = await started();
    const presses: ButtonPress[] = [];
    t.gateway.onPress(async (press) => (presses.push(press), { settled: "done" }));
    await t.update(pressing({ message: { message_id: 7, date: 1, chat: { id: -1005, type: "supergroup" }, message_thread_id: 3, is_topic_message: true, text: "x" } }));
    await answered(t, 1, 1);
    expect(presses[0]).toMatchObject({ chatId: "-1005:3", chatType: "group" });
    // Settled in its chat — the topic is not part of the address Telegram edits by.
    expect(t.called("editMessageText")[0]?.payload).toMatchObject({ chat_id: "-1005", message_id: 7 });
  });

  test("is always answered — with nothing to say, with nobody listening, and when the engine throws — or the button spins", async () => {
    const t = await started();
    await t.update(pressing());
    await answered(t, 1);
    t.gateway.onPress(async (): Promise<PressAnswer> => ({}));
    await t.update(pressing({ id: "cq2" }));
    await answered(t, 2);
    t.gateway.onPress(async () => {
      throw new Error("engine bug");
    });
    await t.update(pressing({ id: "cq3" }));
    await answered(t, 3);

    expect(t.called("answerCallbackQuery").map((call) => call.payload)).toEqual([
      { callback_query_id: "cq1" },
      { callback_query_id: "cq2" },
      { callback_query_id: "cq3", text: "That did not go through. Answer with the command in the message instead." },
    ]);
    expect(t.called("editMessageText")).toEqual([]);
  });

  test("on a message too old for Telegram to say where it is, is answered and nothing else", async () => {
    const t = await started();
    const presses: ButtonPress[] = [];
    t.gateway.onPress(async (press) => (presses.push(press), { notice: "x" }));
    await t.update(pressing({ message: undefined }));
    await answered(t, 1);
    expect(presses).toEqual([]);
    expect(t.called("answerCallbackQuery").map((call) => call.payload)).toEqual([{ callback_query_id: "cq1" }]);
  });

  test("the poll asks Telegram for presses", () => {
    expect(pollingOptions().allowed_updates).toEqual(["message", "edited_message", "callback_query"]);
  });
});

describe("settling a message", () => {
  test("rewrites it plain, its keyboard still taken away, when Telegram refuses the formatting", async () => {
    const t = await started((call) =>
      call.method === "editMessageText" && call.payload.parse_mode ? { refused: { code: 400, description: "Bad Request: can't parse entities" } } : { result: true },
    );
    expect(await t.gateway.settleButtons("42", "7", "✅ Approved by **Ann**")).toBe(true);
    expect(t.called("editMessageText").map((call) => [call.payload.text, call.payload.reply_markup])).toEqual([
      ["✅ Approved by <b>Ann</b>", { inline_keyboard: [] }],
      ["✅ Approved by Ann", { inline_keyboard: [] }],
    ]);
  });

  test("says so when Telegram will not have it at all", async () => {
    const t = await started((call) => (call.method === "editMessageText" ? { refused: { code: 400, description: "Bad Request: message to edit not found" } } : { result: true }));
    expect(await t.gateway.settleButtons("42", "7", "done")).toBe(false);
  });

  test("said again with its keyboard, for a question still open — an edit without one takes it away (0.8.7)", async () => {
    const t = await started();
    expect(await t.gateway.settleButtons("42", "7", "⏸ **nix** is waiting", BUTTONS)).toBe(true);
    expect(t.called("editMessageText").map((call) => [call.payload.text, call.payload.reply_markup])).toEqual([["⏸ <b>nix</b> is waiting", KEYBOARD]]);
  });
});
