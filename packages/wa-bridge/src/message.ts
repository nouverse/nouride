/**
 * What a WhatsApp message says, read off Baileys' message object with no socket in sight.
 *
 * How an incoming message becomes text, a quote, mentions and media decides what the agent is told, and it used to sit
 * inside the code that holds the connection, where nothing could reach it without a live WhatsApp session. Here it is
 * plain functions of the message: `connection.ts` forwards what arrives through `incoming` and `messageEvent`, and
 * `handler.ts` splits a long reply with `splitMessage`.
 */

import { isJidGroup, normalizeMessageContent, proto, type WAMessage } from "@whiskeysockets/baileys";
import type { BridgeEvent } from "./protocol.ts";

type MessageEvent = Extract<BridgeEvent, { type: "message" }>;

/** WhatsApp refuses anything longer, and a reply from a model routinely exceeds it. */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * A reply cut into pieces WhatsApp will take.
 *
 * Each cut is at the last whitespace in the window — a paragraph break, a line break or a space, whichever comes last —
 * as long as that is past the window's middle; cutting mid-word is the last resort. The pieces are trimmed where they
 * were cut.
 */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const boundary = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = boundary > max * 0.5 ? boundary : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * What a message carries, under WhatsApp's wrappers.
 *
 * A file sent with a caption is `documentWithCaptionMessage.message.documentMessage`, a disappearing chat wraps every
 * message in `ephemeralMessage`, a view-once one in `viewOnceMessage`. Read at the top level, a captioned file had no
 * text and no media, and `incoming` dropped it without a word: a person had to send the file and then the message.
 */
function contentOf(message: WAMessage): proto.IMessage | undefined {
  return normalizeMessageContent(message.message);
}

export function textOf(message: WAMessage): string {
  const content = contentOf(message);
  if (!content) return "";
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ""
  );
}

/**
 * `contextInfo`, wherever it happens to live.
 *
 * It is attached to the content type rather than to the message, so a fixed path finds it for plain
 * text and misses it on an image with a caption — which is the case where a group tag matters most.
 */
export function contextInfoOf(message: WAMessage): {
  mentionedJid?: (string | null)[] | null;
  stanzaId?: string | null;
  participant?: string | null;
  quotedMessage?: unknown;
} | null {
  const content = contentOf(message);
  if (!content) return null;
  for (const value of Object.values(content)) {
    if (value && typeof value === "object" && "contextInfo" in value) {
      const info = (value as { contextInfo?: unknown }).contextInfo;
      if (info && typeof info === "object") return info as ReturnType<typeof contextInfoOf>;
    }
  }
  return null;
}

/** The readable text of any message content — used for the quoted message a tag refers to. */
export function textOfContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  // A quoted message can be a captioned file too.
  const c = normalizeMessageContent(content as proto.IMessage) as Record<string, { text?: string; caption?: string; fileName?: string }> & {
    conversation?: string;
  };
  return (
    c.conversation ??
    c.extendedTextMessage?.text ??
    c.imageMessage?.caption ??
    c.videoMessage?.caption ??
    c.documentMessage?.caption ??
    // A document with no caption still says something: its name is the only text there is.
    (c.documentMessage?.fileName ? `[document: ${c.documentMessage.fileName}]` : "")
  );
}

/** A document's name as it was sent: the last part of it, so a name is never a path. */
function documentName(name: string | null | undefined): string | undefined {
  const base = name?.split(/[\\/]/).pop()?.trim();
  return base ? base : undefined;
}

