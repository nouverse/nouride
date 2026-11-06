/**
 * A file written a piece at a time, for output that is too big to hold and arrives in chunks.
 *
 * Synchronous on purpose. The one caller is a child process's stdout, and a synchronous write is what
 * makes memory bounded: the next chunk is not read off the pipe until this one is on disk, so a
 * command printing faster than the disk can take it is slowed down by the pipe rather than queued up
 * in the daemon's heap. An async stream would accept every chunk and buffer the difference — the
 * exact growth this exists to prevent.
 */

import { closeSync, openSync, writeSync } from "node:fs";

export interface AppendFile {
  /** Append text as UTF-8. Throws if the file is closed. */
  write(text: string): void;
  /** Close it. Safe to call twice. */
  close(): void;
}

/**
 * Create (or truncate) `path` and return a writer for it.
 *
 * The mode is applied at creation, not afterwards: a `chmod` after the first write leaves a window
 * in which the file is readable by anyone, and what goes into it is whatever a command printed.
 */
export function openAppendFile(path: string, mode = 0o600): AppendFile {
  const fd = openSync(path, "w", mode);
  const encoder = new TextEncoder();
  let open = true;
  return {
    write(text) {
      if (!open) throw new Error(`openAppendFile: ${path} is closed`);
      const bytes = encoder.encode(text);
      let offset = 0;
      // `writeSync` may write less than asked on a pipe or a full disk; a short write is not an error.
      while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
    },
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}
