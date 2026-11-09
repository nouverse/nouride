/**
 * Buttons on Telegram: an inline keyboard under a message, and a press on one — a `callback_query` — as the
 * engine reads it. What a press means is the engine's; carrying out its answer is the adapter's (`gateway.ts`).
 */

import type { CallbackQuery, InlineKeyboardMarkup } from "grammy/types";
import type { ButtonPress, MessageButton } from "@nouride/shared";
import { chatTypeOf, displayName, foldChatId } from "./envelope.ts";

/** The buttons, one row of them, as Telegram draws them under a message. */
export function inlineKeyboard(buttons: readonly MessageButton[]): InlineKeyboardMarkup {
  return { inline_keyboard: [buttons.map((button) => ({ text: button.label, callback_data: button.data }))] };
}

/** No buttons: what a settled message is edited with, so its keyboard goes rather than being left as it was. */
export const NO_BUTTONS: InlineKeyboardMarkup = { inline_keyboard: [] };

/**
 * A press, as the engine reads one: where the message is — its topic folded into the chat, as every message's is — who
 * pressed, and what the button carries. Null for one with no message to answer about: a press on a message too old for
 * Telegram to say where it is, or one without the data our buttons carry.
 */
export function telegramPress(query: CallbackQuery, gatewayId: string): ButtonPress | null {
  const message = query.message;
  if (!message || query.data === undefined) return null;
  const thread = "message_thread_id" in message ? message.message_thread_id : undefined;
  return {
    gatewayId,
    chatId: foldChatId(message.chat.id, thread),
    chatType: chatTypeOf(message.chat.type),
    messageId: String(message.message_id),
    data: query.data,
    senderId: String(query.from.id),
    senderName: displayName(query.from),
  };
}
