/**
 * How an incoming WhatsApp message becomes what the agent is told — `src/message.ts`, with no socket.
 *
 * These used to sit inside the code that held the connection, where nothing reached them without a live session:
 * text, quote, mentions and media could regress with every test green.
 */

import { describe, expect, test } from "bun:test";
import { proto, type WAMessage } from "@whiskeysockets/baileys";
import {
  contextInfoOf,
  editEvent,
  extensionFor,
  incoming,
  incomingEdit,
  mediaKind,
  messageEvent,
  selfIdsOf,
  splitMessage,
  textOf,
  textOfContent,
} from "../src/message.ts";

const DM = "628111111111@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const MEMBER = "100000000000001@lid";

function message(content: Record<string, unknown> | null, key: Partial<WAMessage["key"]> = {}, extra: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { remoteJid: DM, id: "MSG1", fromMe: false, ...key },
    message: content,
    pushName: "Mira",
    messageTimestamp: 1_760_000_000,
    ...extra,
  } as WAMessage;
}

describe("textOf", () => {
  test("a plain message, an extended one, and each caption", () => {
    expect(textOf(message({ conversation: "halo" }))).toBe("halo");
    expect(textOf(message({ extendedTextMessage: { text: "with a quote" } }))).toBe("with a quote");
    expect(textOf(message({ imageMessage: { caption: "a photo" } }))).toBe("a photo");
    expect(textOf(message({ videoMessage: { caption: "a clip" } }))).toBe("a clip");
    expect(textOf(message({ documentMessage: { caption: "the report" } }))).toBe("the report");
  });

  test("nothing to read is the empty string, not a throw", () => {
    expect(textOf(message(null))).toBe("");
    expect(textOf(message({ audioMessage: { mimetype: "audio/ogg" } }))).toBe("");
  });
});

describe("contextInfoOf", () => {
  test("found on whichever content type carries it — an image's caption as well as a text", () => {
    const info = { mentionedJid: [MEMBER], stanzaId: "Q1" };
    expect(contextInfoOf(message({ extendedTextMessage: { text: "x", contextInfo: info } }))).toEqual(info);
    expect(contextInfoOf(message({ imageMessage: { caption: "x", contextInfo: info } }))).toEqual(info);
  });

  test("none when no content type has one", () => {
    expect(contextInfoOf(message({ conversation: "plain" }))).toBeNull();
    expect(contextInfoOf(message(null))).toBeNull();
  });
});

describe("textOfContent — the quoted message", () => {
  test("its text or caption, and a document's name when it has no caption", () => {
    expect(textOfContent({ conversation: "earlier" })).toBe("earlier");
    expect(textOfContent({ imageMessage: { caption: "that photo" } })).toBe("that photo");
    expect(textOfContent({ documentMessage: { fileName: "invoice.pdf" } })).toBe("[document: invoice.pdf]");
    expect(textOfContent({ documentMessage: { caption: "see this", fileName: "invoice.pdf" } })).toBe("see this");
  });

  test("not an object is no text", () => {
    expect(textOfContent(null)).toBe("");
    expect(textOfContent("text")).toBe("");
  });
});

describe("mediaKind", () => {
  test("each kind, with the type it says or the one it is assumed to be", () => {
    expect(mediaKind(message({ imageMessage: { mimetype: "image/png" } }))).toEqual({ kind: "image", mimeType: "image/png" });
    expect(mediaKind(message({ imageMessage: {} }))).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(mediaKind(message({ videoMessage: {} }))).toEqual({ kind: "video", mimeType: "video/mp4" });
    expect(mediaKind(message({ audioMessage: {} }))).toEqual({ kind: "audio", mimeType: "audio/ogg" });
    expect(mediaKind(message({ documentMessage: { mimetype: "application/pdf" } }))).toEqual({ kind: "file", mimeType: "application/pdf" });
    expect(mediaKind(message({ documentMessage: {} }))).toEqual({ kind: "file", mimeType: "application/octet-stream" });
  });

  test("text is not media", () => {
    expect(mediaKind(message({ conversation: "hi" }))).toBeNull();
    expect(mediaKind(message(null))).toBeNull();
  });

  test("a document keeps the name it was sent with — the agent is told `laporan.xlsx`, not `01-file.bin`", () => {
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(mediaKind(message({ documentMessage: { mimetype: xlsx, fileName: "Sampel KK 1.1.xlsx" } }))).toEqual({ kind: "file", mimeType: xlsx, fileName: "Sampel KK 1.1.xlsx" });
    // A name is a name, not a path.
    expect(mediaKind(message({ documentMessage: { mimetype: "application/pdf", fileName: "../../etc/passwd" } }))?.fileName).toBe("passwd");
    // Saved under the name's extension when its type is not one we map, and never anything but letters and digits.
    expect(extensionFor(xlsx, "Sampel KK 1.1.xlsx")).toBe("xlsx");
    expect(extensionFor(xlsx, "weird.x/../y")).toBe("bin");
    expect(extensionFor("application/pdf", "scan.PDF")).toBe("pdf");
  });

  test("a saved file's extension follows its type, and an unknown type is bin", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("audio/ogg")).toBe("ogg");
    expect(extensionFor("application/x-unknown")).toBe("bin");
  });
});

