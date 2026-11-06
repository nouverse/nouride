/**
 * The updater's fallback tar reader: what the system's `tar` writes, the long-name forms both GNU
 * and libarchive use, and the refusals — a path out of the target, a link, a truncated archive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractTarGz } from "../src/tar.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-tar-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** One 512-byte ustar header, with its checksum. */
function header(name: string, options: { size?: number; type?: string; mode?: number; prefix?: string } = {}): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(`${(options.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(`${(options.size ?? 0).toString(8).padStart(11, "0")}\0`, 124, "latin1");
  block.write("00000000000\0", 136, "latin1");
  block.write(options.type ?? "0", 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  if (options.prefix) block.write(options.prefix, 345, "utf8");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function entry(name: string, content: string | Buffer, options: { type?: string; mode?: number } = {}): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(name, { ...options, size: data.length }), data, padding]);
}

function archive(...entries: Buffer[]): string {
  const path = join(root, `a-${Math.random().toString(36).slice(2)}.tar.gz`);
  writeFileSync(path, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  return path;
}

const out = () => {
  const dir = join(root, `out-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  return dir;
};

describe("what the system's tar writes", () => {
  test("nested directories, an executable, an empty file and a long path come back as they were", async () => {
    const src = join(root, "src");
    const deep = join(src, "skills", "a-skill-with-a-rather-long-name", "references", "and-a-nested-folder-that-pushes-it-past");
    mkdirSync(join(src, "dashboard", "assets"), { recursive: true });
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(src, "nouride"), "#!/bin/sh\necho hi\n");
    chmodSync(join(src, "nouride"), 0o755);
    writeFileSync(join(src, "dashboard", "index.html"), "<html></html>");
    writeFileSync(join(src, "dashboard", "assets", "empty.css"), "");
    const long = join(deep, "the-one-hundred-character-ustar-name-limit.md");
    writeFileSync(long, "deep");
    const big = Buffer.alloc(300_000, 7);
    writeFileSync(join(src, "dashboard", "assets", "big.bin"), big);

    const tarball = join(root, "release.tar.gz");
    // macOS's tar adds a `._` AppleDouble file per file unless told not to; the release build does.
    const made = spawnSync("tar", ["-czf", tarball, "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    expect(made.status).toBe(0);

    const dir = out();
    const counts = await extractTarGz(tarball, dir);
    expect(counts.files).toBe(5);
    expect(readFileSync(join(dir, "nouride"), "utf8")).toContain("echo hi");
    expect(statSync(join(dir, "nouride")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dir, "dashboard", "index.html"), "utf8")).toBe("<html></html>");
    expect(readFileSync(join(dir, "dashboard", "assets", "empty.css"), "utf8")).toBe("");
    expect(readFileSync(join(dir, "dashboard", "assets", "big.bin")).equals(big)).toBe(true);
    expect(readFileSync(long.replace(src, dir), "utf8")).toBe("deep");
  });
});

describe("long names", () => {
  const longName = `skills/${"x".repeat(120)}/SKILL.md`;

  test("a pax `path` record, as libarchive writes it", async () => {
    const record = (key: string, value: string) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (`${length}${body}`.length !== length) length += 1;
      return `${length}${body}`;
    };
    const dir = out();
    await extractTarGz(archive(entry("PaxHeader/x", record("path", longName), { type: "x" }), entry("truncated", "pax")), dir);
    expect(readFileSync(join(dir, longName), "utf8")).toBe("pax");
    expect(existsSync(join(dir, "truncated"))).toBe(false);
  });

  test("a GNU `L` record, as GNU tar writes it", async () => {
    const dir = out();
    await extractTarGz(archive(entry("././@LongLink", `${longName}\0`, { type: "L" }), entry("truncated", "gnu")), dir);
    expect(readFileSync(join(dir, longName), "utf8")).toBe("gnu");
  });
});

/**
 * Edges the 0.7.11 mutation sweep found nothing catching. Each is a mutant of `tar.ts` that every test above let
 * through: a long name that stuck to every entry after it, modes and counts nobody read back, entry types never seen,
 * a body ending exactly on a block, a stream whose chunks do not fall on block boundaries, descriptors left open.
 */
