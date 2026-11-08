/**
 * The Telegram adapter end to end, with Telegram's half answered here: `init` says who the bot is, `start` is a poll
 * the test ends, and an update goes in through `handleUpdate` the way a poll would hand it over.
 *
 * Written for a mutation sweep of the untested areas: what reaches the engine from a message, what a
 * polling failure turns into, and which failures are the token's. Each was a decision no test had reached.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Api, Bot, BotError, GrammyError } from "grammy";
import type { Message } from "grammy/types";
import { holdLines, type GatewayEvent, type MessageEnvelope } from "@nouride/shared";
import { POLL_PROVES_ALIVE_MS, TelegramGateway, retryAfterSeconds, telegramRefusal, isConflict } from "../src/channels/telegram/gateway.ts";
import { quotedContext, telegramMentions } from "../src/channels/telegram/envelope.ts";
import { eventually } from "./wait.ts";

const ME = { id: 1, is_bot: true, first_name: "Nouva", username: "nouva_bot", can_read_all_group_messages: true } as Bot["botInfo"];

interface Inner {
  bot: Bot | undefined;
  settleMs: number;
  alive(now?: number): Promise<boolean>;
  pacer: { limits: { perChat(chat: string): { count: number } } };
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** A started gateway, its poll's ending in the test's hands. */
async function started(options: { botInfo?: Bot["botInfo"]; mode?: "polling" | "webhook" } = {}) {
  const polls: { reject: (err: unknown) => void; bot: Bot; poll: Promise<void> }[] = [];
  const init = spyOn(Bot.prototype, "init").mockImplementation(async function (this: Bot) {
    this.botInfo = options.botInfo ?? ME;
  });
  const start = spyOn(Bot.prototype, "start").mockImplementation(function (this: Bot) {
    let reject!: (err: unknown) => void;
    const poll = new Promise<void>((_resolve, fail) => (reject = fail));
    polls.push({ reject, bot: this, poll });
    return poll;
  });
  const stop = spyOn(Bot.prototype, "stop").mockImplementation(async () => {});
  restores.push(() => {
    init.mockRestore();
    start.mockRestore();
    stop.mockRestore();
  });
  const gateway = new TelegramGateway({
    id: "telegram:main",
    platform: "telegram",
    token: "1:a",
    mode: options.mode ?? "polling",
    resilience: { healthCheckIntervalMs: 3_600_000, reconnectBackoffMs: 3_600_000, reconnectBackoffMaxMs: 3_600_000 },
  });
  const envelopes: MessageEnvelope[] = [];
  const events: GatewayEvent[] = [];
  gateway.onMessage((envelope) => envelopes.push(envelope));
  gateway.onEvent((event) => events.push(event));
  await gateway.start();
  restores.push(() => void gateway.stop());
  const inner = gateway as unknown as Inner;
  return { gateway, inner, polls, envelopes, events, init, stop };
}

let updateId = 0;
/** One message, as a poll delivers it. */
async function deliver(bot: Bot, message: Record<string, unknown>): Promise<void> {
  await bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: 10, date: 1_700_000_000, chat: { id: 42, type: "private" }, from: { id: 9, is_bot: false, first_name: "Ann" }, ...message } as never,
  });
}

const grammyError = (code: number, description = "x", parameters: Record<string, unknown> = {}) =>
  new GrammyError("Call failed!", { ok: false, error_code: code, description, parameters }, "getUpdates", {});

const lastError = (events: GatewayEvent[]) =>
  events.flatMap((event) => (event.type === "status" && event.error ? [event.error] : [])).at(-1);