describe("incoming — which messages the engine is told about", () => {
  test("one with text, and one with only media", () => {
    expect(incoming(message({ conversation: "hi" }))).toEqual({ chatId: DM, text: "hi", media: null });
    expect(incoming(message({ audioMessage: { mimetype: "audio/ogg" } }))).toEqual({
      chatId: DM,
      text: "",
      media: { kind: "audio", mimeType: "audio/ogg" },
    });
  });

  test("not our own, not a status broadcast, not one with nothing to say", () => {
    expect(incoming(message({ conversation: "echo" }, { fromMe: true }))).toBeNull();
    expect(incoming(message({ conversation: "story" }, { remoteJid: "status@broadcast" }))).toBeNull();
    expect(incoming(message({ conversation: "   " }))).toBeNull();
    expect(incoming(message(null))).toBeNull();
    expect(incoming(message({ conversation: "hi" }, { remoteJid: undefined }))).toBeNull();
  });
});

/**
 * A file sent with a caption arrives wrapped: `documentWithCaptionMessage.message.documentMessage`, not
 * `documentMessage`. Read at the top level it had no text and no media, so `incoming` dropped it without a word —
 * a person had to send the file and then the message (2026-10-23). A disappearing chat wraps every message the same
 * way (`ephemeralMessage`), and a view-once one in `viewOnceMessage`.
 */
describe("a wrapped message — a captioned file, a disappearing chat", () => {
  const captioned = (caption: string, extra: Record<string, unknown> = {}) => ({
    documentWithCaptionMessage: {
      message: { documentMessage: { caption, fileName: "laporan.pdf", mimetype: "application/pdf", ...extra } },
    },
  });

  test("a file sent with a caption is let through, with its caption and as a file", () => {
    const found = incoming(message(captioned("tolong cek file ini")));
    expect(found).toEqual({ chatId: DM, text: "tolong cek file ini", media: { kind: "file", mimeType: "application/pdf", fileName: "laporan.pdf" } });
  });

  test("in a group, the tag on a captioned file is seen", () => {
    const tagged = message(captioned("@nouva cek ini", { contextInfo: { mentionedJid: ["999@lid"] } }), { remoteJid: GROUP, participant: MEMBER });
    expect(contextInfoOf(tagged)?.mentionedJid).toEqual(["999@lid"]);
    const found = incoming(tagged)!;
    expect(messageEvent(tagged, found, ["999@lid"]).mentions).toEqual(["999@lid"]);
  });

  test("a disappearing chat's text and a view-once photo are let through", () => {
    expect(incoming(message({ ephemeralMessage: { message: { conversation: "halo" } } }))?.text).toBe("halo");
    expect(mediaKind(message({ viewOnceMessage: { message: { imageMessage: { mimetype: "image/jpeg", caption: "lihat" } } } }))).toEqual({ kind: "image", mimeType: "image/jpeg" });
  });

  test("a captioned file quoted by a reply says its caption", () => {
    expect(textOfContent(captioned("ini kontraknya"))).toBe("ini kontraknya");
  });
});

describe("selfIdsOf", () => {
  test("both of our addresses, without the device suffix", () => {
    expect(selfIdsOf({ id: "628999999999:12@s.whatsapp.net", lid: "100000000000009:12@lid" })).toEqual([
      "628999999999@s.whatsapp.net",
      "100000000000009@lid",
    ]);
    expect(selfIdsOf(undefined)).toEqual([]);
  });
});

