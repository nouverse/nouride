/**
 * A `.zip` written in the browser: the files of one reply handed over as one archive ("Download all").
 *
 * Built here rather than by the daemon, so the daemon carries nothing for it: the browser already has each file's
 * address and fetches them as it would to show them. Stored, not deflated: what an agent sends as a set is pictures,
 * a PDF, a video, already compressed, and deflating them again costs a phone seconds for a few bytes. Names are UTF-8
 * (the archive says so, bit 11), each file's own name with no folder, and two files of one name are told apart as
 * "name (2).ext". No ZIP64: an archive past 4 GB, or of more than 65,535 files, is refused rather than written broken.
 */

export interface ZipFile {
  name: string;
  bytes: Uint8Array;
  /** When the file was made; the archive keeps it to two seconds, as a zip does. Now when unknown. */
  modified?: Date;
}

const LIMIT = 0xffffffff;

let table: Uint32Array | null = null;

/** CRC-32 (IEEE), as the zip format checks each file by. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A file's name as an archive holds it: no folder, nothing a reader could take as one, never empty. */
function entryName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f]/g, "").trim();
  return clean === "" || clean === "." || clean === ".." ? "file" : clean;
}

/** The names of a set, each once: a second "a.png" is "a (2).png", in the set's order. */
export function namesOf(names: string[]): string[] {
  const taken = new Set<string>();
  /** The next number to try for a name already taken: a set of a thousand "image.png" stays a thousand steps. */
  const next = new Map<string, number>();
  return names.map((name) => {
    const clean = entryName(name);
    const dot = clean.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    let picked = clean;
    let n = next.get(clean.toLowerCase()) ?? 2;
    while (taken.has(picked.toLowerCase())) picked = `${stem} (${n++})${ext}`;
    if (picked !== clean) next.set(clean.toLowerCase(), n);
    taken.add(picked.toLowerCase());
    return picked;
  });
}

/** MS-DOS time and date, as a zip header holds them. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getFullYear(), 1980), 2107);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** The archive's bytes, as parts to hand to a `Blob` without copying the files into one buffer. */
export function zipParts(files: ZipFile[]): Uint8Array[] {
  if (files.length > 0xffff) throw new Error(`${files.length} files are more than one archive holds`);
  const encoder = new TextEncoder();
  const names = namesOf(files.map((file) => file.name));
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  files.forEach((file, index) => {
    const name = encoder.encode(names[index]!);
    const size = file.bytes.length;
    if (size > LIMIT || offset + 30 + name.length + size > LIMIT) throw new Error("the files are more than 4 GB together, more than one archive holds");
    const crc = crc32(file.bytes);
    const { time, date } = dosTime(file.modified ?? new Date());
    const local = new Uint8Array(30 + name.length);
    const head = new DataView(local.buffer);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true); // version needed: 2.0
    head.setUint16(6, 0x0800, true); // the name is UTF-8
    head.setUint16(8, 0, true); // stored
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, size, true);
    head.setUint32(22, size, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const dir = new DataView(entry.buffer);
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true); // made by 2.0
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);

    parts.push(local, file.bytes);
    offset += local.length + size;
  });
  const directorySize = central.reduce((sum, entry) => sum + entry.length, 0);
  if (offset + directorySize > LIMIT) throw new Error("the files are more than 4 GB together, more than one archive holds");
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, files.length, true);
  tail.setUint16(10, files.length, true);
  tail.setUint32(12, directorySize, true);
  tail.setUint32(16, offset, true);
  return [...parts, ...central, end];
}