describe("what a message becomes", () => {
  test("a direct message, every field", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { text: "halo", from: { id: 9, is_bot: false, first_name: "Ann", last_name: "Lee" } });

    expect(envelopes).toHaveLength(1);
    const { raw: _raw, ...envelope } = envelopes[0]!;
    expect(envelope).toEqual({
      id: "10",
      timestamp: 1_700_000_000_000,
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "42",
      chatType: "dm",
      senderId: "9",
      senderName: "Ann Lee",
      text: "halo",
      mentions: [],
    });
  });

  test("a channel post with no sender is the chat's, said as unknown", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { text: "news", chat: { id: -1009, type: "channel" }, from: undefined });

    expect(envelopes[0]).toMatchObject({ chatType: "channel", senderId: "-1009", senderName: "unknown" });
    expect(envelopes[0]!.senderIsBot).toBeUndefined();
  });

  test("a sender known only by username is named by it; a bot is marked as one", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { text: "hi", from: { id: 5, is_bot: true, first_name: "", username: "other_bot" } });

    expect(envelopes[0]).toMatchObject({ senderName: "other_bot", senderIsBot: true });
  });

  test("a basic group numbers per connection; a supergroup does not", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { text: "a", chat: { id: -5, type: "group" } });
    await deliver(inner.bot!, { text: "b", chat: { id: -1005, type: "supergroup" } });

    expect(envelopes.map((e) => [e.chatType, e.idsPerConnection])).toEqual([
      ["group", true],
      ["group", undefined],
    ]);
  });

  test("nothing to say and nobody tagged is not a message", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { text: "   " });

    expect(envelopes).toEqual([]);
  });

  test("a bare tag of this bot is a message, with no words and mentionsSelf", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { text: "@nouva_bot", entities: [{ type: "mention", offset: 0, length: 10 }] });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ text: "", mentionsSelf: true, mentions: [] });
  });

  test("a photo with no caption is a message, with its one attachment", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { photo: [{ file_id: "p1", file_unique_id: "u1", width: 10, height: 10 }] });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.attachments).toHaveLength(1);
  });

  test("our own message coming back is not answered", async () => {
    const { inner, envelopes } = await started();
    await deliver(inner.bot!, { text: "echo", from: { id: 1, is_bot: true, first_name: "Nouva" } });

    expect(envelopes).toEqual([]);
  });

  test("before it knows who it is, the adapter has no handle and no id", () => {
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
    expect(gateway.selfMention).toBeUndefined();
    expect(gateway.selfId).toBeUndefined();
    expect(gateway.echoesOwnMessages).toBe(false);
  });

  test("once connected, it is @username and its numeric id", async () => {
    const { gateway } = await started();
    expect(gateway.selfMention).toBe("@nouva_bot");
    expect(gateway.selfId).toBe("1");
  });

  test("a group is paced at twenty a minute, a person at one a second", async () => {
    const { inner } = await started();
    expect(inner.pacer.limits.perChat("-1005").count).toBe(20);
    expect(inner.pacer.limits.perChat("42").count).toBe(1);
  });
});

describe("connecting", () => {
  test("the HTTP request outlasts the fifty-second poll by ten", async () => {
    const { inner } = await started();
    expect((inner.bot as unknown as { clientConfig: { timeoutSeconds: number } }).clientConfig.timeoutSeconds).toBe(60);
  });

  test("privacy mode on is said at connect, naming the bot and the fix; off, nothing is said", async () => {
    const warned = async (botInfo: Bot["botInfo"]) => {
      const release = holdLines();
      await started({ botInfo });
      const lines = release();
      return lines.filter((line) => line.message.startsWith("privacy mode is on")).map((line) => line.message);
    };
    const [named] = await warned({ ...ME, can_read_all_group_messages: false });
    expect(named).toBe(
      "privacy mode is on: in groups where it is not an admin, @nouva_bot receives only commands and replies to its own messages; tags and agent names never reach it. " +
        "Turn it off with BotFather /setprivacy (then remove and re-add the bot to each group), or make the bot a group admin",
    );
    const [unnamed] = await warned({ ...ME, username: undefined, can_read_all_group_messages: false } as unknown as Bot["botInfo"]);
    expect(unnamed).toContain("@this bot receives only commands");
    expect(await warned(ME)).toEqual([]);
  });

  test("webhook mode is refused before Telegram is asked anything", async () => {
    const { init, events } = await started({ mode: "webhook" });
    expect(init).not.toHaveBeenCalled();
    expect(lastError(events)).toContain('webhook mode is not implemented; use mode = "polling"');
  });

  test("a token Telegram cannot read (404) or refuses (401) is the token's", async () => {
    for (const code of [401, 404]) {
      const init = spyOn(Bot.prototype, "init").mockImplementation(async () => {
        throw grammyError(code, "Not Found");
      });
      const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling", resilience: { reconnectBackoffMs: 3_600_000 } });
      const events: GatewayEvent[] = [];
      gateway.onEvent((event) => events.push(event));
      await gateway.start();
      await gateway.stop();
      init.mockRestore();
      expect(events.flatMap((e) => (e.type === "status" && e.error ? [e.error] : []))[0]).toContain("Telegram refused the bot token: Not Found");
    }
  });

  test("any other failure of init is not the token's — nor is a 401 that is not Telegram's", async () => {
    for (const thrown of [grammyError(500, "Internal"), Object.assign(new Error("socket hang up"), { error_code: 401 })]) {
      const init = spyOn(Bot.prototype, "init").mockImplementation(async () => {
        throw thrown;
      });
      const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling", resilience: { reconnectBackoffMs: 3_600_000 } });
      const events: GatewayEvent[] = [];
      gateway.onEvent((event) => events.push(event));
      await gateway.start();
      await gateway.stop();
      init.mockRestore();
      expect(events.flatMap((e) => (e.type === "status" && e.error ? [e.error] : []))[0]).not.toContain("refused the bot token");
    }
  });

  test("a poll that answered on the last connection proves nothing about this one", async () => {
    const { gateway, inner } = await started();
    const getMe = spyOn(Api.prototype, "getMe").mockImplementation(async () => ({}) as Awaited<ReturnType<Api["getMe"]>>);
    restores.push(() => getMe.mockRestore());
    const [record] = inner.bot!.api.config.installedTransformers();
    const answer = { ok: true as const, result: ["update"] };
    // The transformer hands the poll's answer on unchanged.
    expect(await record!((async () => answer) as never, "getUpdates", {} as never, undefined)).toBe(answer as never);

    await gateway.stop();
    await gateway.start();
    await inner.alive();
    expect(getMe).toHaveBeenCalledTimes(1);
  });
});

