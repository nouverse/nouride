/**
 * A file a WhatsApp message carried, as the daemon fetches it for a turn.
 *
 * Its bridge holds it, named by a ref (`HELD_MEDIA`), until the daemon asks: then the bridge downloads it into this
 * number's own folder and says where, and it is read and removed there, since the daemon keeps its own copy. Held so
 * that a sender the daemon turns away (blocked, past their messages, a group's chatter) costs no download and no disk.
 * A url of another kind, a local path or a link, is read as it is.
 */

import { readBytesSync, removePath } from "@nouride/runtime";
import type { Attachment, Logger } from "@nouride/shared";
import { HELD_MEDIA } from "./envelope.ts";

/** `ask` is the bridge's `fetch_media`: the path the held file was saved to. */
export async function fetchWhatsAppFile(attachment: Attachment, ask: (ref: string) => Promise<string>, log: Logger): Promise<Uint8Array | null> {
  if (attachment.buffer) return attachment.buffer;
  if (!attachment.url) return null;
  try {
    if (attachment.url.startsWith(HELD_MEDIA)) {
      const path = await ask(attachment.url.slice(HELD_MEDIA.length));
      try {
        return readBytesSync(path);
      } finally {
        removePath(path);
      }
    }
    const url = /^(https?|file):\/\//.test(attachment.url) ? attachment.url : `file://${attachment.url}`;
    const response = await fetch(url);
    if (!response.ok) {
      log.warn("whatsapp attachment download failed", { status: response.status, url });
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    log.warn("whatsapp attachment fetch failed", { url: attachment.url, err: String(err) });
    return null;
  }
}