describe("what the reader has to get exactly right", () => {
  const pax = (key: string, value: string) => {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length += 1;
    return `${length}${body}`;
  };

  test("a long name applies to the next entry only, and a pax size to its body", async () => {
    const longName = `skills/${"y".repeat(120)}/SKILL.md`;
    const dir = out();
    // The pax record's size says 12; the ustar header under it says 0, as tar writes for a body it cannot state.
    const body = Buffer.concat([Buffer.from("abcdefghijkl"), Buffer.alloc(500)]);
    await extractTarGz(
      archive(
        entry("PaxHeader/x", pax("size", "12") + pax("path", longName), { type: "x" }),
        header("short", { size: 0 }),
        body,
        entry("after", "own name"),
      ),
      dir,
    );
    expect(readFileSync(join(dir, longName), "utf8")).toBe("abcdefghijkl");
    expect(readFileSync(join(dir, "after"), "utf8")).toBe("own name");
  });

  test("a pax record of length zero ends the records rather than looping on them", async () => {
    const dir = out();
    await extractTarGz(archive(entry("PaxHeader/x", "0 path=nowhere\n", { type: "x" }), entry("kept", "k")), dir);
    expect(readFileSync(join(dir, "kept"), "utf8")).toBe("k");
  });

  test("a name that fills its hundred bytes, and a prefix that fills its hundred and fifty-five", async () => {
    const name = "n".repeat(100);
    const prefix = "p".repeat(155);
    const dir = out();
    await extractTarGz(
      archive(entry(name, "full name"), header("file", { size: 6, prefix }), Buffer.concat([Buffer.from("prefix"), Buffer.alloc(506)])),
      dir,
    );
    expect(readFileSync(join(dir, name), "utf8")).toBe("full name");
    expect(readFileSync(join(dir, prefix, "file"), "utf8")).toBe("prefix");
  });

  test("a size in GNU's base-256 form, and a size field left blank, are read as sizes", async () => {
    const big = header("big", { size: 0 });
    big.fill(0, 124, 136);
    big[124] = 0x80;
    big[135] = 3;
    const blank = header("blank-dir/", { type: "5" });
    blank.fill(0x20, 124, 136);
    for (const block of [big, blank]) {
      block.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of block) sum += byte;
      block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    }
    const dir = out();
    await extractTarGz(archive(big, Buffer.concat([Buffer.from("abc"), Buffer.alloc(509)]), blank, entry("blank-dir/in", "i")), dir);
    expect(readFileSync(join(dir, "big"), "utf8")).toBe("abc");
    expect(readFileSync(join(dir, "blank-dir", "in"), "utf8")).toBe("i");
  });

  test("modes come back as stored, a directory always keeps its owner's rwx, and the counts are what was made", async () => {
    const dir = out();
    const counts = await extractTarGz(
      archive(
        header("open/", { type: "5", mode: 0o755 }),
        header("locked/", { type: "5", mode: 0o000 }),
        entry("open/a.txt", "a", { mode: 0o640 }),
        entry("locked/b.txt", "b", { mode: 0o604 }),
      ),
      dir,
    );
    expect(counts).toEqual({ files: 2, directories: 2 });
    expect(statSync(join(dir, "open")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, "locked")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "open", "a.txt")).mode & 0o777).toBe(0o640);
    expect(statSync(join(dir, "locked", "b.txt")).mode & 0o777).toBe(0o604);
  });

  test("the old and contiguous file types are files, and global and long-link records are skipped", async () => {
    const dir = out();
    await extractTarGz(
      archive(
        entry("global", pax("comment", "made by a test"), { type: "g" }),
        entry("././@LongLink", "ignored-link-target\0", { type: "K" }),
        entry("old", "v7", { type: "\0" }),
        entry("contiguous", "seven", { type: "7" }),
        entry("sized-dir/", "xx", { type: "5" }),
        entry("sized-dir/inside", "in"),
      ),
      dir,
    );
    expect(readFileSync(join(dir, "old"), "utf8")).toBe("v7");
    expect(readFileSync(join(dir, "contiguous"), "utf8")).toBe("seven");
    expect(readFileSync(join(dir, "sized-dir", "inside"), "utf8")).toBe("in");
    expect(existsSync(join(dir, "global"))).toBe(false);
  });

  test("a one-byte file, and a body that ends exactly on a block across the stream's chunks", async () => {
    const exact = Buffer.alloc(512 * 300, 9);
    const dir = out();
    await extractTarGz(archive(entry("one", "1"), entry("exact.bin", exact), entry("last", "z")), dir);
    expect(readFileSync(join(dir, "one"), "utf8")).toBe("1");
    expect(readFileSync(join(dir, "exact.bin")).equals(exact)).toBe(true);
    expect(readFileSync(join(dir, "last"), "utf8")).toBe("z");
  });

  test("a stream whose chunks split headers mid-block loses nothing", async () => {
    // Stored, not compressed: gunzip's chunks then end where the file's reads do, 64 KB apart, which is not a
    // multiple of 512 — and with three hundred one-byte entries nearly every byte is a header or its padding.
    const tar = Buffer.concat([...Array.from({ length: 300 }, (_, i) => entry(`f${i}`, String(i % 10))), Buffer.alloc(1024)]);
    const path = join(root, "stored.tar.gz");
    writeFileSync(path, gzipSync(tar, { level: 0 }));
    const dir = out();
    expect(await extractTarGz(path, dir)).toEqual({ files: 300, directories: 0 });
    expect(readFileSync(join(dir, "f299"), "utf8")).toBe("9");
  });

  test("a GNU long name and a pax record after it both apply to the entry they precede", async () => {
    const longName = `skills/${"z".repeat(120)}/SKILL.md`;
    const body = Buffer.concat([Buffer.from("twelve bytes"), Buffer.alloc(500)]);
    const dir = out();
    await extractTarGz(
      archive(
        entry("././@LongLink", `${longName}\0`, { type: "L" }),
        entry("PaxHeader/x", pax("size", "12"), { type: "x" }),
        header("short", { size: 0 }),
        body,
      ),
      dir,
    );
    expect(readFileSync(join(dir, longName), "utf8")).toBe("twelve bytes");
  });

  test("one zero block ends the archive, whatever follows it", async () => {
    const path = join(root, "trailing.tar.gz");
    writeFileSync(path, gzipSync(Buffer.concat([entry("a", "x"), Buffer.alloc(512), Buffer.alloc(512, 65)])));
    const dir = out();
    expect(await extractTarGz(path, dir)).toEqual({ files: 1, directories: 0 });
  });

  test("every file it opened is closed", async () => {
    const before = readdirSync("/dev/fd").length;
    const dir = out();
    await extractTarGz(archive(...Array.from({ length: 40 }, (_, i) => entry(`f${i}`, `body ${i}`))), dir);
    expect(readdirSync("/dev/fd").length).toBe(before);
  });
});