describe("messageEvent", () => {
  test("a DM: the chat is the sender, and nothing optional is invented", () => {
    const m = message({ conversation: "hi" });
    expect(messageEvent(m, incoming(m)!, [])).toEqual({
      type: "message",
      id: "MSG1",
      chatId: DM,
      chatType: "dm",
      senderId: DM,
      senderName: "Mira",
      text: "hi",
      timestamp: 1_760_000_000_000,
    });
  });

  test("a group: the sender is the participant, with the tag, the quote and who wrote it", () => {
    const m = message(
      {
        extendedTextMessage: {
          text: "@bot what about this?",
          contextInfo: {
            mentionedJid: ["100000000000009@lid", null],
            stanzaId: "Q1",
            participant: "100000000000002@lid",
            quotedMessage: { conversation: "the plan for friday" },
          },
        },
      },
      { remoteJid: GROUP, participant: MEMBER },
    );
    const event = messageEvent(m, incoming(m)!, ["100000000000009@lid"]);
    expect(event).toMatchObject({
      chatId: GROUP,
      chatType: "group",
      senderId: MEMBER,
      replyTo: "Q1",
      mentions: ["100000000000009@lid"],
      quotedText: "the plan for friday",
      quotedSender: "100000000000002@lid",
      selfIds: ["100000000000009@lid"],
    });
  });

  test("the media saved for it travels with it", () => {
    const m = message({ imageMessage: { caption: "look", mimetype: "image/png" } });
    const media = { path: "/media/a.png", mimeType: "image/png", kind: "image", caption: "look" };
    expect(messageEvent(m, incoming(m)!, [], media).media).toEqual(media);
  });
});

/**
 * A person's edit, as WhatsApp sends it: a protocol message — wrapped in `editedMessage` — naming the message it
 * changes, with what that message says now. `incoming` says nothing about one (it has no text of its own); this does.
 */
describe("incomingEdit and editEvent — an edit", () => {
  const EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
  const edit = (now: Record<string, unknown>, over: { type?: number; of?: string | null } = {}) => ({
    editedMessage: {
      message: { protocolMessage: { type: over.type ?? EDIT, key: { remoteJid: GROUP, id: over.of === undefined ? "ORIG1" : over.of }, editedMessage: now } },
    },
  });

  test("is found, with the message it changes and what that says now — read for tags and quotes like any message", () => {
    const m = message(edit({ extendedTextMessage: { text: "@bot lunch at 1?", contextInfo: { mentionedJid: [MEMBER] } } }), { remoteJid: GROUP, id: "EDIT1", participant: "100000000000002@lid" }, { messageTimestamp: 1_760_000_090 });
    const found = incomingEdit(m);
    expect(found).toMatchObject({ chatId: GROUP, text: "@bot lunch at 1?", media: null, of: "ORIG1" });
    expect(editEvent(m, found!, [MEMBER])).toEqual({
      type: "message",
      id: "EDIT1",
      chatId: GROUP,
      chatType: "group",
      senderId: "100000000000002@lid",
      senderName: "Mira",
      text: "@bot lunch at 1?",
      timestamp: 1_760_000_090_000,
      mentions: [MEMBER],
      selfIds: [MEMBER],
      edits: "ORIG1",
    });
  });

  test("a plain text edit, unwrapped, is one too", () => {
    const m = message({ protocolMessage: { type: EDIT, key: { id: "ORIG2" }, editedMessage: { conversation: "fixed" } } });
    expect(incomingEdit(m)).toMatchObject({ chatId: DM, text: "fixed", of: "ORIG2" });
  });

  test("not our own, not another protocol message, not one naming no message, and not one left with no words", () => {
    expect(incomingEdit(message(edit({ conversation: "x" }), { fromMe: true }))).toBeNull();
    expect(incomingEdit(message(edit({ conversation: "x" }, { type: proto.Message.ProtocolMessage.Type.REVOKE })))).toBeNull();
    expect(incomingEdit(message(edit({ conversation: "x" }, { of: null })))).toBeNull();
    expect(incomingEdit(message(edit({ conversation: "   " })))).toBeNull();
    expect(incomingEdit(message(edit({ conversation: "x" }), { remoteJid: "status@broadcast" }))).toBeNull();
    // An ordinary message is not an edit — and an edit is not an ordinary message.
    expect(incomingEdit(message({ conversation: "hello" }))).toBeNull();
    expect(incoming(message(edit({ conversation: "x" })))).toBeNull();
  });
});

describe("splitMessage", () => {
  test("short text is one piece, untouched", () => {
    expect(splitMessage("  hi  ")).toEqual(["  hi  "]);
  });

  test("each piece fits, cut at the last whitespace past the middle, and nothing is lost but the cut", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const pieces = splitMessage(words, 100);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(100);
    expect(pieces.join(" ")).toBe(words);
  });

  test("a paragraph break past the middle is where it cuts", () => {
    const text = `${"a".repeat(70)}\n\n${"b".repeat(50)}`;
    expect(splitMessage(text, 100)).toEqual(["a".repeat(70), "b".repeat(50)]);
  });

  test("no whitespace past the middle: cut at the limit", () => {
    const text = `${"a".repeat(10)} ${"b".repeat(150)}`;
    expect(splitMessage(text, 100)).toEqual([text.slice(0, 100), text.slice(100)]);
  });
});
