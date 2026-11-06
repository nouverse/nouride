/**
 * Inbound attachments.
 *
 * Two silent failures are pinned here, and "silent" is why they matter — neither produced an error
 * anyone could see:
 *
 * 1. A photo with no caption was dropped by the adapter, so the sender got no reply at all.
 * 2. A photo *with* a caption sent the caption and lost the image, so the model answered
 *    confidently about a screenshot it had never seen.
 */

import { describe, expect, test } from "bun:test";
import { chunk, sendsText } from "../src/commons/text.ts";
import { attachmentTypeFor } from "../src/commons/attachments.ts";
import { discordAttachments } from "../src/channels/discord/attachments.ts";
import { telegramAttachments } from "../src/channels/telegram/attachments.ts";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";
import type { OutboundMessage } from "@nouride/shared";

describe("telegramAttachments", () => {
  test("takes the largest of the photo sizes Telegram sends", () => {
    // Telegram sends the same image several times at different resolutions. Picking the first
    // gives the thumbnail, which is the version nobody wanted.
    const found = telegramAttachments({
      photo: [
        { file_id: "small", file_size: 1000, width: 90, height: 60 },
        { file_id: "large", file_size: 250_000, width: 1280, height: 853 },
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.url).toBe("large");
    expect(found[0]?.type).toBe("image");
    expect(found[0]?.filename).toBe("photo_1280x853.jpg");
  });

  test("a video note is read — a message that was only one used to arrive empty", () => {
    const [found] = telegramAttachments({ video_note: { file_id: "round", duration: 12 } });
    expect(found).toMatchObject({ type: "video", url: "round", duration: 12, recordedBySender: true });
  });

  test("a forwarded voice note says so, and one the sender recorded does not", () => {
    // Whose words they are: a forwarded recording is someone else, and content, not the sender asking.
    expect(telegramAttachments({ voice: { file_id: "v" }, forward_origin: {} })[0]?.forwarded).toBe(true);
    expect(telegramAttachments({ voice: { file_id: "v" } })[0]?.forwarded).toBeUndefined();
  });

  test("carries the file_id, not a URL", () => {
    // Telegram links are short-lived and need a second API call to mint. Resolving one here would
    // be a network round-trip on every inbound message, for bytes nothing reads yet.
    expect(telegramAttachments({ document: { file_id: "BQACAgQ" } })[0]?.url).toBe("BQACAgQ");
  });

  test.each([
    ["document", { document: { file_id: "d", file_name: "report.pdf", mime_type: "application/pdf" } }, "file"],
    ["voice", { voice: { file_id: "v", duration: 7 } }, "voice"],
    ["audio", { audio: { file_id: "a", mime_type: "audio/mpeg" } }, "audio"],
    ["video", { video: { file_id: "vid", mime_type: "video/mp4" } }, "video"],
    ["animation", { animation: { file_id: "gif" } }, "video"],
    ["sticker", { sticker: { file_id: "s", emoji: "🐱" } }, "image"],
  ] as const)("%s becomes %s", (_label, message, expected) => {
    expect(telegramAttachments(message)[0]?.type).toBe(expected);
  });

  /**
   * Telegram Desktop sends a picture uncompressed as a document. Typed `file` whatever it held, a screenshot sent from
   * a PC reached the agent as a file to open with its tools, never as a picture in front of the model (2026-10-27).
   */
  test("a picture sent as a file is an image — and a clip or a recording what it is — by its type", () => {
    const sent = (file_name: string, mime_type: string) => telegramAttachments({ document: { file_id: "doc", file_name, mime_type } })[0];
    expect(sent("Screenshot 2026-10-27 at 19.47.09.png", "image/png")).toMatchObject({
      type: "image",
      mimeType: "image/png",
      filename: "Screenshot 2026-10-27 at 19.47.09.png",
    });
    expect(sent("clip.mp4", "video/mp4")?.type).toBe("video");
    expect(sent("call.m4a", "audio/mp4")?.type).toBe("audio");
    expect(sent("report.pdf", "application/pdf")?.type).toBe("file");
    // No type at all is still a file — the engine reads its bytes before calling it a picture.
    expect(telegramAttachments({ document: { file_id: "doc" } })[0]?.type).toBe("file");
  });

  test("an animation, which carries the same file as a document for older clients, is read once", () => {
    const found = telegramAttachments({
      animation: { file_id: "gif", mime_type: "video/mp4" },
      document: { file_id: "gif", mime_type: "video/mp4" },
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe("video");
  });

  test("a sticker is an image, not nothing", () => {
    // A sticker-only message is a real message a person sent. Dropping it makes the bot look like
    // it ignored them.
    const found = telegramAttachments({ sticker: { file_id: "s", emoji: "🐱" } });
    expect(found).toHaveLength(1);
    expect(found[0]?.filename).toContain("🐱");
  });

  test("keeps duration for voice, so the model can say how long it was", () => {
    expect(telegramAttachments({ voice: { file_id: "v", duration: 42 } })[0]?.duration).toBe(42);
  });

  test("a message with several kinds returns all of them", () => {
    const found = telegramAttachments({
      photo: [{ file_id: "p" }],
      document: { file_id: "d" },
    });
    expect(found).toHaveLength(2);
  });

  test("a plain text message has none", () => {
    expect(telegramAttachments({})).toEqual([]);
  });
});

describe("discordAttachments", () => {
  test("maps name, size and content type", () => {
    const [found] = discordAttachments([
      { url: "https://cdn.example/x.png", name: "shot.png", contentType: "image/png", size: 4096 },
    ]);
    expect(found).toMatchObject({
      type: "image",
      url: "https://cdn.example/x.png",
      filename: "shot.png",
      mimeType: "image/png",
      size: 4096,
    });
  });

  test("a missing content type is still an attachment", () => {
    // Refusing to classify would drop the message it arrived with.
    expect(discordAttachments([{ url: "u", contentType: null }])[0]?.type).toBe("file");
  });

  test("a null duration is omitted rather than stored as null", () => {
    expect(discordAttachments([{ url: "u", duration: null }])[0]).not.toHaveProperty("duration");
  });
});

describe("attachmentTypeFor", () => {
  test.each([
    ["image/png", "image"],
    ["image/webp", "image"],
    ["video/mp4", "video"],
    ["audio/ogg", "audio"],
    ["application/pdf", "file"],
    ["text/plain", "file"],
    ["IMAGE/PNG", "image"],
  ] as const)("%s → %s", (mime, expected) => {
    expect(attachmentTypeFor(mime)).toBe(expected);
  });
});

/**
 * The placeholder that arrived before every file.
 *
 * `chunk("")` answers `["(empty response)"]` — a deliberate guard so a reply that produced no text
 * still says something instead of vanishing. `send_file` sends `text: ""` because the caption rides
 * on the attachment, so the guard fired and posted that placeholder before each of three files in a
 * real Telegram chat. The guard belongs to a *reply*; a message carrying a file is not one.
 */
describe("an attachment-only message", () => {
  test("chunk still guards a genuinely empty reply", () => {
    expect(chunk("", 100)).toEqual(["(empty response)"]);
  });

  test("the adapters skip the text send when there is a file and nothing to say", () => {
    // `sendsText` is the condition all three adapters apply before chunking. This used to be asserted on a copy of the
    // condition written in the test, which no change to an adapter could turn red.
    expect(sendsText({ text: "", attachments: [{}] })).toBe(false); // a file with no caption text — the bug
    expect(sendsText({ text: "   ", attachments: [{}, {}] })).toBe(false); // whitespace is not something to say
    expect(sendsText({ text: "" })).toBe(true); // an empty reply still gets the guard
    expect(sendsText({ text: "", attachments: [] })).toBe(true);
    expect(sendsText({ text: "here it is", attachments: [{}] })).toBe(true); // text plus a file sends both
  });

  test("Telegram sends the file alone — no placeholder line before it", async () => {
    // The rule above, applied where it was broken: through the adapter's own `deliver`.
    const telegram = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
    const sent: string[] = [];
    (telegram as unknown as { bot: unknown }).bot = {
      api: {
        sendMessage: async (_chat: string, text: string) => (sent.push(`text:${text}`), { message_id: sent.length }),
        sendDocument: async () => (sent.push("document"), { message_id: sent.length }),
      },
    };
    const deliver = (msg: OutboundMessage) => (telegram as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);

    await deliver({ gatewayId: "telegram:main", chatId: "42", text: "", attachments: [{ type: "file", mimeType: "text/plain", filename: "a.txt", buffer: new Uint8Array([1]) }] });
    expect(sent).toEqual(["document"]);
  });

  describe("Discord, through its own deliver", () => {
    /** A Discord gateway whose channel `42` records what is sent to it — `connect()` would put a logged-in client here. */
    function discordWithChannel(): { deliver: (msg: OutboundMessage) => Promise<string[]>; sent: string[] } {
      const discord = new DiscordGateway({ id: "discord:main", platform: "discord", token: "t" });
      const sent: string[] = [];
      const channel = {
        isTextBased: () => true,
        sendTyping: async () => undefined,
        send: async (options: { content?: string; files?: unknown[] }) => {
          sent.push(options.files ? `file${options.content ? `:${options.content}` : ""}` : `text:${options.content}`);
          return { id: String(sent.length) };
        },
      };
      (discord as unknown as { client: unknown }).client = {
        channels: { cache: new Map([["42", channel]]), fetch: async () => channel },
      };
      const deliver = (msg: OutboundMessage) => (discord as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);
      return { deliver, sent };
    }
    const file = { type: "file" as const, mimeType: "text/plain", filename: "a.txt", buffer: new Uint8Array([1]) };

    test("a file with nothing to say goes alone — no placeholder line before it", async () => {
      const { deliver, sent } = discordWithChannel();
      await deliver({ gatewayId: "discord:main", chatId: "42", text: "", attachments: [file] });
      expect(sent).toEqual(["file"]);
    });

    test("text with a file sends both, the text first", async () => {
      const { deliver, sent } = discordWithChannel();
      await deliver({ gatewayId: "discord:main", chatId: "42", text: "here it is", attachments: [file] });
      expect(sent).toEqual(["text:here it is", "file"]);
    });

    test("an empty reply with no file still says something", async () => {
      const { deliver, sent } = discordWithChannel();
      await deliver({ gatewayId: "discord:main", chatId: "42", text: "" });
      expect(sent).toEqual(["text:(empty response)"]);
    });
  });
});
