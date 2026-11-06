/**
 * Reading attachment metadata off a Telegram message.
 *
 * Split out of the shared `commons/attachments.ts` when the package grew a folder per channel: that
 * file held three things — what every channel shares, Telegram's shape, and Discord's — and the two
 * platform halves were only ever imported by their own adapter.
 */

import type { Attachment } from "@nouride/shared";
import { attachmentTypeFor } from "../../commons/attachments.ts";

/**
 * Telegram's message shape, narrowed to the fields we read.
 *
 * Declared locally rather than imported from grammy so this module stays testable without a bot,
 * and so the adapter remains the only thing depending on the library's types.
 */
export interface TelegramMediaMessage {
  photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; duration?: number; mime_type?: string; file_size?: number };
  audio?: {
    file_id: string;
    duration?: number;
    mime_type?: string;
    file_size?: number;
    file_name?: string;
  };
  video?: { file_id: string; duration?: number; mime_type?: string; file_size?: number };
  /** The round video a person records in the app. Always MP4, and always them talking. */
  video_note?: { file_id: string; duration?: number; file_size?: number };
  sticker?: { file_id: string; file_size?: number; emoji?: string };
  animation?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  /** Present on a forwarded message. Only its presence is read. */
  forward_origin?: unknown;
}

/**
 * Attachment metadata from a Telegram message.
 *
 * `url` carries the **file_id**, not a URL: Telegram links are short-lived and need a second API
 * call to mint, so resolving one here would mean a network round-trip on every inbound message for
 * bytes nothing reads yet. The id is the durable handle a downloader will need.
 */
export function telegramAttachments(message: TelegramMediaMessage): Attachment[] {
  const found: Attachment[] = [];

  // Telegram sends the same photo at several resolutions; the last entry is the largest.
  const photo = message.photo?.[message.photo.length - 1];
  if (photo) {
    found.push({
      type: "image",
      url: photo.file_id,
      mimeType: "image/jpeg",
      ...(photo.file_size !== undefined ? { size: photo.file_size } : {}),
      ...(photo.width && photo.height
        ? { filename: `photo_${photo.width}x${photo.height}.jpg` }
        : {}),
    });
  }

  /**
   * A file sent as a file is still what its type says. Typed `file` whatever it held, a screenshot sent uncompressed
   * from Telegram Desktop reached the agent as a document to open with its tools, never as a picture in front of the
   * model (2026-10-27) — the other channels type theirs by MIME already. An animation carries `document` too, for
   * older clients: the same file, read once, below.
   */
  if (message.document && !message.animation) {
    found.push({
      type: attachmentTypeFor(message.document.mime_type ?? "application/octet-stream"),
      url: message.document.file_id,
      mimeType: message.document.mime_type ?? "application/octet-stream",
      ...(message.document.file_name ? { filename: message.document.file_name } : {}),
      ...(message.document.file_size !== undefined ? { size: message.document.file_size } : {}),
    });
  }

  if (message.voice) {
    found.push({
      type: "voice",
      url: message.voice.file_id,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      ...(message.voice.duration !== undefined ? { duration: message.voice.duration } : {}),
      ...(message.voice.file_size !== undefined ? { size: message.voice.file_size } : {}),
      // A voice note somebody else recorded is not the sender speaking — see `Attachment.forwarded`.
      ...(message.forward_origin !== undefined ? { forwarded: true } : {}),
    });
  }

  if (message.audio) {
    found.push({
      type: "audio",
      url: message.audio.file_id,
      mimeType: message.audio.mime_type ?? "audio/mpeg",
      ...(message.audio.file_name ? { filename: message.audio.file_name } : {}),
      ...(message.audio.duration !== undefined ? { duration: message.audio.duration } : {}),
      ...(message.audio.file_size !== undefined ? { size: message.audio.file_size } : {}),
    });
  }

  if (message.video) {
    found.push({
      type: "video",
      url: message.video.file_id,
      mimeType: message.video.mime_type ?? "video/mp4",
      ...(message.video.duration !== undefined ? { duration: message.video.duration } : {}),
      ...(message.video.file_size !== undefined ? { size: message.video.file_size } : {}),
    });
  }

  /**
   * Read, and it was not. A video note carries no `video` field, so a message that was nothing but
   * one reached the agent with no attachment at all — somebody talked to the camera and the bot
   * answered as though they had said nothing.
   */
  if (message.video_note) {
    found.push({
      type: "video",
      url: message.video_note.file_id,
      mimeType: "video/mp4",
      filename: "video_note.mp4",
      recordedBySender: true,
      ...(message.video_note.duration !== undefined ? { duration: message.video_note.duration } : {}),
      ...(message.video_note.file_size !== undefined ? { size: message.video_note.file_size } : {}),
      ...(message.forward_origin !== undefined ? { forwarded: true } : {}),
    });
  }

  if (message.animation) {
    found.push({
      type: "video",
      url: message.animation.file_id,
      mimeType: message.animation.mime_type ?? "video/mp4",
      ...(message.animation.file_name ? { filename: message.animation.file_name } : {}),
      ...(message.animation.file_size !== undefined ? { size: message.animation.file_size } : {}),
    });
  }

  // Stickers are images, and it matters: a sticker-only message is a real message a person sent,
  // and dropping it makes the bot look like it ignored them.
  if (message.sticker) {
    found.push({
      type: "image",
      url: message.sticker.file_id,
      mimeType: "image/webp",
      filename: message.sticker.emoji ? `sticker_${message.sticker.emoji}.webp` : "sticker.webp",
      ...(message.sticker.file_size !== undefined ? { size: message.sticker.file_size } : {}),
    });
  }

  return found;
}
