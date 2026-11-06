/** The ZIP reader ClawHub skills arrive through: what `zip` writes, and what it refuses. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { readZip } from "../src/zip.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-zip-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const LIMITS = { maxBytes: 1_000_000, maxFiles: 100 };

/** A one-entry archive, written by hand so the refusals can be tested. */
function oneEntry(name: string, content: string, method = 8): Uint8Array {
  const data = Buffer.from(content);
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, nameBuf, body, central, nameBuf, end]));
}

describe("readZip", () => {
  test("what `zip` writes: nested files, deflated and stored", () => {
    const src = join(root, "skill");
    mkdirSync(join(src, "references"), { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: x\n---\nbody ".repeat(50));
    writeFileSync(join(src, "references", "a.md"), "ref");
    const out = join(root, "s.zip");
    const made = spawnSync("zip", ["-qr", out, "."], { cwd: src });
    expect(made.status).toBe(0);
    const entries = readZip(readFileSync(out), LIMITS);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, Buffer.from(e.data).toString()]));
    expect(Object.keys(byPath).sort()).toEqual(["SKILL.md", "references/a.md"]);
    expect(byPath["references/a.md"]).toBe("ref");
    expect(byPath["SKILL.md"]).toContain("name: x");
  });

  test("a hand-built entry, both methods", () => {
    expect(Buffer.from(readZip(oneEntry("a.md", "hello", 8), LIMITS)[0]!.data).toString()).toBe("hello");
    expect(Buffer.from(readZip(oneEntry("a.md", "hello", 0), LIMITS)[0]!.data).toString()).toBe("hello");
  });

  test("refuses paths out of the archive, too much, and what is not a zip", () => {
    expect(() => readZip(oneEntry("../evil.md", "x"), LIMITS)).toThrow("outside the archive");
    expect(() => readZip(oneEntry("/etc/evil", "x"), LIMITS)).toThrow("outside the archive");
    expect(() => readZip(oneEntry("big.md", "x".repeat(2000)), { maxBytes: 1000, maxFiles: 10 })).toThrow("more than 1000 bytes");
    expect(() => readZip(new Uint8Array(100), LIMITS)).toThrow("not a ZIP archive");
  });
});

/**
 * A hand-built archive with every field the reader decides on reachable — what the 0.7.11 mutation sweep found no
 * test holding the reader to: the refusals it names, the limits at their edges, and the records a real `zip` writes
 * that the hand-built one above does not (an archive comment, a `./` or `\\` path).
 */
function archive(
  files: { name: string; content: string; method?: number; flags?: number; declaredSize?: number }[],
  options: { comment?: string; count?: number; localOffsetShift?: number; cdSignature?: number } = {},
): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const method = file.method ?? 8;
    const data = Buffer.from(file.content);
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(options.cdSignature ?? 0x02014b50, 0);
    central.writeUInt16LE(file.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.declaredSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset + (options.localOffsetShift ?? 0), 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.count ?? files.length, 8);
  end.writeUInt16LE(options.count ?? files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, directory, end, comment]));
}

const text = (entries: { path: string; data: Uint8Array }[]) => entries.map((e) => `${e.path}=${Buffer.from(e.data).toString()}`);

describe("readZip, field by field", () => {
  test("an archive comment does not hide the end record, and several entries come back in the directory's order", () => {
    const zip = archive([{ name: "a.md", content: "A" }, { name: "./b/c.md", content: "C", method: 0 }], { comment: "made by hand" });
    expect(text(readZip(zip, LIMITS))).toEqual(["a.md=A", "b/c.md=C"]);
  });

  test("an archive of nothing is the end record alone, and an empty file inflates to nothing", () => {
    expect(readZip(archive([]), LIMITS)).toEqual([]);
    expect(text(readZip(archive([{ name: "empty.md", content: "" }]), LIMITS))).toEqual(["empty.md="]);
  });

  test("a backslash path is a path, and a drive letter is outside the archive — a colon later on is not one", () => {
    expect(text(readZip(archive([{ name: "refs\\deep\\a.md", content: "x" }]), LIMITS))).toEqual(["refs/deep/a.md=x"]);
    expect(text(readZip(archive([{ name: "notes/at 10:30.md", content: "y" }]), LIMITS))).toEqual(["notes/at 10:30.md=y"]);
    expect(() => readZip(archive([{ name: "C:\\evil.md", content: "x" }]), LIMITS)).toThrow("outside the archive");
    expect(() => readZip(archive([{ name: "..", content: "x" }]), LIMITS)).toThrow("outside the archive");
    // `.\\` is not a directory entry (no trailing `/`) and names nothing once normalized.
    expect(() => readZip(archive([{ name: ".\\", content: "x" }]), LIMITS)).toThrow("outside the archive");
  });

  test("the limits hold at their edges: as many files and bytes as allowed, and one more of either is refused", () => {
    const two = archive([{ name: "a", content: "12345" }, { name: "b", content: "67890" }]);
    expect(readZip(two, { maxBytes: 10, maxFiles: 2 })).toHaveLength(2);
    expect(() => readZip(two, { maxBytes: 9, maxFiles: 2 })).toThrow("more than 9 bytes");
    expect(() => readZip(two, { maxBytes: 10, maxFiles: 1 })).toThrow("the archive has 2 entries, more than 1");
  });

  test("encryption, an unknown method, a size that does not match and ZIP64 are refused by name", () => {
    expect(() => readZip(archive([{ name: "s.md", content: "x", flags: 1 }]), LIMITS)).toThrow('"s.md" is encrypted');
    expect(() => readZip(archive([{ name: "s.md", content: "x", method: 12 }]), LIMITS)).toThrow("compression method 12");
    expect(() => readZip(archive([{ name: "s.md", content: "abc", method: 0, declaredSize: 2 }]), LIMITS)).toThrow(
      "does not unpack to the size the archive states",
    );
    expect(() => readZip(archive([{ name: "s.md", content: "abc", declaredSize: 2 }]), LIMITS)).toThrow();
    expect(() => readZip(archive([{ name: "s.md", content: "x" }], { count: 0xffff }), LIMITS)).toThrow("ZIP64");
  });

  test("a directory that points at the wrong place is damage, not an empty archive", () => {
    expect(() => readZip(archive([{ name: "s.md", content: "x" }], { cdSignature: 0x01020304 }), LIMITS)).toThrow("central directory is damaged");
    expect(() => readZip(archive([{ name: "s.md", content: "x" }], { localOffsetShift: 3 }), LIMITS)).toThrow("no local header");
  });
});
