/**
 * Writing a `.tar.gz`: an install's export, one file a person opens with their own `tar`.
 *
 * The other half of `tar.ts`, and held to what that one reads back: directories and regular files, in ustar, a pax
 * record before an entry whose name does not fit the header or whose size is past 8 GB. No links and no devices: the
 * caller leaves them out and says so. Streamed from disk through gzip, so a database of some gigabytes is never one
 * buffer, and each write waits for the one before it to drain.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { createGzip } from "node:zlib";

const BLOCK = 512;
/** The largest size a ustar header's eleven octal digits hold. */
const USTAR_MAX = 0o77777777777;

/** One thing to put in the archive: a folder, a file read from disk, or bytes made here. */
export type TarEntry =
  | { name: string; directory: true; mode?: number; mtimeMs?: number }
  | { name: string; from: string; size: number; mode?: number; mtimeMs?: number }
  | { name: string; bytes: Uint8Array; mode?: number; mtimeMs?: number };

/**
 * `entries` written to `out` in order. A file whose size on disk is no longer what its entry said is an error: the
 * archive would hold a body that does not match its header, and every entry after it would be read wrong.
 */
export async function writeTarGz(out: string, entries: Iterable<TarEntry> | AsyncIterable<TarEntry>, onEntry?: (entry: TarEntry) => void): Promise<{ files: number; directories: number; bytes: number }> {
  const gzip = createGzip({ level: 6 });
  const file = createWriteStream(out, { mode: 0o600 });
  const closed = once(file, "close");
  let failed: unknown = null;
  gzip.on("error", (err) => (failed = failed ?? err));
  file.on("error", (err) => (failed = failed ?? err));
  gzip.pipe(file);
  const write = async (chunk: Uint8Array): Promise<void> => {
    if (failed) throw failed;
    if (!gzip.write(chunk)) await once(gzip, "drain");
  };
  let files = 0;
  let directories = 0;
  let bytes = 0;
  try {
    for await (const entry of entries) {
      const mtime = Math.floor((entry.mtimeMs ?? Date.now()) / 1000);
      if ("directory" in entry) {
        await header(write, { name: `${entry.name.replace(/\/+$/, "")}/`, size: 0, mode: entry.mode ?? 0o755, mtime, type: "5" });
        directories += 1;
      } else if ("bytes" in entry) {
        await header(write, { name: entry.name, size: entry.bytes.length, mode: entry.mode ?? 0o644, mtime, type: "0" });
        await write(entry.bytes);
        await write(padding(entry.bytes.length));
        files += 1;
        bytes += entry.bytes.length;
      } else {
        await header(write, { name: entry.name, size: entry.size, mode: entry.mode ?? 0o644, mtime, type: "0" });
        let read = 0;
        // `end` bounds a file that grew since it was measured; one that shrank is caught below.
        if (entry.size > 0) {
          for await (const chunk of createReadStream(entry.from, { end: entry.size - 1 })) {
            read += (chunk as Buffer).length;
            await write(chunk as Buffer);
          }
        }
        if (read !== entry.size) throw new Error(`${entry.from} changed while it was being archived: ${read} of ${entry.size} bytes were there`);
        await write(padding(entry.size));
        files += 1;
        bytes += entry.size;
      }
      onEntry?.(entry);
    }
    // Two empty blocks end an archive.
    await write(new Uint8Array(BLOCK * 2));
  } catch (err) {
    gzip.destroy();
    file.destroy();
    throw err;
  }
  gzip.end();
  await closed;
  if (failed) throw failed;
  return { files, directories, bytes };
}

const padding = (size: number): Uint8Array => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

interface Head {
  name: string;
  size: number;
  mode: number;
  mtime: number;
  type: string;
}

/** An entry's header block, with a pax record before it for a name or a size the block cannot hold. */
async function header(write: (chunk: Uint8Array) => Promise<void>, head: Head): Promise<void> {
  if (head.name.startsWith("/") || head.name.split("/").includes("..")) throw new Error(`"${head.name}" is not a path inside the archive`);
  const name = Buffer.from(head.name, "utf8");
  const records = [...(name.length > 100 ? [pax("path", head.name)] : []), ...(head.size > USTAR_MAX ? [pax("size", String(head.size))] : [])];
  if (records.length > 0) {
    const data = Buffer.concat(records);
    await write(block({ name: "PaxHeader", size: data.length, mode: 0o644, mtime: head.mtime, type: "x" }));
    await write(data);
    await write(padding(data.length));
  }
  // The header's own name is cut where it does not fit: a reader that knows pax takes the record's, as `tar.ts` does.
  await write(block({ ...head, size: Math.min(head.size, USTAR_MAX) }));
}

/** `<length> <key>=<value>\n`, where the length counts itself. */
function pax(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, "utf8");
}

function block(head: Head): Buffer {
  const out = Buffer.alloc(BLOCK);
  Buffer.from(head.name, "utf8").copy(out, 0, 0, 100);
  octal(out, 100, 8, head.mode & 0o7777);
  octal(out, 108, 8, 0);
  octal(out, 116, 8, 0);
  octal(out, 124, 12, head.size);
  octal(out, 136, 12, head.mtime);
  out.fill(0x20, 148, 156);
  out.write(head.type, 156, 1, "latin1");
  out.write("ustar\0", 257, 6, "latin1");
  out.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const byte of out) sum += byte;
  out.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return out;
}

function octal(out: Buffer, start: number, length: number, value: number): void {
  out.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "latin1");
}
