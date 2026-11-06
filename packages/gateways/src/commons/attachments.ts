/**
 * Inbound attachments, by kind.
 *
 * Each adapter reads its platform's attachment shapes into `Attachment` (`channels/<platform>/attachments.ts`), so a
 * photo with no caption still reaches the agent as a message that carries something; what the files hold is the
 * engine's to fetch and describe (`AttachmentStore`, `describeStoredAttachments`).
 */

import type { AttachmentType } from "@nouride/shared";

/**
 * MIME type to our coarse categories.
 *
 * `file` is the fallback rather than a throw: an unknown type is still an attachment worth telling
 * the model about, and refusing to classify it would drop the message it arrived with.
 */
export function attachmentTypeFor(mimeType: string): AttachmentType {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}
