/**
 * A message whose files are one set: an album where the platform has albums, one after another where it has none.
 *
 * Every adapter sent a message's files one by one. The slides of a carousel were eight messages, and on a platform that
 * shows several pictures as one, that is what a person expects of eight slides. A message says its files are one set
 * (`together`, which `send_file` asks for with several files); a message that does not is sent as it always was.
 */

import { describe, expect, test } from "bun:test";
import type { Attachment, OutboundMessage } from "@nouride/shared";
import { deliverInParts, PartialDeliveryError } from "../src/commons/resilience.ts";
import { discordAlbumRun } from "../src/channels/discord/album.ts";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { telegramAlbumRun } from "../src/channels/telegram/album.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";

const bytes = new Uint8Array([1, 2, 3]);
const file = (filename: string, type: Attachment["type"] = "image", more: Partial<Attachment> = {}): Attachment => ({ type, mimeType: "application/octet-stream", filename, buffer: bytes, ...more });
const names = (files: readonly Attachment[]) => files.map((one) => one.filename);
const message = (attachments: Attachment[], together = true): OutboundMessage => ({ gatewayId: "g", chatId: "42", text: "", attachments, ...(together ? { together: true as const } : {}) });

describe("the shared sending of a message's files", () => {
  /** Sends that record what went as one and what went alone; `take` is the platform's rule. */
  function recording(take: (left: readonly Attachment[]) => number, failAt?: string) {
    const sent: string[] = [];
    return {
      sent,
      send: {
        text: async () => {},
        attachment: async (one: Attachment, ids: string[]) => {
          if (one.filename === failAt) throw new Error("upload failed");
          sent.push(`alone:${one.filename}`);
          ids.push(String(sent.length));
        },
        album: {
          take,
          send: async (files: readonly Attachment[], ids: string[]) => {
            if (names(files).includes(failAt)) throw new Error("upload failed");
            sent.push(`album:${names(files).join("+")}`);
            ids.push(String(sent.length));
          },
        },
      },
    };
  }
  const five = ["a", "b", "c", "d", "e"].map((name) => file(name));

  test("takes as many as the platform says go as one, then goes on from there, in order", async () => {
    const two = recording((left) => Math.min(left.length, 2));
    await deliverInParts(message(five), [], two.send);
    // Two, two, and the last by itself: fewer than two is no album.
    expect(two.sent).toEqual(["album:a+b", "album:c+d", "alone:e"]);
    const none = recording(() => 0);
    await deliverInParts(message(five), [], none.send);
    expect(none.sent).toEqual(["alone:a", "alone:b", "alone:c", "alone:d", "alone:e"]);
  });

  test("a message that does not say its files are one set is sent one by one, as it always was", async () => {
    const all = recording((left) => left.length);
    await deliverInParts(message(five, false), [], all.send);
    expect(all.sent).toEqual(["alone:a", "alone:b", "alone:c", "alone:d", "alone:e"]);
  });

  test("a platform that claims more than there is cannot run past the end, and one with no album sends each", async () => {
    const greedy = recording(() => 99);
    await deliverInParts(message(five), [], greedy.send);
    expect(greedy.sent).toEqual(["album:a+b+c+d+e"]);
    const plain = recording(() => 99);
    const { album: _album, ...noAlbum } = plain.send;
    await deliverInParts(message(five), [], noAlbum);
    expect(plain.sent).toHaveLength(5);
  });

  test("when an album fails after one landed, what is left starts at that album's first file", async () => {
    const failing = recording((left) => Math.min(left.length, 2), "d");
    const thrown = await deliverInParts(message(five), [], failing.send).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(PartialDeliveryError);
    const partial = thrown as PartialDeliveryError;
    expect(failing.sent).toEqual(["album:a+b"]);
    expect(names(partial.remaining.attachments ?? [])).toEqual(["c", "d", "e"]);
    // Still one set when it is sent again.
    expect(partial.remaining.together).toBe(true);
  });
});

describe("what Telegram takes as one album", () => {
  test("two to ten of one family: pictures and videos together, documents with documents, audio with audio", () => {
    expect(telegramAlbumRun([file("a"), file("b"), file("c", "video")])).toBe(3);
    expect(telegramAlbumRun([file("a.pdf", "file"), file("b.pdf", "file"), file("c", "image")])).toBe(2);
    expect(telegramAlbumRun([file("a.mp3", "audio"), file("b.mp3", "audio")])).toBe(2);
    expect(telegramAlbumRun(Array.from({ length: 14 }, (_, index) => file(`s${index}`)))).toBe(10);
  });

  test("one of its family, a voice note, or a file with no bytes goes by itself", () => {
    expect(telegramAlbumRun([file("a"), file("b.pdf", "file"), file("c")])).toBe(0);
    expect(telegramAlbumRun([file("a")])).toBe(0);
    expect(telegramAlbumRun([file("v.ogg", "voice"), file("w.ogg", "voice")])).toBe(0);
    const { buffer: _buffer, ...noBytes } = file("a");
    expect(telegramAlbumRun([noBytes, file("b")])).toBe(0);
    expect(telegramAlbumRun([file("a"), noBytes, file("c")])).toBe(0);
    expect(telegramAlbumRun([])).toBe(0);
  });
});

