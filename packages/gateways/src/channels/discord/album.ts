/**
 * Several files as one Discord message: what goes together, and the sending of it.
 *
 * A message's files are sent this way only when the message says they are one set (`OutboundMessage.together`):
 * otherwise each file is a message of its own, which keeps each one replyable. Discord shows the files of one
 * message as a grid.
 */

import type { Attachment } from "@nouride/shared";

/** How many files Discord takes in one message. */
const FILES_A_MESSAGE = 10;

/** How many files, from the first, go as one Discord message: two to ten that have their bytes and are no voice note, which is a message type of its own. */
export function discordAlbumRun(left: readonly Attachment[]): number {
  let run = 0;
  while (run < left.length && run < FILES_A_MESSAGE && left[run]!.buffer && left[run]!.type !== "voice") run++;
  return run >= 2 ? run : 0;
}

/** The one message a set is: every file, and the caption of the first as its words. */
export function discordAlbumMessage(files: readonly Attachment[], captionMax: number): { content?: string; files: { attachment: Buffer; name: string }[]; allowedMentions: { parse: "users"[]; repliedUser: boolean } } {
  return {
    ...(files[0]?.caption ? { content: files[0].caption.slice(0, captionMax) } : {}),
    files: files.map((file) => ({ attachment: Buffer.from(file.buffer!), name: file.filename ?? "file" })),
    allowedMentions: { parse: ["users"], repliedUser: true },
  };
}
