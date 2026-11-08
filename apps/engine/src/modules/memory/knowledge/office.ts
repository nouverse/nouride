/**
 * PDF, Word, Excel, PowerPoint and their open cousins, read for the knowledge base (KNOWLEDGE_BASE §6, 0.8.20) by the
 * `document-reading` skill's `doc.py`, run by the daemon as itself: the reader agents already use, so a file an agent
 * can read is one the knowledge base can, and the other way round.
 *
 * What it read is cached by the file's own hash (`data/knowledge/<sha256>.json`), so a file read once is not read again
 * when only its time moved, or the index is rebuilt. A file that needs a program the box does not have says which, so the
 * page can offer to have it installed, and is tried again at each sync until it reads.
 */

import { ensureDir, join, randomHex, readTextFile, removePath, runCommand, sha256File, statFile, writeTextFileAtomic } from "@nouride/runtime";
import { sectionsOfTable, sectionsOfText, TRAIL_MARK, type Section } from "./sections.ts";

/** Where `doc.py` is and where its work and its results go. */
export interface OfficeReader {
  /** `<builtin skills>/document-reading/scripts/doc.py`. */
  script: string;
  /** `data/knowledge/`: the cache, and a folder for each read's own files. */
  cacheDir: string;
}

/** What a read gave: sections, or why there are none, and the program that would read it when one is missing. */
export type OfficeRead =
  | { kind: "read"; title: string; sections: Section[] }
  | { kind: "unreadable"; title: string; reason: string; needs?: string };

/** The kinds `doc.py` reads, by extension, and how its output is cut. */
const KINDS: Record<string, "pages" | "text" | "book"> = {
  ".pdf": "pages",
  ".docx": "text",
  ".docm": "text",
  ".doc": "text",
  ".odt": "text",
  ".rtf": "text",
  ".epub": "text",
  ".pptx": "text",
  ".pptm": "text",
  ".ppt": "text",
  ".odp": "text",
  ".xlsx": "book",
  ".xlsm": "book",
  ".xls": "book",
  ".xlsb": "book",
  ".ods": "book",
};

export function officeKind(extension: string): "pages" | "text" | "book" | null {
  return KINDS[extension] ?? null;
}

/** Ten minutes: a long PDF through `pdftotext`, or a spreadsheet through LibreOffice, on a small box. */
const READ_MS = 10 * 60_000;
/** The cache's own shape: a change to it reads every file again rather than misreading the old one. */
const CACHE_VERSION = 1;

/** About what 2,000 sections hold: past it, the rest of a document is not searched (`extract.ts`). */
const TEXT_MAX = 2_000 * 1_500;

