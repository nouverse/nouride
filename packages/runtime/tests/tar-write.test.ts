/**
 * `writeTarGz`: what it writes is read back whole by `extractTarGz` (the reader an import uses) and by the system's own
 * `tar` (what a person opens an export with): folders, an empty one, files of every awkward size, names past the
 * header's hundred bytes, modes. A file that changed under it and a path that leaves the archive are errors.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTarGz } from "../src/tar.ts";
import { writeTarGz, type TarEntry } from "../src/tar-write.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, n) => (n * 31 + seed) % 251);
const LONG = `packs/${"a-folder-with-a-long-name/".repeat(9)}the file at the end of it.md`;
const ACCENTED = "memory/catatan-é-日本語.md";

/** A source folder and the entries that archive it, with every size a block boundary makes awkward. */
function fixture(): { entries: TarEntry[]; files: Record<string, Uint8Array> } {
  dir = mkdtempSync(join(tmpdir(), "nr-tar-write-"));
  const files: Record<string, Uint8Array> = {
    "data/empty.bin": new Uint8Array(0),
    "data/one.bin": bytes(1, 1),
    "data/block.bin": bytes(512, 2),
    "data/block-and-one.bin": bytes(513, 3),
    "data/many.bin": bytes(70_000, 4),
    [LONG]: bytes(300, 5),
    [ACCENTED]: bytes(40, 6),
  };
  const entries: TarEntry[] = [{ name: "manifest.json", bytes: new TextEncoder().encode('{"format":1}'), mode: 0o600 }, { name: "data", directory: true, mode: 0o750 }, { name: "nothing-in-here", directory: true }];
  let n = 0;
  for (const [name, data] of Object.entries(files)) {
    const from = join(dir, `source-${n++}`);
    writeFileSync(from, data);
    entries.push({ name, from, size: data.length, mode: name === "data/one.bin" ? 0o640 : 0o600, mtimeMs: 1_760_000_000_000 });
  }
  return { entries, files };
}

describe("an archive written here", () => {
  test("is read back whole by the reader an import uses: every file byte for byte, an empty folder, a long name, the modes", async () => {
    const { entries, files } = fixture();
    const out = join(dir, "out.tar.gz");
    const wrote = await writeTarGz(out, entries);
    expect(wrote).toEqual({ files: 8, directories: 2, bytes: Object.values(files).reduce((sum, data) => sum + data.length, 12) });
    expect(statSync(out).mode & 0o777).toBe(0o600);

    const into = join(dir, "back");
    mkdirSync(into);
    expect(await extractTarGz(out, into)).toEqual({ files: 8, directories: 2 });
    for (const [name, data] of Object.entries(files)) expect({ name, same: Buffer.compare(readFileSync(join(into, name)), Buffer.from(data)) === 0 }).toEqual({ name, same: true });
    expect(readFileSync(join(into, "manifest.json"), "utf8")).toBe('{"format":1}');
    expect(readdirSync(join(into, "nothing-in-here"))).toEqual([]);
    expect(statSync(join(into, "data/one.bin")).mode & 0o777).toBe(0o640);
    expect(statSync(join(into, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(into, "data")).mode & 0o777).toBe(0o750);
  });

  test("is opened by the system's own tar, which lists and unpacks the same", async () => {
    const { entries, files } = fixture();
    const out = join(dir, "out.tar.gz");
    await writeTarGz(out, entries);
    const listed = spawnSync("tar", ["tzf", out], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    // A name outside ASCII is listed escaped, each tar its own way: counted here, and read by its name below.
    const plain = (names: string[]) => names.filter((name) => /^[\x20-\x7e]+$/.test(name) && !name.includes("\\")).sort();
    const lines = listed.stdout.trim().split("\n");
    expect(lines).toHaveLength(Object.keys(files).length + 3);
    expect(plain(lines)).toEqual(plain(["manifest.json", "data/", "nothing-in-here/", ...Object.keys(files)]));
    const into = join(dir, "by-tar");
    mkdirSync(into);
    const unpacked = spawnSync("tar", ["xzf", out, "-C", into], { encoding: "utf8" });
    expect(unpacked.stderr).toBe("");
    expect(unpacked.status).toBe(0);
    for (const [name, data] of Object.entries(files)) expect({ name, same: Buffer.compare(readFileSync(join(into, name)), Buffer.from(data)) === 0 }).toEqual({ name, same: true });
  });

  test("says each entry as it is written, in order", async () => {
    const { entries } = fixture();
    const said: string[] = [];
    await writeTarGz(join(dir, "out.tar.gz"), entries, (entry) => said.push(entry.name));
    expect(said).toEqual(entries.map((entry) => entry.name));
  });
});

describe("what it refuses", () => {
  test("a file that is shorter than it was measured: the archive would hold a body its header does not describe", async () => {
    const { entries } = fixture();
    const many = entries.find((entry) => entry.name === "data/many.bin") as Extract<TarEntry, { from: string }>;
    truncateSync(many.from, 100);
    await expect(writeTarGz(join(dir, "out.tar.gz"), entries)).rejects.toThrow("changed while it was being archived: 100 of 70000 bytes");
  });

  test("a file that grew is archived at the size it was measured, and the entries after it are read right", async () => {
    const { entries, files } = fixture();
    const one = entries.find((entry) => entry.name === "data/one.bin") as Extract<TarEntry, { from: string }>;
    writeFileSync(one.from, bytes(5_000, 1));
    const out = join(dir, "out.tar.gz");
    await writeTarGz(out, entries);
    const into = join(dir, "back");
    mkdirSync(into);
    await extractTarGz(out, into);
    expect(readFileSync(join(into, "data/one.bin")).length).toBe(1);
    expect(Buffer.compare(readFileSync(join(into, "data/many.bin")), Buffer.from(files["data/many.bin"]!))).toBe(0);
  });

  test("a name that leaves the archive, and nothing is left looking whole", async () => {
    dir = mkdtempSync(join(tmpdir(), "nr-tar-write-"));
    for (const name of ["../outside.txt", "/etc/passwd", "packs/../../x"]) {
      await expect(writeTarGz(join(dir, "out.tar.gz"), [{ name, bytes: new Uint8Array(1) }])).rejects.toThrow("is not a path inside the archive");
    }
    const into = join(dir, "back");
    mkdirSync(into);
    await expect(extractTarGz(join(dir, "out.tar.gz"), into)).rejects.toThrow();
    expect(existsSync(join(dir, "outside.txt"))).toBe(false);
  });
});
