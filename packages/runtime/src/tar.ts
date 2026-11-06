/**
 * Unpacking a `.tar.gz` without the system's `tar` — the updater's fallback, and only that.
 *
 * The system `tar` is still what runs first. This exists because it can be refused in a way it
 * does not recover from: newer GNU tar creates every file below the top level with `openat2()`,
 * and systemd answers `openat2()` with `ENOSYS` under `RestrictSUIDSGID=true` — on purpose, since
 * its flags cannot be filtered and callers are expected to fall back to `openat()`. That tar does
 * not fall back. Inside the daemon's own unit, then, `nouride update` failed on every file in
 * `dashboard/` and `skills/` with "Cannot open: Function not implemented", while the same tarball
 * unpacked fine from a shell (2026-10-06, Ubuntu, v0.5.12 → v0.5.14).
 *
 * So this reads only what a release tarball holds: directories and regular files, in ustar, GNU or
 * pax form, with long names either way. A link, a device, or a path that leaves `into` is refused
 * rather than skipped — an updater that quietly drops part of a release is worse than one that
 * says it could not install it. Streamed, so an 88 MB binary is never one buffer: the smallest
 * box this ships to has 512 MB.
 */

import { chmodSync, closeSync, createReadStream, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { createGunzip } from "node:zlib";

const BLOCK = 512;

interface Header {
  path: string;
  size: number;
  mode: number;
  type: string;
}

/** What one entry's body is going to: a file on disk, a metadata record, or nowhere. */
type Body =
  | { kind: "file"; fd: number; remaining: number; padding: number }
  | { kind: "meta"; type: string; remaining: number; padding: number; chunks: Buffer[] }
  | { kind: "skip"; remaining: number; padding: number };

export async function extractTarGz(tarball: string, into: string): Promise<{ files: number; directories: number }> {
  let buffer: Buffer = Buffer.alloc(0);
  let body: Body | null = null;
  let ended = false;
  /** A pax `path`/`size` or a GNU long name, which applies to the next header only. */
  let next: { path?: string; size?: number } = {};
  let files = 0;
  let directories = 0;

  const target = (path: string): string => {
    const clean = normalize(path.replace(/^\.\/+/, "")).replace(/\/+$/, "");
    if (!clean || clean === ".") return into;
    if (isAbsolute(clean) || clean === ".." || clean.startsWith("../")) {
      throw new Error(`refusing "${path}": it is outside the directory being unpacked into`);
    }
    return join(into, clean);
  };

  const finishBody = (current: Body): void => {
    if (current.kind === "file") closeSync(current.fd);
    if (current.kind === "meta") {
      const data = Buffer.concat(current.chunks);
      if (current.type === "L") next.path = cString(data, 0, data.length);
      if (current.type === "x") next = { ...next, ...paxRecords(data) };
    }
  };

  const onHeader = (header: Header): Body | null => {
    const padding = (BLOCK - (header.size % BLOCK)) % BLOCK;
    switch (header.type) {
      case "5": {
        const dir = target(header.path);
        mkdirSync(dir, { recursive: true });
        // Owner keeps rwx whatever the archive says, or nothing could be written below it.
        chmodSync(dir, (header.mode & 0o777) | 0o700);
        directories += 1;
        return header.size ? { kind: "skip", remaining: header.size, padding } : null;
      }
      case "0":
      case "\0":
      case "7": {
        const file = target(header.path);
        mkdirSync(dirname(file), { recursive: true });
        const fd = openSync(file, "w", header.mode & 0o777);
        chmodSync(file, header.mode & 0o777);
        files += 1;
        if (header.size === 0) {
          closeSync(fd);
          return null;
        }
        return { kind: "file", fd, remaining: header.size, padding };
      }
      case "x":
      case "L":
        return { kind: "meta", type: header.type, remaining: header.size, padding, chunks: [] };
      case "g":
      case "K":
        return header.size ? { kind: "skip", remaining: header.size, padding } : null;
      default:
        throw new Error(
          `refusing "${header.path}": entry type "${header.type}" (a link or a device) is not something a release contains`,
        );
    }
  };

  const consume = (): void => {
    while (!ended) {
      if (body) {
        if (body.remaining > 0) {
          if (buffer.length === 0) return;
          const take = Math.min(body.remaining, buffer.length);
          const slice = buffer.subarray(0, take);
          if (body.kind === "file") writeSync(body.fd, slice);
          if (body.kind === "meta") body.chunks.push(Buffer.from(slice));
          body.remaining -= take;
          buffer = buffer.subarray(take);
          if (body.remaining > 0) return;
        }
        if (buffer.length < body.padding) return;
        buffer = buffer.subarray(body.padding);
        finishBody(body);
        body = null;
        continue;
      }

      if (buffer.length < BLOCK) return;
      const block = buffer.subarray(0, BLOCK);
      buffer = buffer.subarray(BLOCK);
      // Two zero blocks end an archive; one is enough to know nothing else is coming.
      if (block.every((byte) => byte === 0)) {
        ended = true;
        return;
      }
      const header = parseHeader(block);
      if (next.path !== undefined) header.path = next.path;
      if (next.size !== undefined) header.size = next.size;
      if (header.type !== "x" && header.type !== "L") next = {};
      body = onHeader(header);
    }
  };

  const stream = createReadStream(tarball).pipe(createGunzip());
  try {
    for await (const chunk of stream) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);
      consume();
      if (ended) break;
    }
  } finally {
    // Narrowed to `null` by the compiler, which cannot see `consume` assign it.
    const open = body as Body | null;
    if (open?.kind === "file") closeSync(open.fd);
    stream.destroy();
  }
  if (!ended && (body || buffer.length)) throw new Error("the archive ends in the middle of an entry");
  return { files, directories };
}

function parseHeader(block: Buffer): Header {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  if (stored !== sum) throw new Error("not a tar archive, or a damaged one: a header checksum does not match");

  const name = cString(block, 0, 100);
  const ustar = block.subarray(257, 262).toString("latin1") === "ustar";
  const prefix = ustar ? cString(block, 345, 155) : "";
  return {
    path: prefix ? `${prefix}/${name}` : name,
    size: size(block),
    mode: octal(block, 100, 8),
    type: String.fromCharCode(block[156]!),
  };
}

/** The size field: octal, or GNU's base-256 for anything past 8 GB. */
function size(block: Buffer): number {
  if (block[124]! & 0x80) {
    let value = block[124]! & 0x7f;
    for (let i = 125; i < 136; i += 1) value = value * 256 + block[i]!;
    return value;
  }
  return octal(block, 124, 12);
}

function octal(block: Buffer, start: number, length: number): number {
  const text = cString(block, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function cString(data: Buffer, start: number, length: number): string {
  const slice = data.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

/** `<length> <key>=<value>\n`, repeated. Only the two keys that change where and how much. */
function paxRecords(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("latin1"), 10);
    if (!length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") out.path = value;
    if (key === "size") out.size = Number.parseInt(value, 10);
    offset += length;
  }
  return out;
}