describe("the health check's edges", () => {
  async function polledAt(at: number) {
    const s = await started();
    const now = spyOn(Date, "now").mockImplementation(() => at);
    const [record] = s.inner.bot!.api.config.installedTransformers();
    await record!((async () => ({ ok: true, result: [] })) as never, "getUpdates", {} as never, undefined);
    now.mockRestore();
    const getMe = spyOn(Api.prototype, "getMe").mockImplementation(async () => ({}) as Awaited<ReturnType<Api["getMe"]>>);
    restores.push(() => getMe.mockRestore());
    return { ...s, getMe };
  }

  test("exactly two windows after a poll, it asks", async () => {
    const { inner, getMe } = await polledAt(5_000);
    expect(await inner.alive(5_000 + POLL_PROVES_ALIVE_MS)).toBe(true);
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  test("a poll at the clock's first millisecond still counts", async () => {
    const { inner, getMe } = await polledAt(1);
    expect(await inner.alive(2)).toBe(true);
    expect(getMe).not.toHaveBeenCalled();
  });

  test("with no poll yet, an early clock is no proof", async () => {
    const { inner } = await started();
    const getMe = spyOn(Api.prototype, "getMe").mockImplementation(async () => {
      throw new Error("down");
    });
    restores.push(() => getMe.mockRestore());
    expect(await inner.alive(50_000)).toBe(false);
    expect(getMe).toHaveBeenCalledTimes(1);
  });
});

describe("when polling fails", () => {
  test("a middleware failure reconnects — unless it was a bad request", async () => {
    const { gateway, inner } = await started();
    inner.bot!.errorHandler(new BotError(grammyError(400, "Bad Request"), {} as never));
    expect(gateway.status).toBe("connected");
    inner.bot!.errorHandler(new BotError(grammyError(401), {} as never));
    expect(gateway.status).toBe("reconnecting");
  });

  test("a failure that is not Telegram's reconnects too", async () => {
    const { gateway, inner } = await started();
    inner.bot!.errorHandler(new BotError(new Error("ECONNRESET"), {} as never));
    expect(gateway.status).toBe("reconnecting");
  });

  test("a replaced bot's failure is ignored — middleware or poll", async () => {
    const { gateway, inner, polls } = await started();
    const old = inner.bot!;
    await gateway.stop();
    await gateway.start();
    old.errorHandler(new BotError(grammyError(500), {} as never));
    polls[0]!.reject(grammyError(409));
    // The old poll's end, seen after the gateway's own handler on it: that one was attached when the poll began.
    await polls[0]!.poll.catch(() => {});
    expect(gateway.status).toBe("connected");
  });

  test("a poll that stops reconnects; a conflict waits out Telegram's session first", async () => {
    const first = await started();
    first.polls[0]!.reject(new Error("ETIMEDOUT"));
    await eventually(() => first.gateway.status === "reconnecting", 2_000, "the stopped poll to reconnect");
    expect(first.inner.settleMs).toBe(0);

    const second = await started();
    second.polls[0]!.reject(grammyError(409, "Conflict"));
    await eventually(() => second.gateway.status === "reconnecting", 2_000, "the conflicted poll to reconnect");
    expect(second.inner.settleMs).toBe(35_000);
  });

  test("stopping stops the bot once, and leaves nothing to stop again", async () => {
    const { gateway, stop } = await started();
    await gateway.stop();
    await gateway.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(gateway.syncCommands([])).rejects.toThrow("not connected");
  });
});

describe("the calls a connection makes", () => {
  test("typing goes to the chat, and to the topic when the chat id names one", async () => {
    const { gateway } = await started();
    const action = spyOn(Api.prototype, "sendChatAction").mockImplementation(async () => true);
    restores.push(() => action.mockRestore());
    await gateway.setTyping("-100123:45");
    await gateway.setTyping("123");
    await gateway.setTyping("abc:def");

    expect(action.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      ["-100123", "typing", { message_thread_id: 45 }],
      ["123", "typing", {}],
      ["abc:def", "typing", {}],
    ]);
  });

  test("the command menu is set, and how many were sent is said", async () => {
    const { gateway } = await started();
    const set = spyOn(Api.prototype, "setMyCommands").mockImplementation(async () => true);
    restores.push(() => set.mockRestore());
    expect(await gateway.syncCommands([{ command: "daemon-restart", description: "d" }])).toEqual({ synced: 1 });
    expect(set.mock.calls[0]![0]).toEqual([{ command: "daemon_restart", description: "d" }]);
  });

  test("a command menu before connecting is refused as not connected", async () => {
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
    await expect(gateway.syncCommands([])).rejects.toThrow("not connected");
  });

  test("an attachment with no file id, or a file with no path, is fetched from nowhere", async () => {
    const { gateway } = await started();
    const getFile = spyOn(Api.prototype, "getFile").mockImplementation(async () => ({ file_id: "f", file_unique_id: "u" }));
    const fetched = spyOn(globalThis, "fetch");
    restores.push(() => {
      getFile.mockRestore();
      fetched.mockRestore();
    });
    expect(await gateway.fetchAttachment({ type: "image", mimeType: "image/jpeg" })).toBeNull();
    expect(getFile).not.toHaveBeenCalled();
    expect(await gateway.fetchAttachment({ type: "image", url: "f", mimeType: "image/jpeg" })).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
  });

  test("an attachment whose lookup fails is null, not an exception", async () => {
    const { gateway } = await started();
    const getFile = spyOn(Api.prototype, "getFile").mockImplementation(async () => {
      throw new Error("down");
    });
    restores.push(() => getFile.mockRestore());
    expect(await gateway.fetchAttachment({ type: "image", url: "f", mimeType: "image/jpeg" })).toBeNull();
  });
});

describe("the pure decisions", () => {
  test("a 429 with no retry_after waits a second", () => {
    expect(retryAfterSeconds(new GrammyError("x", { ok: false, error_code: 429, description: "Too Many Requests" }, "sendMessage", {}))).toBe(1);
  });

  test("a refusal is only ever Telegram's own", () => {
    expect(telegramRefusal(Object.assign(new Error("x"), { error_code: 403, description: "Forbidden" }))).toBeNull();
  });

  test("a 400 that mentions 409 in its words is not a conflict", () => {
    expect(isConflict(grammyError(400, "Bad Request: message 409 not found"))).toBe(false);
  });

  test("the quoted author is first and last name with a space", () => {
    const message = { reply_to_message: { text: "q", from: { id: 2, is_bot: false, first_name: "Ann", last_name: "Lee" } } } as unknown as Message;
    expect(quotedContext(message).quotedSender).toBe("Ann Lee");
  });
});

describe("mentions, at their edges", () => {
  const ME_ID = { id: 777, username: "nouva_bot" };
  const message = (text: string, entities: unknown[]) => ({ text, entities }) as never;

  test("a bot with no username is still tagged by a text_mention, and nothing is stripped", () => {
    const result = telegramMentions(message("Nouva lihat", [{ type: "text_mention", offset: 0, length: 5, user: { id: 777, is_bot: true, first_name: "Nouva" } }]), { id: 777 });
    expect(result).toEqual({ mentions: [], mentionsSelf: true, text: "Nouva lihat" });
  });

  test("a bot with no username reads an @mention as somebody else's", () => {
    expect(telegramMentions(message("@x_bot hi", [{ type: "mention", offset: 0, length: 6 }]), { id: 777 })).toEqual({ mentions: ["x_bot"], mentionsSelf: false, text: "@x_bot hi" });
  });

  test("a text_mention of somebody else is their username", () => {
    const result = telegramMentions(message("Bob lihat", [{ type: "text_mention", offset: 0, length: 3, user: { id: 5, is_bot: false, first_name: "Bob", username: "bob" } }]), ME_ID);
    expect(result).toEqual({ mentions: ["bob"], mentionsSelf: false, text: "Bob lihat" });
  });

  test("formatting is not a mention, whatever it covers", () => {
    const result = telegramMentions(message("a@nouva_bot b", [{ type: "bold", offset: 0, length: 11 }]), ME_ID);
    expect(result).toEqual({ mentions: [], mentionsSelf: false, text: "a@nouva_bot b" });
  });

  test("our tag in another case comes off the front", () => {
    expect(telegramMentions(message("@Nouva_Bot cek", [{ type: "mention", offset: 0, length: 10 }]), ME_ID).text).toBe("cek");
  });

  test("a command with digits, addressed to us in another case, is the bare command", () => {
    const result = telegramMentions(message("/top5@Nouva_Bot now", [{ type: "bot_command", offset: 0, length: 15 }]), ME_ID);
    expect(result).toEqual({ mentions: [], mentionsSelf: true, text: "/top5 now" });
  });
});