describe("refusals", () => {
  test("a bare `..`, which normalizes to itself", async () => {
    const dir = join(out(), "inner");
    mkdirSync(dir);
    await expect(extractTarGz(archive(header("..", { type: "5" })), dir)).rejects.toThrow("outside the directory");
  });

  test("a path that leaves the target", async () => {
    const dir = out();
    await expect(extractTarGz(archive(entry("../evil", "x")), dir)).rejects.toThrow("outside the directory");
    await expect(extractTarGz(archive(entry("/etc/evil", "x")), dir)).rejects.toThrow("outside the directory");
    expect(existsSync(join(root, "evil"))).toBe(false);
  });

  test("a link — not something a release contains", async () => {
    await expect(extractTarGz(archive(entry("link", "", { type: "2" })), out())).rejects.toThrow('entry type "2"');
  });

  test("an archive cut off mid-file, and one that is not a tar at all", async () => {
    const whole = Buffer.concat([entry("a", "x".repeat(2000))]);
    const cut = join(root, "cut.tar.gz");
    writeFileSync(cut, gzipSync(whole.subarray(0, 1000)));
    await expect(extractTarGz(cut, out())).rejects.toThrow("ends in the middle");

    const junk = join(root, "junk.tar.gz");
    writeFileSync(junk, gzipSync(Buffer.alloc(512, 65)));
    await expect(extractTarGz(junk, out())).rejects.toThrow("header checksum");
  });
});
