/**
 * The roots a word may hide, in every language memory is searched in.
 *
 * One file per language, each a pure `(word) => roots` that never returns the word itself; this list
 * is the only place that knows which exist. A language is added by writing its file and naming it here:
 * the index and the query both read `rootsOf`, so they cannot disagree on which languages count.
 *
 * Every stemmer runs on every word — a word does not say which language it is in, and a root that
 * does not fit only adds a posting nobody asks for.
 *
 * Pure.
 */

import { indonesianRoots } from "./id.ts";

const STEMMERS: readonly ((word: string) => string[])[] = [indonesianRoots];

export function rootsOf(word: string): string[] {
  return [...new Set(STEMMERS.flatMap((roots) => roots(word)))];
}
