/**
 * The archive the dashboard writes for "Download all" (`apps/dashboard/src/commons/lib/zip.ts`), read back by the
 * daemon's own reader (`packages/runtime`'s `readZip`), which refuses a damaged directory, a wrong size, a path that
 * climbs out and anything it does not understand. Every byte of every file comes back, under its name, in order.
 */

import { describe, expect, test } from "bun:test";
import { crc32 as zlibCrc32 } from "node:zlib";
import { readZip } from "@nouride/runtime";
import { crc32, namesOf, zipParts } from "../../../dashboard/src/commons/lib/zip.ts";

const bytesOf = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const random = (size: number, seed: number) => {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) out[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  return out;
};

describe("the archive of a reply's files", () => {
  test("reads back whole: each file's bytes under its name, in the set's order", () => {
    const files = [
      { name: "slide-01.png", bytes: random(70_001, 1) },
      { name: "slide-02.png", bytes: random(1, 2) },
      { name: "empty.txt", bytes: new Uint8Array(0) },
      { name: "laporan penjualan — Q3 ✓.pdf", bytes: random(4_096, 3) },
    ];
    const read = readZip(bytesOf(zipParts(files)), { maxBytes: 1_000_000, maxFiles: 10 });
    expect(read.map((entry) => entry.path)).toEqual(files.map((file) => file.name));
    read.forEach((entry, index) => expect(Buffer.from(entry.data).equals(Buffer.from(files[index]!.bytes))).toBe(true));
  });

  test("two files of one name are both there, told apart; a folder or a climb in a name is dropped", () => {
    const parts = zipParts([
      { name: "a.png", bytes: random(10, 1) },
      { name: "A.png", bytes: random(10, 2) },
      { name: "../../etc/passwd", bytes: random(10, 3) },
      { name: "C:\\Users\\x\\a.png", bytes: random(10, 4) },
      { name: "..", bytes: random(10, 5) },
      { name: "noext", bytes: random(10, 6) },
      { name: "noext", bytes: random(10, 7) },
    ]);
    expect(readZip(bytesOf(parts), { maxBytes: 1_000, maxFiles: 10 }).map((entry) => entry.path)).toEqual(["a.png", "A (2).png", "passwd", "a (3).png", "file", "noext", "noext (2)"]);
    expect(namesOf(["x.tar.gz", "x.tar.gz"])).toEqual(["x.tar.gz", "x.tar (2).gz"]);
    // A name already given as a told-apart one is told apart again.
    expect(namesOf(["a (2).png", "a.png", "a.png"])).toEqual(["a (2).png", "a.png", "a (3).png"]);
    // Many of one name stay quick: each takes the next number rather than counting from 2 again.
    const started = performance.now();
    expect(namesOf(Array.from({ length: 20_000 }, () => "image.png")).at(-1)).toBe("image (20000).png");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("each file's check is CRC-32, as zlib's own and the standard's check value", () => {
    for (const size of [0, 1, 255, 65_537]) {
      const bytes = random(size, size + 11);
      expect(crc32(bytes)).toBe(zlibCrc32(bytes));
    }
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("the time it was made is kept to two seconds, and the name is marked UTF-8", () => {
    const bytes = bytesOf(zipParts([{ name: "ü.png", bytes: random(3, 1), modified: new Date(2026, 10, 15, 21, 48, 31) }]));
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    expect([time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([21, 48, 30]);
    expect([(date >> 9) + 1980, (date >> 5) & 15, date & 31]).toEqual([2026, 11, 15]);
  });

  test("more than one archive holds is refused, not written broken", () => {
    const many = Array.from({ length: 0x10000 }, () => ({ name: "a", bytes: new Uint8Array(0) }));
    expect(() => zipParts(many)).toThrow(/more than one archive holds/);
  });
});