describe("Telegram, through its own deliver", () => {
  function telegram(o: { refuseAlbum?: boolean | string } = {}) {
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
    const calls: string[] = [];
    let id = 0;
    const one = (kind: string) => async (_chat: string, _file: unknown, options: { caption?: string }) => (calls.push(`${kind}${options.caption ? `:${options.caption}` : ""}`), { message_id: ++id });
    (gateway as unknown as { bot: unknown }).bot = {
      api: {
        sendPhoto: one("photo"),
        sendVideo: one("video"),
        sendDocument: one("document"),
        sendMediaGroup: async (_chat: string, media: { type: string; caption?: string }[]) => {
          if (o.refuseAlbum) {
            const { GrammyError } = await import("grammy");
            const blocked = typeof o.refuseAlbum === "string";
            throw new GrammyError(blocked ? "Forbidden" : "Bad Request", { ok: false, error_code: blocked ? 403 : 400, description: blocked ? (o.refuseAlbum as string) : "Bad Request: IMAGE_PROCESS_FAILED" }, "sendMediaGroup", {});
          }
          calls.push(`group:${media.map((item) => `${item.type}${item.caption ? `(${item.caption})` : ""}`).join("+")}`);
          return media.map(() => ({ message_id: ++id }));
        },
      },
    };
    const deliver = (msg: OutboundMessage) => (gateway as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);
    return { deliver, calls };
  }
  const slides = [file("s1.png", "image", { caption: "Tiga langkah" }), file("s2.png"), file("s3.mp4", "video")];

  test("a set of pictures is one media group, its caption under the first, and an id for each", async () => {
    const { deliver, calls } = telegram();
    const ids = await deliver({ ...message(slides), gatewayId: "telegram:main" });
    expect(calls).toEqual(["group:photo(Tiga langkah)+photo+video"]);
    expect(ids).toEqual(["1", "2", "3"]);
  });

  test("the same files in a message that is no set go one by one, as before", async () => {
    const { deliver, calls } = telegram();
    await deliver({ ...message(slides, false), gatewayId: "telegram:main" });
    expect(calls).toEqual(["photo:Tiga langkah", "photo", "video"]);
  });

  test("an album Telegram refuses for one of its pictures is sent file by file, in order", async () => {
    const { deliver, calls } = telegram({ refuseAlbum: true });
    const ids = await deliver({ ...message(slides), gatewayId: "telegram:main" });
    expect(calls).toEqual(["photo:Tiga langkah", "photo", "video"]);
    expect(ids).toHaveLength(3);
  });
});

describe("an album Telegram will never take", () => {
  test("is not tried again file by file: the chat's answer would be the same for each", async () => {
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
    const calls: string[] = [];
    const { GrammyError } = await import("grammy");
    (gateway as unknown as { bot: unknown }).bot = {
      api: {
        sendPhoto: async () => (calls.push("photo"), { message_id: 1 }),
        sendMediaGroup: async () => {
          calls.push("group");
          throw new GrammyError("Forbidden", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMediaGroup", {});
        },
      },
    };
    const deliver = (msg: OutboundMessage) => (gateway as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);
    const thrown = await deliver({ ...message([file("s1.png"), file("s2.png")]), gatewayId: "telegram:main" }).catch((err: unknown) => err);
    expect(String((thrown as { description?: string }).description)).toBe("Forbidden: bot was blocked by the user");
    expect(calls).toEqual(["group"]);
  });
});

describe("Discord", () => {
  test("takes two to ten files that have their bytes as one message, and never a voice note", () => {
    expect(discordAlbumRun([file("a"), file("b.pdf", "file"), file("c.mp4", "video")])).toBe(3);
    expect(discordAlbumRun(Array.from({ length: 12 }, (_, index) => file(`s${index}`)))).toBe(10);
    expect(discordAlbumRun([file("a")])).toBe(0);
    expect(discordAlbumRun([file("v.ogg", "voice"), file("b")])).toBe(0);
    expect(discordAlbumRun([file("a"), file("b"), file("v.ogg", "voice")])).toBe(2);
  });

  test("a set is one message with every file, the first one's caption its words", async () => {
    const discord = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" });
    const sent: { content?: string; files: string[] }[] = [];
    const channel = {
      isTextBased: () => true,
      sendTyping: async () => undefined,
      send: async (options: { content?: string; files?: { name: string }[] }) => (sent.push({ ...(options.content ? { content: options.content } : {}), files: (options.files ?? []).map((one) => one.name) }), { id: String(sent.length) }),
    };
    (discord as unknown as { client: unknown }).client = { channels: { cache: new Map([["42", channel]]), fetch: async () => channel } };
    const deliver = (msg: OutboundMessage) => (discord as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);
    const slides = [file("s1.png", "image", { caption: "Tiga langkah" }), file("s2.png"), file("s3.png")];

    expect(await deliver({ ...message(slides), gatewayId: "discord:main" })).toEqual(["1"]);
    expect(sent).toEqual([{ content: "Tiga langkah", files: ["s1.png", "s2.png", "s3.png"] }]);
    // No set: a message a file, as before.
    sent.length = 0;
    await deliver({ ...message(slides, false), gatewayId: "discord:main" });
    expect(sent.map((one) => one.files)).toEqual([["s1.png"], ["s2.png"], ["s3.png"]]);
  });
});
