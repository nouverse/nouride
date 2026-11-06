/**
 * A cat, put together (0.8.1): its look and a pose in, a 32×32 grid of colours out — the parts of `art/cat.ts` laid in
 * order, each symbol read through the look's palettes. Pure, so a pose is tested as the grid it gives, and the canvas
 * only copies it.
 */

import { ACCESSORIES, BODIES, BODY_AT, COLORS, COMMON, EYES, EYES_AT, FURS, HATS, HEAD, HEAD_AT, OUTFITS, RAISED_ARM, TAIL } from "./art";
import type { Look } from "./look";

export type Pose = "stand" | "step" | "sit" | "wave" | "sleep";
/** A colour per pixel, `null` for none. */
export type Grid = (string | null)[][];

export const FRAME = 32;

export function compose(look: Look, pose: Pose, blink = false): Grid {
  const grid: Grid = Array.from({ length: FRAME }, () => Array<string | null>(FRAME).fill(null));
  const palette: Record<string, string> = { ...COMMON, ...FURS[look.fur], ...COLORS[look.outfitColor] };
  // A plain coat's stripes are its fur.
  if (look.pattern === "plain") palette.t = palette.F!;
  const outfit = look.outfit === "none" ? null : OUTFITS[look.outfit];
  const put = (x: number, y: number, symbol: string) => {
    if (x < 0 || y < 0 || x >= FRAME || y >= FRAME || symbol === ".") return;
    grid[y]![x] = palette[symbol] ?? null;
  };
  const lay = (at: { x: number; y: number }, rows: readonly string[], as: (symbol: string, x: number, y: number) => string = (symbol) => symbol) => {
    rows.forEach((row, y) => [...row].forEach((symbol, x) => put(at.x + x, at.y + y, symbol === "." ? "." : as(symbol, x, y))));
  };

  if (pose !== "sleep") {
    if (pose !== "sit") lay(TAIL.at, TAIL.rows);
    // What an outfit covers becomes its colour; the rest stays fur, shaded where it meets the outline.
    const body = BODIES[pose];
    const covered = (symbol: string, row: number): string => {
      if (symbol === "B") return outfit?.torso ? "O" : "F";
      if (symbol === "A") return outfit && row <= outfit.sleeves ? "O" : "F";
      if (symbol === "m") return !outfit ? "m" : outfit.belly === "outfit" ? "O" : outfit.belly === "shirt" ? "w" : "m";
      return symbol;
    };
    lay(BODY_AT, body, (symbol, x, y) => shaded(covered(symbol, y), body[y]!, x));
    if (outfit) {
      for (const { x, y, c } of outfit.details) {
        const cell = body[y]?.[x];
        if (cell === "B" || cell === "m" || cell === "A") put(BODY_AT.x + x, BODY_AT.y + y, c);
      }
    }
    if (pose === "wave") lay(RAISED_ARM.at, RAISED_ARM.rows, (symbol) => (symbol === "A" ? (outfit && outfit.sleeves > 2 ? "O" : "F") : symbol));
  }

  lay(HEAD_AT, HEAD, (symbol) => (symbol === "E" ? "F" : symbol));
  const eyes = EYES[pose === "sleep" || blink ? "closed" : look.eyes];
  lay({ x: HEAD_AT.x + EYES_AT[0].x, y: HEAD_AT.y + EYES_AT[0].y }, eyes);
  lay({ x: HEAD_AT.x + EYES_AT[1].x, y: HEAD_AT.y + EYES_AT[1].y }, eyes.map((row) => [...row].reverse().join("")));

  if (look.hat !== "none") {
    const hat = HATS[look.hat];
    lay({ x: HEAD_AT.x + hat.at.x, y: HEAD_AT.y + hat.at.y }, hat.rows);
  }
  if (look.accessory !== "none") {
    const accessory = ACCESSORIES[look.accessory];
    // Under the covers, a scarf is not seen.
    if (accessory.on === "head") lay({ x: HEAD_AT.x + accessory.at.x, y: HEAD_AT.y + accessory.at.y }, accessory.rows);
    else if (pose !== "sleep") lay({ x: BODY_AT.x + accessory.at.x, y: BODY_AT.y + accessory.at.y }, accessory.rows);
  }
  return grid;
}

/** A body cell's shade: darker against the outline on its right, lighter against it on its left. */
function shaded(symbol: string, row: string, x: number): string {
  if (symbol !== "F" && symbol !== "O") return symbol;
  const light = symbol === "F" ? "h" : "l";
  const shade = symbol === "F" ? "f" : "q";
  if (row[x + 1] === "o") return shade;
  if (row[x - 1] === "o") return light;
  return symbol;
}
