/**
 * The Office's signs (0.8.1): words and numbers in 5×7 pixel letters on a board, as a pixel map like the furniture's.
 * Only the letters a sign here spells are drawn; a word with another letter is refused, so a sign never shows a gap.
 *
 * Symbols: `.` nothing · `o` the board's frame · `B` the board · `T` a letter.
 */

const GLYPHS: Record<string, string[]> = {
  N: ["T...T", "TT..T", "T.T.T", "T..TT", "T...T", "T...T", "T...T"],
  O: [".TTT.", "T...T", "T...T", "T...T", "T...T", "T...T", ".TTT."],
  U: ["T...T", "T...T", "T...T", "T...T", "T...T", "T...T", ".TTT."],
  R: ["TTTT.", "T...T", "T...T", "TTTT.", "T.T..", "T..T.", "T...T"],
  I: ["TTT", ".T.", ".T.", ".T.", ".T.", ".T.", "TTT"],
  D: ["TTTT.", "T...T", "T...T", "T...T", "T...T", "T...T", "TTTT."],
  E: ["TTTTT", "T....", "T....", "TTTT.", "T....", "T....", "TTTTT"],
  F: ["TTTTT", "T....", "T....", "TTTT.", "T....", "T....", "T...."],
  C: [".TTT.", "T...T", "T....", "T....", "T....", "T...T", ".TTT."],
  " ": ["...", "...", "...", "...", "...", "...", "..."],
  "+": [".....", "..T..", "..T..", "TTTTT", "..T..", "..T..", "....."],
  "0": [".TTT.", "T...T", "T..TT", "T.T.T", "TT..T", "T...T", ".TTT."],
  "1": ["..T..", ".TT..", "..T..", "..T..", "..T..", "..T..", ".TTT."],
  "2": [".TTT.", "T...T", "....T", "...T.", "..T..", ".T...", "TTTTT"],
  "3": ["TTTT.", "....T", "....T", ".TTT.", "....T", "....T", "TTTT."],
  "4": ["...T.", "..TT.", ".T.T.", "T..T.", "TTTTT", "...T.", "...T."],
  "5": ["TTTTT", "T....", "TTTT.", "....T", "....T", "T...T", ".TTT."],
  "6": ["..TT.", ".T...", "T....", "TTTT.", "T...T", "T...T", ".TTT."],
  "7": ["TTTTT", "....T", "...T.", "..T..", ".T...", ".T...", ".T..."],
  "8": [".TTT.", "T...T", "T...T", ".TTT.", "T...T", "T...T", ".TTT."],
  "9": [".TTT.", "T...T", "T...T", ".TTTT", "....T", "...T.", ".TT.."],
};

/** The words as seven rows of letters, a column between each. */
export function lettering(words: string): string[] {
  const glyphs = [...words.toUpperCase()].map((letter) => {
    const glyph = GLYPHS[letter];
    if (!glyph) throw new Error(`the Office's sign has no letter "${letter}"`);
    return glyph;
  });
  return Array.from({ length: 7 }, (_, y) => glyphs.map((glyph) => glyph[y]).join("."));
}

/** The words on a board: a frame, a margin of board, the letters. */
export function sign(words: string): string[] {
  const text = lettering(words);
  const width = text[0]!.length + 6;
  const edge = "o".repeat(width);
  const blank = `o${"B".repeat(width - 2)}o`;
  return [edge, blank, blank, ...text.map((line) => `oBB${line.replaceAll(".", "B")}BBo`), blank, blank, edge];
}
