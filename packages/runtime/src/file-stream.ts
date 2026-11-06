/**
 * Large files, a piece at a time: writing a download as it arrives, hashing a file without holding
 * it, and a fresh directory to unpack into.
 *
 * Separate from `fs.ts` because these are the calls that must not read a whole file into memory — a
 * release tarball is 40 MB, and a 512 MB box does not have 40 MB to spare for it twice.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync } from "node:fs";
import { join } from "node:path";

export interface FileWriter {
  /** Resolves once the bytes are handed to the file, so a caller can count what is on disk. */
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** A file opened for writing from the start, or for appending to what is there — created with `mode` if it is new. */
export function openFileWriter(path: string, options: { append?: boolean; mode?: number } = {}): FileWriter {
  const file = createWriteStream(path, { flags: options.append ? "a" : "w", ...(options.mode !== undefined ? { mode: options.mode } : {}) });
  return {
    write: (bytes) => new Promise<void>((resolve, reject) => file.write(bytes, (err) => (err ? reject(err) : resolve()))),
    close: () => new Promise<void>((resolve) => file.close(() => resolve())),
  };
}

/** SHA-256 and length of a file, read in pieces. */
export async function digestFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const part = chunk as Uint8Array;
    hash.update(part);
    bytes += part.byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** A new, empty directory inside `parent`, named `<prefix><random>`. */
export function makeTempDir(parent: string, prefix: string): string {
  return mkdtempSync(join(parent, prefix));
}
