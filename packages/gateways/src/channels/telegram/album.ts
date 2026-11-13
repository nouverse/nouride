/**
 * Several files as one Telegram album: what goes together, and the sending of it.
 *
 * Apart from the gateway because it is one thing with one rule of Telegram's own: an album is two to ten files of one
 * family. A message's files are sent this way only when the message says they are one set
 * (`OutboundMessage.together`); `deliverInParts` asks `telegramAlbumRun` how many of what is left go as one.
 */

import { GrammyError, InputFile, InputMediaBuilder, type Api } from "grammy";
import type { Attachment } from "@nouride/shared";

/** How many files Telegram shows as one album. */
const ALBUM_MAX = 10;

/**
 * How many files, from the first, Telegram takes as one album: two to ten of one family. Pictures and videos go
 * together; documents only with documents, and audio only with audio. A voice note, or a file with no bytes, goes by
 * itself, and so does a single file of its family between others.
 */
export function telegramAlbumRun(left: readonly Attachment[]): number {
  const family = (file: Attachment): string | null => (!file.buffer ? null : file.type === "image" || file.type === "video" ? "seen" : file.type === "audio" ? "audio" : file.type === "file" ? "file" : null);
  const first = left[0] ? family(left[0]) : null;
  if (!first) return 0;
  let run = 1;
  while (run < left.length && run < ALBUM_MAX && family(left[run]!) === first) run++;
  return run >= 2 ? run : 0;
}

/**
 * One album (`sendMediaGroup`), the caption of the first file under it, and the id of each message it became.
 * Telegram refuses the whole album for one picture it cannot decode, so then each file goes by itself through `one`,
 * where a picture refused as a photo goes as a document: the set arrives in order either way.
 */
export async function sendTelegramAlbum(
  files: readonly Attachment[],
  o: {
    api: Api;
    chatId: string;
    threadId: number | undefined;
    captionMax: number;
    /** A call made again after the wait Telegram names for a 429 (the gateway's own). */
    retry: <T>(call: () => Promise<T>) => Promise<T>;
    /** Whether Telegram's answer is one it will give again: a chat it will not write to, a file it will never take. */
    refused: (err: unknown) => boolean;
    /** One file sent by itself, the gateway's way; its message id, or null for one with no bytes. */
    one: (file: Attachment) => Promise<string | null>;
    log: { warn: (message: string, data?: Record<string, unknown>) => void };
  },
): Promise<string[]> {
  const media = files.map((file, index) => {
    const input = new InputFile(file.buffer!, file.filename ?? "file");
    const said = index === 0 && file.caption ? { caption: file.caption.slice(0, o.captionMax) } : {};
    if (file.type === "image") return InputMediaBuilder.photo(input, said);
    if (file.type === "video") return InputMediaBuilder.video(input, said);
    if (file.type === "audio") return InputMediaBuilder.audio(input, said);
    return InputMediaBuilder.document(input, said);
  });
  try {
    // The builder's four kinds are one union to Telegram and four to the client's types: an album is of one family.
    const sent = await o.retry<{ message_id: number }[]>(() => o.api.sendMediaGroup(o.chatId, media as Parameters<Api["sendMediaGroup"]>[1], o.threadId ? { message_thread_id: o.threadId } : {}));
    return sent.map((message) => String(message.message_id));
  } catch (err) {
    if (!(err instanceof GrammyError) || err.error_code === 429 || o.refused(err)) throw err;
    o.log.warn("telegram refused the album; sending its files one by one", { files: files.length, error: err.description });
    const ids: string[] = [];
    for (const file of files) {
      const id = await o.one(file);
      if (id) ids.push(id);
    }
    return ids;
  }
}
