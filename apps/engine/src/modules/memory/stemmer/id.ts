/**
 * Indonesian roots for keyword search, one of the languages in `index.ts`.
 *
 * Prefix matching finds `liburan` from `libur`, but never `berlibur`: the word begins with its prefix.
 * Without semantic search that was the one gap left for a household that speaks Indonesian, so each
 * word also yields the roots its affixes hide, and those are indexed and queried beside the word itself.
 *
 * Dictionary-free, so it is not always right — `meminta` yields both `minta` and `pinta`, since a nasal
 * prefix hides which letter it replaced. It only has to be the same on both sides: a query and a
 * document that share a root meet, and a wrong extra root only adds a posting nobody asks for. The
 * word as written is always kept, so nothing that matched before stops matching, and English text
 * yields at most a few such harmless extras.
 *
 * Pure.
 */

/** What a root must keep, so a cut never leaves a stub that matches everything. */
const MIN_ROOT = 4;

const PARTICLES = ["nya", "lah", "kah", "pun"];
const SUFFIXES = ["kan", "an", "i"];
/** Longest first: `memper` before `mem`, `meng` before `men`. */
const PREFIXES = ["memper", "diper", "meng", "meny", "peng", "peny", "mem", "men", "pem", "pen", "ber", "ter", "per", "me", "pe", "di", "ke", "se"];
/** The letter a nasal prefix swallowed before a vowel: `menulis` ← `tulis`, `memakai` ← `pakai`. */
const NASAL: Record<string, string[]> = { meng: ["k", ""], peng: ["k", ""], meny: ["s"], peny: ["s"], mem: ["p", "m"], pem: ["p", "m"], men: ["t", "n"], pen: ["t", "n"] };
const VOWEL = /^[aiueo]/;
/** `me-` alone comes before these: `melihat`, `merasa`, `mewarnai`. */
const BARE_ME = /^[lrwy]/;
/** `pe-` alone comes before a consonant: `pekerja`, `petani`, `pelari`. */
const BARE_PE = /^[^aiueo]/;

function withoutPrefix(word: string): string[] {
  const out: string[] = [];
  for (const prefix of PREFIXES) {
    if (!word.startsWith(prefix)) continue;
    const rest = word.slice(prefix.length);
    if (prefix === "me" && !BARE_ME.test(rest)) continue;
    if (prefix === "pe" && !BARE_PE.test(rest)) continue;
    const swallowed = NASAL[prefix];
    if (swallowed && VOWEL.test(rest)) out.push(...swallowed.map((letter) => letter + rest));
    else out.push(rest);
    break;
  }
  return out;
}

function withoutSuffix(word: string, list: readonly string[]): string[] {
  const suffix = list.find((end) => word.endsWith(end) && word.length - end.length >= MIN_ROOT);
  return suffix ? [word.slice(0, -suffix.length)] : [];
}

/** The roots a word's affixes may hide, each at least four letters, never the word itself. */
export function indonesianRoots(word: string): string[] {
  const bases = [word, ...withoutSuffix(word, PARTICLES)];
  const stems = bases.flatMap((base) => [base, ...withoutSuffix(base, SUFFIXES)]);
  const roots = stems.flatMap((stem) => [stem, ...withoutPrefix(stem)]);
  return [...new Set(roots)].filter((root) => root !== word && root.length >= MIN_ROOT);
}
