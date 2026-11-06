/**
 * Reading a small `.zip` in memory — how ClawHub hands out a skill.
 *
 * A skill is a handful of Markdown files and scripts, so the whole archive is read at once, bounded
 * by `maxBytes` and `maxFiles` before anything is inflated. Only what such an archive holds is
 * understood: stored and deflated entries, in the central directory's order. Encryption, ZIP64 and
 * paths that climb out (`../`, absolute) are refused, not skipped — a skill installed with a file
 * quietly missing is worse than one that says it could not be read.
 */

import { inflateRawSync } from "node:zlib";
import { normalize } from "node:path";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export function readZip(bytes: Uint8Array, limits: { maxBytes: number; maxFiles: number }): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (count > limits.maxFiles) throw new Error(`the archive has ${count} entries, more than ${limits.maxFiles}`);

  const entries: ZipEntry[] = [];
  let total = 0;
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("the archive's central directory is damaged");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error(`"${name}" is encrypted`);
    const path = safePath(name);
    total += size;
    if (total > limits.maxBytes) throw new Error(`the archive unpacks to more than ${limits.maxBytes} bytes`);

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`"${name}" has no local header where the directory says`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new Error(`"${name}" uses compression method ${method}, which is not supported`);
    if (data.length !== size) throw new Error(`"${name}" does not unpack to the size the archive states`);
    entries.push({ path, data: new Uint8Array(data) });
  }
  return entries;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("not a ZIP archive");
}

function safePath(name: string): string {
  const clean = normalize(name.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (!clean || clean.startsWith("/") || clean === ".." || clean.startsWith("../") || /^[a-z]:/i.test(clean)) {
    throw new Error(`refusing "${name}": it points outside the archive`);
  }
  return clean;
}
