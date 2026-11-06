/**
 * An attachment's download, opened and handed on unread (G9).
 *
 * Telegram and Discord both end in a plain GET for the file. What to do with the body — how big is too big,
 * where it goes, how long it may take — is the engine's (`attachments/store.ts`), one policy for every
 * platform. So this reads only the head: the status, and the length the server declared. The body goes back
 * as it is, and the caller's deadline with it: the signal that bounded the request bounds every chunk still
 * to come.
 *
 * It used to be `arrayBuffer()`, which holds the whole file before anything can look at its size — and a
 * platform that sends no size, or a wrong one, let a 400 MB file into the heap of a 512 MB box before the
 * store's check after the fact refused it.
 */

import type { AttachmentStream } from "@nouride/shared";

/** The download, or the status that said there is none. */
export async function openDownload(url: string, signal?: AbortSignal): Promise<AttachmentStream | { status: number }> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok || !response.body) {
    // Let go of rather than left unread: an unread body holds its connection until it is collected.
    await response.body?.cancel().catch(() => {});
    return { status: response.status };
  }
  const length = response.headers.get("content-length");
  return { declaredBytes: length !== null && /^\d+$/.test(length.trim()) ? Number(length) : null, body: response.body };
}
