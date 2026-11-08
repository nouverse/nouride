/**
 * The words in a knowledge document, by its kind (KNOWLEDGE_BASE §6, 0.8.20).
 *
 * Text, Markdown, tables and web pages are read here; PDF and Office files by `doc.py` (`office.ts`). A kind Nouride does
 * not read (a picture, a video) is listed and not searched, and says so in a sentence a person reads; the folder keeps
 * the file as it was.
 */

import { basename, extname, readTextFile } from "@nouride/runtime";
import { officeKind, readOffice, type OfficeReader } from "./office.ts";
import { normalizeTags } from "../tags.ts";
import { sectionsOfTable, sectionsOfText, tagsOf, titleOf, type Section } from "./sections.ts";

/** A file larger than this is listed, not read: past it, a document is an archive, not a reference. */
const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Sections searched of one file; the rest of a longer one is not. */
const SECTIONS_MAX = 2_000;

export type Extracted =
  | { kind: "read"; title: string; sections: Section[]; note?: string; tags?: string[] }
  /** Kept and shown, not searched, and why, for a person; `needs`, the program that would read it, when one is missing. */
  | { kind: "listed" | "unreadable"; title: string; reason: string; needs?: string };

const name = (path: string) => basename(path, extname(path));

/** A web page's words, its headings kept as Markdown's so they still cut the sections. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The sections of one file, at most `SECTIONS_MAX`, and what a person is told of the rest. */
function capped(title: string, sections: Section[]): Extracted {
  // A scanned PDF reads without an error and without a word: it was "indexed" with nothing in it, and the agent that kept
  // it was told it could be searched now. It is said instead, as any file that is kept and not searched is.
  if (sections.length === 0) return { kind: "unreadable", title, reason: "It has no text to search, as a scanned page has none, so it is kept here but not searched." };
  if (sections.length <= SECTIONS_MAX) return { kind: "read", title, sections };
  return { kind: "read", title, sections: sections.slice(0, SECTIONS_MAX), note: `Only its first ${SECTIONS_MAX.toLocaleString("en")} sections are searched.` };
}

/** Tags a document carries at most: the graph's lines to them, not its subject index. */
const TAGS_MAX = 8;

/** A read with its frontmatter's tags, folded as memory folds a conversation's (no aliases: those are the vault's). */
function tagged(read: Extracted, raw: readonly string[]): Extracted {
  const tags = normalizeTags(raw, new Map()).slice(0, TAGS_MAX);
  return read.kind === "read" && tags.length ? { ...read, tags } : read;
}

/** What a file says, by its kind. `size` is its size in bytes, as stat saw it; `office`, where `doc.py` is. */
export async function extract(path: string, size: number, office?: OfficeReader): Promise<Extracted> {
  const title = name(path);
  if (size > FILE_MAX_BYTES) return { kind: "unreadable", title, reason: "It is larger than 50 MB, so it is kept here but not searched." };
  const kind = extname(path).toLowerCase();
  const byDocPy = officeKind(kind);
  if (byDocPy && office) {
    const read = await readOffice(path, byDocPy, title, office);
    return read.kind === "read" ? capped(read.title, read.sections) : read;
  }
  switch (kind) {
    case ".md":
    case ".markdown":
    case ".txt":
    case ".text": {
      const text = await readTextFile(path);
      const named = titleOf(text, title);
      return tagged(capped(named, sectionsOfText(text, named)), tagsOf(text));
    }
    case ".json":
      return capped(title, sectionsOfText(await readTextFile(path), title));
    case ".csv":
    case ".tsv":
      return capped(title, sectionsOfTable(await readTextFile(path), title));
    case ".html":
    case ".htm": {
      const text = htmlText(await readTextFile(path));
      const named = titleOf(text, title);
      return capped(named, sectionsOfText(text, named));
    }
    default:
      return { kind: "listed", title, reason: "Nouride does not read this kind of file, so it is kept here but not searched." };
  }
}