export function mediaKind(message: WAMessage): { kind: string; mimeType: string; fileName?: string } | null {
  const content = contentOf(message);
  if (!content) return null;
  if (content.imageMessage) {
    return { kind: "image", mimeType: content.imageMessage.mimetype ?? "image/jpeg" };
  }
  if (content.videoMessage) {
    return { kind: "video", mimeType: content.videoMessage.mimetype ?? "video/mp4" };
  }
  if (content.audioMessage) {
    return { kind: "audio", mimeType: content.audioMessage.mimetype ?? "audio/ogg" };
  }
  if (content.documentMessage) {
    // Its name, too: the agent was told `01-file.bin` for a spreadsheet it had been asked to check.
    const fileName = documentName(content.documentMessage.fileName);
    return {
      kind: "file",
      mimeType: content.documentMessage.mimetype ?? "application/octet-stream",
      ...(fileName ? { fileName } : {}),
    };
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
};

/**
 * The extension a downloaded file is saved under: its type's, else its name's — a spreadsheet or a Word file has a type
 * not listed here, and saved as `.bin` it was a binary nobody could open — else `bin`. Letters and digits only.
 */
export function extensionFor(mimeType: string, fileName?: string): string {
  const named = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return EXTENSIONS[mimeType] ?? named ?? "bin";
}

/** A message `incoming` let through: the chat it came from, its text, and the media it carries, if any. */
export interface Incoming {
  chatId: string;
  text: string;
  media: { kind: string; mimeType: string; fileName?: string } | null;
}

/**
 * The message, if it is one the engine is told about.
 *
 * Not one of our own: they come back on the same event, and answering them is how loops start. Not a status
 * broadcast. And not one with nothing to say — no text and no media.
 */
export function incoming(message: WAMessage): Incoming | null {
  if (message.key.fromMe) return null;
  const chatId = message.key.remoteJid;
  if (!chatId || chatId === "status@broadcast") return null;
  const text = textOf(message);
  const media = mediaKind(message);
  if (!text.trim() && !media) return null;
  return { chatId, text, media };
}

/** An edit `incomingEdit` let through: where, what the message says now, the message it changes, and its content. */
export interface IncomingEdit extends Incoming {
  of: string;
  content: proto.IMessage;
}

/**
 * A person's edit of a message they sent, as WhatsApp sends one: a protocol message naming the message it changes, with
 * what that message says now (G11). Not one of our own — the account's own edits, from its phone — not a status
 * broadcast, and not one that leaves no words: an edit is words. Baileys reports the same edit again as an update to
 * the message; the bridge forwards it once, from here.
 */
export function incomingEdit(message: WAMessage): IncomingEdit | null {
  if (message.key.fromMe) return null;
  const chatId = message.key.remoteJid;
  if (!chatId || chatId === "status@broadcast") return null;
  const protocol = normalizeMessageContent(message.message)?.protocolMessage;
  if (protocol?.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) return null;
  const of = protocol.key?.id;
  const content = normalizeMessageContent(protocol.editedMessage);
  const text = textOfContent(content);
  if (!of || !content || !text.trim()) return null;
  return { chatId, text, media: null, of, content };
}

/**
 * The `message` event for an edit `incomingEdit` let through: read, like any message, off what it says now — who it tags,
 * what it quotes — with `edits` naming the message it changes. Its id and time are the edit's.
 */
export function editEvent(message: WAMessage, found: IncomingEdit, selfIds: string[]): MessageEvent {
  return { ...messageEvent({ ...message, message: found.content }, found, selfIds), edits: found.of };
}

/**
 * Both of our own addresses, without the device suffix.
 *
 * WhatsApp addresses the same account by phone JID and by LID depending on the conversation, and a mention check that
 * knows only one of them misses half the tags.
 */
export function selfIdsOf(user: { id?: string; lid?: string } | undefined): string[] {
  return [user?.id, user?.lid]
    .filter((id): id is string => Boolean(id))
    .map((id) => id.replace(/:\d+@/, "@"));
}

/** The `message` event for what `incoming` let through, with our own addresses and the media saved for it, if any. */
export function messageEvent(
  message: WAMessage,
  found: Incoming,
  selfIds: string[],
  media?: MessageEvent["media"],
): MessageEvent {
  const group = isJidGroup(found.chatId) ?? false;
  // In a group the sender is `participant`; in a DM the chat *is* the sender. Getting this wrong
  // makes every member of a group share one identity, which is the thing the people table exists to
  // tell apart.
  const senderId = (group ? message.key.participant : found.chatId) ?? found.chatId;

  /**
   * Who was addressed, and what they were addressing.
   *
   * `contextInfo` hangs off whichever content type the message happens to be, so it is searched for
   * rather than read from a fixed path. Both matter in a group: `mentionedJid` is how "answer only
   * when tagged" is decided at all, and the quoted text is the context a tag usually refers to —
   * "@bot what about this?" is meaningless without the message it points at.
   */
  const context = contextInfoOf(message);
  const mentions = (context?.mentionedJid ?? []).filter(Boolean) as string[];
  const quotedText = textOfContent(context?.quotedMessage ?? null);

  return {
    type: "message",
    id: message.key.id ?? crypto.randomUUID(),
    chatId: found.chatId,
    chatType: group ? "group" : "dm",
    senderId,
    senderName: message.pushName ?? "unknown",
    text: found.text,
    timestamp: Number(message.messageTimestamp ?? 0) * 1000,
    ...(context?.stanzaId ? { replyTo: context.stanzaId } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(quotedText ? { quotedText } : {}),
    ...(context?.participant ? { quotedSender: context.participant } : {}),
    ...(selfIds.length > 0 ? { selfIds } : {}),
    ...(media ? { media } : {}),
  };
}
