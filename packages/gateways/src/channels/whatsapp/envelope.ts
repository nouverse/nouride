/**
 * What a WhatsApp message from the bridge becomes before the engine sees it — `MessageEnvelope` — an edit of one
 * included. Out of the adapter's file, which speaks the bridge's protocol: this is a decision about one event.
 */

import { createLogger, type BridgeEvent, type MessageEnvelope } from "@nouride/shared";

const log = createLogger("gateway.whatsapp");

/** This connection: its instance id, and the agent it belongs to — WhatsApp tags a number, and this says whose. */
export interface WhatsAppSelf {
  gatewayId: string;
  agentId?: string | undefined;
}

export function whatsappEnvelope(event: Extract<BridgeEvent, { type: "message" }>, self: WhatsAppSelf): MessageEnvelope | null {
  const text = event.text ?? "";
  const hasMedia = Boolean(event.media);
  // Text OR media. A photo with no caption is a real message someone sent.
  if (!text.trim() && !hasMedia) return null;

  /**
   * A tag aimed at this account becomes a mention the router understands.
   *
   * WhatsApp has no `@agentname` — it tags a *number*, and it addresses the same account by phone
   * JID in one conversation and by LID in another. So the raw ids are compared against both of our
   * own, and a hit is reported as a mention of the agent that owns this connection. Without this a
   * group tag is invisible: the message arrives looking exactly like everyone else's chatter.
   */
  const selfIds = new Set((event.selfIds ?? []).map(normalizeJid));
  const taggedUs = (event.mentions ?? []).some((id) => selfIds.has(normalizeJid(id)));
  // The quoted message's author, by the same two addresses (`MessageEnvelope.repliesToSelf`).
  const repliedToUs = Boolean(event.quotedSender && selfIds.has(normalizeJid(event.quotedSender)));

  /**
   * The quoted message, as context rather than as text of its own.
   *
   * "@bot what about this?" means nothing without the message it points at, and in a group that is
   * the usual shape of being asked something.
   *
   * Carried as its own field rather than prepended to the body. Prepending is what this did first,
   * and it silently broke every slash command sent as a reply — see `MessageEnvelope.quotedText`.
   * The pipeline composes it into what the model sees, after routing and command parsing.
   */
  const quoted = event.quotedText?.trim();

  return {
    id: event.id,
    timestamp: event.timestamp,
    gateway: "whatsapp",
    gatewayId: self.gatewayId,
    chatId: event.chatId,
    chatType: event.chatType,
    senderId: event.senderId,
    senderName: event.senderName || "unknown",
    text,
    ...(quoted ? { quotedText: quoted } : {}),
    ...(event.quotedSender ? { quotedSender: event.quotedSender } : {}),
    ...(taggedUs && self.agentId ? { mentions: [self.agentId] } : {}),
    ...(event.replyTo ? { replyTo: event.replyTo } : {}),
    ...(event.replyTo && repliedToUs ? { repliesToSelf: true } : {}),
    ...(event.media
      ? {
          attachments: [
            {
              type: attachmentKind(event.media.kind, event.media.mimeType),
              // Already a local path: the bridge downloads media itself, because the engine has no
              // WhatsApp session to fetch it with.
              url: event.media.path,
              mimeType: event.media.mimeType,
              ...(event.media.caption ? { caption: event.media.caption } : {}),
              // The name it was sent with, as Telegram's documents carry theirs.
              ...(event.media.fileName ? { filename: event.media.fileName } : {}),
            },
          ],
        }
      : {}),
    // A person's edit of a message they sent: its id and time are the edit's, `edit.of` the message it changes.
    // WhatsApp allows one for fifteen minutes and does not say when the message was sent; the engine's inbox does.
    ...(event.edits ? { edit: { of: event.edits } } : {}),
    // Nothing platform-specific survives the bridge — the protocol IS the normalisation — so the
    // event itself is the most faithful "original payload" there is.
    raw: event,
  };
}

/** `628…:5@s.whatsapp.net` and `628…@s.whatsapp.net` are the same account on different devices. */
function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, "@").trim();
}

/**
 * The bridge's word for what a file is, mapped onto ours.
 *
 * Falls back to the MIME type rather than trusting the label, and then to `file` — an unrecognised
 * kind is a document, not a reason to drop the attachment.
 */
function attachmentKind(kind: string, mimeType: string): "image" | "video" | "audio" | "file" {
  if (kind === "image" || kind === "video" || kind === "audio") return kind;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  log.debug("unrecognised media kind from the bridge", { kind, mimeType });
  return "file";
}
