/**
 * The word a person or an agent most likely meant, for "Did you mean" after a typo (0.8.23): `missions` for `mission`,
 * `knowlege` for `knowledge`, `lst` for `list`. A wrong word was answered with "Run `nouride help`" alone, and an
 * agent's `nouride` tool spent a turn reading the help to find the one letter.
 *
 * Pure.
 */

/** Edits between two words, a swap of two letters side by side counting as one (`agnet` is one from `agent`). */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * The one known word closest to `typed`, as `canonical` names it: within one edit for a word of up to six letters, two
 * for a longer one (two let `bogus` read as `logs`). None when nothing is that close, or when two that are not the same
 * thing are equally close, since a guess between them would send someone the wrong way as often as the right one; two
 * names of one thing (`secret`, `secrets`) are no choice.
 */
export function nearest(typed: string, known: readonly string[], canonical: (word: string) => string = (word) => word): string | null {
  const word = typed.toLowerCase();
  const most = word.length >= 7 ? 2 : 1;
  let best: string | null = null;
  let bestDistance = most + 1;
  let tied = false;
  for (const candidate of new Set(known)) {
    if (candidate === word) return null;
    const d = distance(word, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
      tied = false;
    } else if (d === bestDistance && best !== null && canonical(candidate) !== canonical(best)) tied = true;
  }
  return best !== null && !tied ? canonical(best) : null;
}
