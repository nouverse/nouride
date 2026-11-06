/**
 * Reading attachment metadata off a Discord message.
 *
 * See the note in `channels/telegram/attachments.ts`: this was the third concern in the shared
 * module, and it belongs beside the adapter that is its only caller.
 */

import type { Attachment } from "@nouride/shared";
import { attachmentTypeFor } from "../../commons/attachments.ts";

/** Discord's attachment shape, narrowed to what we read. */
export interface DiscordAttachmentLike {
  url?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  duration?: number | null;
}

export function discordAttachments(attachments: readonly DiscordAttachmentLike[]): Attachment[] {
  return attachments.map((attachment) => {
    const mimeType = attachment.contentType ?? "application/octet-stream";
    return {
      type: attachmentTypeFor(mimeType),
      ...(attachment.url ? { url: attachment.url } : {}),
      mimeType,
      ...(attachment.name ? { filename: attachment.name } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      ...(attachment.duration !== null && attachment.duration !== undefined
        ? { duration: attachment.duration }
        : {}),
    };
  });
}
