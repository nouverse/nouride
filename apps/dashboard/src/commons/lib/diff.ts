/**
 * A line diff, as every diff the dashboard draws reads it (0.8.8, `DiffView`): a skill's draft against the skill on disk,
 * an approval's change to a file or a persona. Each drew its own, and the skill's ran its lines past the box that tinted
 * them — the text cut on the left, the colour stopping halfway along.
 */

/** One line: added, taken out, or the same in both. */
export interface DiffRow {
  sign: "+" | "-" | " ";
  text: string;
}

/**
 * Longest-common-subsequence over lines — quadratic, which is fine for what is diffed here: a skill that has to fit in a
 * system prompt, a hunk an approval shows. No dependency: one screen of code against a package every viewer downloads.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffRow[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ sign: " ", text: before[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ sign: "-", text: before[i]! });
      i += 1;
    } else {
      rows.push({ sign: "+", text: after[j]! });
      j += 1;
    }
  }
  while (i < before.length) rows.push({ sign: "-", text: before[i++]! });
  while (j < after.length) rows.push({ sign: "+", text: after[j++]! });
  return rows;
}

/** What a diff adds and takes out, for its "+3 −1". */
export function diffCounts(rows: readonly DiffRow[]): { added: number; removed: number } {
  return { added: rows.filter((row) => row.sign === "+").length, removed: rows.filter((row) => row.sign === "-").length };
}

/** A stretch of a diff as drawn: lines, or unchanged ones folded away between changes. */
export type DiffPiece = { kind: "rows"; rows: DiffRow[] } | { kind: "folded"; rows: DiffRow[] };

/**
 * The diff in pieces, unchanged runs longer than `context` lines on each side of a change folded: an improvement is
 * usually one added pitfall in a sixty-line file, and the reviewer should not have to find it among the fifty-nine that
 * stayed. A fold of fewer than three lines is drawn rather than hidden behind a press that saves nothing.
 */
export function diffPieces(rows: readonly DiffRow[], context = 3): DiffPiece[] {
  const changed = rows.map((row, index) => (row.sign === " " ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return rows.length > 0 ? [{ kind: "folded", rows: [...rows] }] : [];
  const near = (index: number) => changed.some((at) => Math.abs(at - index) <= context);
  const pieces: DiffPiece[] = [];
  let run: DiffRow[] = [];
  let runFolded = false;
  const flush = () => {
    if (run.length === 0) return;
    pieces.push(runFolded && run.length >= 3 ? { kind: "folded", rows: run } : { kind: "rows", rows: run });
    run = [];
  };
  rows.forEach((row, index) => {
    const folded = row.sign === " " && !near(index);
    if (folded !== runFolded) {
      flush();
      runFolded = folded;
    }
    run.push(row);
  });
  flush();
  // A short fold drawn as lines joins the lines beside it.
  return pieces.reduce<DiffPiece[]>((merged, piece) => {
    const last = merged.at(-1);
    if (last?.kind === "rows" && piece.kind === "rows") last.rows.push(...piece.rows);
    else merged.push(piece);
    return merged;
  }, []);
}
