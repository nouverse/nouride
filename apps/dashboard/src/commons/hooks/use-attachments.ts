/**
 * Files waiting to be sent with the next message.
 *
 * Upload happens on pick, not on send. A person attaches three screenshots and then spends a minute
 * writing, and doing the work in that minute is the difference between "send" being instant and "send"
 * being a progress bar — and between a file that is too large being refused now, while they can pick a
 * different one, and being refused after they have written a paragraph.
 *
 * Each entry is owned here from pick to clear, including the object URL behind an image preview: a
 * `createObjectURL` that is never revoked is a leak that lasts as long as the tab, and the only place
 * that knows when a preview stops being needed is the thing holding the list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/commons/lib/api";
import type { UploadedFile } from "@nouride/wire";
import type { AttachedFile } from "@/commons/components/ui/FileDrop";

/** What the caller sends with the message. */
export interface ReadyAttachment {
  path: string;
  mimeType: string;
  filename: string;
}

interface Entry extends AttachedFile {
  stored?: UploadedFile;
}

export interface Attachments {
  /** For the tray. */
  files: AttachedFile[];
  /** Uploaded and ready to travel with a message. */
  ready: ReadyAttachment[];
  /** Something is still on its way up — the send waits for this. */
  uploading: boolean;
  add: (files: File[]) => void;
  remove: (id: string) => void;
  /** After a successful send. Revokes the previews. */
  clear: () => void;
}

export function useAttachments(): Attachments {
  const [entries, setEntries] = useState<Entry[]>([]);
  /** Every object URL handed out, so unmount can revoke them even if nothing else did. */
  const urls = useRef(new Set<string>());

  const forget = useCallback((url: string | undefined) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  }, []);

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  const add = useCallback((picked: File[]) => {
    if (picked.length === 0) return;

    const fresh: Entry[] = picked.map((file) => {
      // Only images get a preview. An object URL for a 40MB video costs nothing to make and shows
      // nothing useful.
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (previewUrl) urls.current.add(previewUrl);
      return {
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes: file.size,
        ...(previewUrl ? { previewUrl } : {}),
        status: "uploading" as const,
      };
    });

    setEntries((previous) => [...previous, ...fresh]);

    /**
     * One request for the batch, and the results matched back by position.
     *
     * The daemon answers in the order it was given, which is what makes this safe — and a per-file
     * request would multiply the round trips for the common case of dropping a handful of screenshots.
     */
    void api
      .chatUpload(picked)
      .then((result) => {
        setEntries((previous) =>
          previous.map((entry) => {
            const index = fresh.findIndex((candidate) => candidate.id === entry.id);
            const stored = index >= 0 ? result.files[index] : undefined;
            return stored ? { ...entry, status: "ready" as const, stored } : entry;
          }),
        );
      })
      .catch((err: unknown) => {
        // The daemon's own sentence when it has one — "shot.png is 30MB, the limit is 20MB" is written
        // for the person looking at the tray, and replacing it with "upload failed" throws away the
        // only useful half.
        const message =
          err instanceof ApiError ? err.message : "could not be uploaded";
        setEntries((previous) =>
          previous.map((entry) =>
            fresh.some((candidate) => candidate.id === entry.id)
              ? { ...entry, status: "error" as const, error: message }
              : entry,
          ),
        );
      });
  }, []);

  const remove = useCallback(
    (id: string) => {
      setEntries((previous) => {
        const target = previous.find((entry) => entry.id === id);
        forget(target?.previewUrl);
        return previous.filter((entry) => entry.id !== id);
      });
    },
    [forget],
  );

  const clear = useCallback(() => {
    setEntries((previous) => {
      for (const entry of previous) forget(entry.previewUrl);
      return [];
    });
  }, [forget]);

  return {
    files: entries,
    ready: entries.flatMap((entry) =>
      entry.stored
        ? [{ path: entry.stored.path, mimeType: entry.stored.mimeType, filename: entry.stored.name }]
        : [],
    ),
    uploading: entries.some((entry) => entry.status === "uploading"),
    add,
    remove,
    clear,
  };
}
