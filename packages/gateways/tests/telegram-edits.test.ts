/**
 * A person's edit on Telegram (G11): `edited_message`, asked for by the poll and handed to the engine as the edit it is —
 * what the message says now, the message it changes, when that was sent, an id of its own. Only a person's, only words.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { telegramEdit } from "../src/channels/telegram/envelope.ts";
import { pollingOptions } from "../src/channels/telegram/gateway.ts";
import { ME, startedTelegram } from "./telegram-harness.ts";

const restores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) await restore();
});

async function started() {
  const t = await startedTelegram();
  restores.push(t.restore);
  return t;
}

const edited = (over: Record<string, unknown> = {}) => ({
  message_id: 10,
  date: 1_700_000_000,
  edit_date: 1_700_000_090,
  chat: { id: 42, type: "private" },
  from: { id: 9, is_bot: false, first_name: "Ann" },
  text: "weather in Jakarta",
  ...over,
});

describe("an edited message", () => {
  test("reaches the engine as an edit: what it says now, the message it changes, when that was sent, an id of its own", async () => {
    const t = await started();
    await t.update({ edited_message: edited() });

    expect(t.envelopes).toHaveLength(1);
    const { raw: _raw, ...envelope } = t.envelopes[0]!;
    expect(envelope).toEqual({
      id: "10:edited:1700000090000",
      timestamp: 1_700_000_090_000,
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "42",
      chatType: "dm",
      senderId: "9",
      senderName: "Ann",
      text: "weather in Jakarta",
      mentions: [],
      edit: { of: "10", sentAt: 1_700_000_000_000 },
    });
  });

  test("an edit that now tags this bot addresses it, its tag off the front; in a topic, the topic is its chat", async () => {
    const t = await started();
    await t.update({
      edited_message: edited({ text: "@nouva_bot lunch?", entities: [{ type: "mention", offset: 0, length: 10 }], chat: { id: -1005, type: "supergroup" }, message_thread_id: 7, is_topic_message: true }),
    });
    expect(t.envelopes[0]).toMatchObject({ text: "lunch?", mentionsSelf: true, chatId: "-1005:7", chatType: "group", edit: { of: "10" } });
  });

  test("words only: a photo whose caption was edited is the caption, its file not sent again", () => {
    const envelope = telegramEdit(edited({ text: undefined, caption: "the right caption", photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] }) as never, { gatewayId: "telegram:main", me: ME });
    expect(envelope).toMatchObject({ text: "the right caption", edit: { of: "10" } });
    expect(envelope?.attachments).toBeUndefined();
  });

  test("a bot's edit, our own, and one that leaves no words are not edits", async () => {
    const t = await started();
    await t.update({ edited_message: edited({ from: { id: 5, is_bot: true, first_name: "Other", username: "other_bot" } }) });
    await t.update({ edited_message: edited({ from: { id: ME.id, is_bot: true, first_name: "Nouva" } }) });
    await t.update({ edited_message: edited({ text: "@nouva_bot", entities: [{ type: "mention", offset: 0, length: 10 }] }) });
    expect(t.envelopes).toEqual([]);
  });

  test("a message that is not an edit is still a message, with no edit on it", async () => {
    const t = await started();
    await t.update({ message: edited({ edit_date: undefined }) });
    expect(t.envelopes[0]).toMatchObject({ id: "10", text: "weather in Jakarta" });
    expect(t.envelopes[0]!.edit).toBeUndefined();
  });

  test("the poll asks Telegram for edits", () => {
    expect(pollingOptions().allowed_updates).toContain("edited_message");
  });
});