/** PDF text as `doc.py` writes it, `=== page N ===` before each page, in sections that keep the pages they span. */
export function sectionsOfPages(text: string, title: string, max = 1_500): Section[] {
  const pages: { n: number; text: string }[] = [];
  const marker = /^=== page (\d+) ===$/gm;
  const marks = [...text.matchAll(marker)];
  for (const [i, mark] of marks.entries()) {
    const start = mark.index! + mark[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : text.length;
    pages.push({ n: Number(mark[1]), text: text.slice(start, end) });
  }
  if (pages.length === 0) pages.push({ n: 1, text });
  const sections: Section[] = [];
  let current: { text: string; from: number; to: number } | null = null;
  const push = () => {
    if (current?.text.trim()) sections.push({ n: sections.length, trail: title, text: current.text.trim(), pageFrom: current.from, pageTo: current.to });
    current = null;
  };
  for (const page of pages) {
    for (const paragraph of page.text.split(/\n\s*\n/).map((part) => part.replace(/[ \t]+/g, " ").trim()).filter(Boolean)) {
      if (current && current.text.length + paragraph.length + 2 > max) push();
      if (!current) current = { text: "", from: page.n, to: page.n };
      // A paragraph longer than a section on its own: in pieces, each on this page.
      for (let at = 0; at < paragraph.length; at += max) {
        const piece = paragraph.slice(at, at + max);
        if (current.text && current.text.length + piece.length + 2 > max) {
          push();
          current = { text: "", from: page.n, to: page.n };
        }
        current.text = current.text ? `${current.text}\n\n${piece}` : piece;
        current.to = page.n;
      }
    }
  }
  push();
  return sections;
}

/** What `doc.py` said is missing, as the package that brings it: what the page offers to have installed. */
function neededFrom(stderr: string): string | undefined {
  if (/pdftotext|poppler/i.test(stderr)) return "poppler-utils";
  if (/libreoffice/i.test(stderr)) return "libreoffice";
  return undefined;
}

/** What a file says when Python itself is missing: the program the page offers is Python. */
const NO_PYTHON = { reason: "Reading this kind of file needs Python, which this box does not have yet.", needs: "python3" } as const;

/** Why a file could not be read, in a sentence a person reads: `doc.py`'s own words are for whoever runs the box. */
function reasonFrom(code: number | null, stderr: string): { reason: string; needs?: string } {
  // 127, the program was not found: python3 is started through `nice` and the like (`commandLine`), which start and then
  // say so this way. In the container image, which has no Python, every PDF and Office file said only that it could not
  // be read, offered nothing to install, and was never tried again (0.8.20's check on the image).
  if (code === 127) return { ...NO_PYTHON };
  if (code === 3) {
    const needs = neededFrom(stderr);
    return { reason: "Reading this kind of file needs a program this box does not have yet, so it is kept here but not searched for now.", ...(needs ? { needs } : {}) };
  }
  if (/password/i.test(stderr)) return { reason: "It is protected by a password, so it is kept here but not searched." };
  if (code === 2) return { reason: "It looks empty or damaged, so it is kept here but not searched." };
  return { reason: "It could not be read, so it is kept here but not searched." };
}

async function run(reader: OfficeReader, args: string[], env: Record<string, string>) {
  return await runCommand(["python3", reader.script, ...args], { cwd: reader.cacheDir, timeoutMs: READ_MS, maxOutputBytes: 1_000_000, env });
}

/**
 * Sections read before for a file of another name, under this one's. The cache is kept by the file's bytes and a title by
 * its name: the same PDF added again as `SKT (2).pdf` was listed and searched as `pajak-SKT`, the name it had first been
 * read under (the owner's box, 2026-11-08). Every trail starts with the title it was read under.
 */
function renamed(sections: Section[], from: string, to: string): Section[] {
  if (from === to) return sections;
  return sections.map((section) => ({
    ...section,
    trail: section.trail === from ? to : section.trail.startsWith(`${from}${TRAIL_MARK}`) ? `${to}${section.trail.slice(from.length)}` : section.trail,
  }));
}

/** A file `doc.py` reads, read: from the cache when its bytes were read before. */
export async function readOffice(path: string, kind: "pages" | "text" | "book", title: string, reader: OfficeReader): Promise<OfficeRead> {
  ensureDir(reader.cacheDir);
  const hash = sha256File(path);
  const cached = hash ? join(reader.cacheDir, `${hash}.json`) : null;
  if (cached && statFile(cached)) {
    try {
      const read = JSON.parse(await readTextFile(cached)) as { version: number; title: string; sections: Section[] };
      if (read.version === CACHE_VERSION) return { kind: "read", title, sections: renamed(read.sections, read.title, title) };
    } catch {
      // A cache that cannot be read is read again from the file.
    }
  }
  const work = join(reader.cacheDir, `read-${randomHex(6)}`);
  ensureDir(work);
  try {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: work, HOME: work, LANG: "C.UTF-8" };
    let sections: Section[];
    if (kind === "book") {
      const result = await run(reader, ["extract", path, "--format", "csv"], env);
      if (result.exitCode !== 0) return { kind: "unreadable", title, ...reasonFrom(result.exitCode, result.stderr) };
      // `- <sheet> -> <file>` for each sheet written; a single sheet's line has no name before the arrow.
      sections = [];
      for (const line of result.stdout.split("\n")) {
        const match = /^- (.*?) -> (.+)$/.exec(line.trim());
        if (!match) continue;
        const sheet = match[1]!.trim();
        const part = sectionsOfTable(await readTextFile(match[2]!.trim()), sheet && !sheet.startsWith("/") ? `${title} › ${sheet}` : title);
        for (const section of part) sections.push({ ...section, n: sections.length });
      }
    } else {
      const out = join(work, kind === "pages" ? "text.txt" : "text.md");
      const result = await run(reader, ["extract", path, "--out", out], env);
      if (result.exitCode !== 0 || !statFile(out)) return { kind: "unreadable", title, ...reasonFrom(result.exitCode, result.stderr) };
      const text = (await readTextFile(out)).slice(0, TEXT_MAX);
      // Named by the file: an Office file's first heading is more often its first section than its title.
      sections = kind === "pages" ? sectionsOfPages(text, title) : sectionsOfText(text, title);
    }
    if (cached) await writeTextFileAtomic(cached, JSON.stringify({ version: CACHE_VERSION, title, sections }));
    return { kind: "read", title, sections };
  } catch (err) {
    // `python3` itself missing, where nothing wraps it and the start throws.
    if (/ENOENT|not found|No such file/i.test(String(err))) return { kind: "unreadable", title, ...NO_PYTHON };
    throw err;
  } finally {
    removePath(work);
  }
}
