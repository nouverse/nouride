/**
 * Words out of text, for both sides of a keyword search.
 *
 * FTS5 ranks (`memory-fts.store.ts`, TD-015); this decides what the words are. That has to be one
 * place, because a document and a query tokenised differently never meet: the index is written from
 * `ftsDoc` and searched with `ftsQuery`, and FTS5 only splits the space-separated words again.
 *
 * Tokens are lower case with diacritics folded (`kafé` → `kafe`), split on anything that is not a
 * letter or digit in any script, stop words out. No word is replaced by a stem: transcripts keep the
 * language they were spoken in, and Indonesian affixes (`berlibur` / `liburan`) defeat a stemmer built
 * for English. Instead a query word of four letters or more matches words it begins (`"word"*`), which
 * covers plurals and most suffixes of what was kept — and an English plural in the query is cut back
 * to its root first, so `laptops` finds `laptop`, and `batteries` finds `battery`. The Indonesian roots
 * a word's affixes hide (`stemmer/`) are indexed in a column of their own, weighted lower, and queried
 * beside the word, so `liburan` finds `berlibur`. Summaries and facts are written in English
 * (`pass-prompt.ts`), which is what makes that the one direction worth handling.
 *
 * Pure.
 */

import { rootsOf } from "./stemmer/index.ts";

/** Words that match everything and rank nothing, in the two languages memory is mostly written in. */
const STOP = new Set(
  (
    "the a an and or of to in on at for with is are was were be been it this that as by from not but " +
    "yang dan di ke dari ini itu untuk dengan ada tidak ya juga aja sih kok lah deh nih gak ga udah sudah " +
    "akan bisa atau pada karena jadi saya aku gw lu kamu dia mereka kita kami"
  ).split(" "),
);

export function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !STOP.has(token));
}

/**
 * An English plural's root, when cutting leaves enough to match as a prefix: `laptops` → `laptop`,
 * `boxes` → `box`… except a root under four letters, which would match too much, is left whole.
 */
function singular(word: string): string {
  const root = word.endsWith("ies")
    ? word.slice(0, -3)
    : /(?:ss|x|z|ch|sh)es$/.test(word)
      ? word.slice(0, -2)
      : /[^su]s$/.test(word) && !word.endsWith("is")
        ? word.slice(0, -1)
        : word;
  return root.length >= 4 ? root : word;
}

/** Query words, each once, plurals cut back to their root. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokens(query).map(singular))];
}

/**
 * Query words, each with the terms that stand for it: itself, and the Indonesian roots it may hide.
 * FTS5 adds up every phrase that matched, so a word found by its spelling and by its root counts twice —
 * the roots column's lower weight is what keeps that in proportion.
 */
function queryGroups(query: string): { word: string; terms: string[] }[] {
  return queryTerms(query).map((word) => ({ word, terms: [word, ...rootsOf(word)] }));
}

/** Whether a query word is matched as a prefix, not only whole. */
function matchesAsPrefix(term: string): boolean {
  return term.length >= 4;
}

/** What one item is searched by, column by column — `069_baseline.sql`. */
export interface FtsDoc {
  summary: string;
  tags: string;
  body: string;
  /** The Indonesian roots of every word above, each as often as the word that hid it. */
  roots: string;
}

declare const fts: unique symbol;

/**
 * An FTS5 MATCH expression only `ftsQuery` and `ftsExact` make: quoted words, nothing a person typed.
 *
 * A token is letters and digits only, so quoting it is complete — `AND`, `OR`, `NOT`, `NEAR`, a column
 * filter or a `^` can never arrive unquoted — and the store takes nothing but this type, so raw input
 * cannot reach `MATCH` without the compiler noticing.
 */
export type FtsQuery = string & { readonly [fts]: true };

const words = (text: string) => tokens(text).join(" ");

/** An item's text as the index holds it. */
export function ftsDoc(parts: { summary?: string; tags?: string; body?: string }): FtsDoc {
  const all = tokens(`${parts.summary ?? ""} ${parts.tags ?? ""} ${parts.body ?? ""}`);
  return { summary: words(parts.summary ?? ""), tags: words(parts.tags ?? ""), body: words(parts.body ?? ""), roots: all.flatMap(rootsOf).join(" ") };
}

/**
 * A search as FTS5 reads it, or null when it has no words: each query word — as a prefix from four
 * letters — or its roots. `liburan laptops` → `"liburan"* OR "libur" OR "laptop"*`.
 */
export function ftsQuery(query: string): FtsQuery | null {
  const parts = new Set(
    queryGroups(query).flatMap(({ word, terms }) => [matchesAsPrefix(word) ? `"${word}"*` : `"${word}"`, ...terms.slice(1).map((root) => `"${root}"`)]),
  );
  return parts.size ? ([...parts].join(" OR ") as FtsQuery) : null;
}

/** The words of `text` exactly as written — no plural cut, no prefix, no roots: a name, looked for as a name. */
export function ftsExact(text: string): FtsQuery | null {
  const parts = [...new Set(tokens(text))].map((word) => `"${word}"`);
  return parts.length ? (parts.join(" OR ") as FtsQuery) : null;
}

/**
 * How much of two facts' wording is shared (Jaccard over words). Two conversations restating one
 * fact land around 0.8 — the same camera, the same addresses, a corrected path — while two different
 * facts about one subject stay near 0.2 however alike their opening words.
 */
export const SAME_FACT = 0.6;

/** A text's words, each once — what two facts' wording is compared by. */
export const wordSet = (text: string): Set<string> => new Set(tokens(text));

export function sharedWords(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared;
}

/** `wordOverlap` of two word sets already read. */
export function overlapOf(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const shared = sharedWords(left, right);
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

export function wordOverlap(a: string, b: string): number {
  return overlapOf(wordSet(a), wordSet(b));
}
