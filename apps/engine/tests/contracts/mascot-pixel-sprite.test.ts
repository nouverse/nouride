/**
 * The mascot's pixel sprite and the sheet of its moves stay one thing.
 *
 * `docs/design/mascot/pixel` holds a 32 pixel cat placed by hand, and the script that draws its moves into a sheet.
 * It waits there: no page draws it. Which is why nothing would say when it stops holding together:
 *
 * - the cat is rows of letters in the script, and the sheet is a picture: a row changed and the script not run again
 *   leaves a sheet of the cat as it was;
 * - whoever plays a move reads where it is from the JSON beside the sheet: a move that says more frames than its row
 *   holds plays empty cells.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const ROOT = join(import.meta.dir, "../../../..");
const HOME = join(ROOT, "docs/design/mascot/pixel");
const FILES = ["nouride-pixel.png", "nouride-pixel-32.png", "nouride-pixel.json"] as const;

type Picture = { width: number; height: number; rgba: Buffer };
type Sheet = { sheet: string; cell: number; cat: number; at: [number, number]; moves: Array<{ name: string; row: number; frames: number; fps: number }> };

/**
 * A PNG's pixels. Read here and compared as pixels, not as the file's bytes: how small the packing comes out is the
 * runtime's own affair, and another version of it may pack the same picture differently.
 */
function pixels(file: string): Picture {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  let at = 8;
  let head = Buffer.alloc(0);
  const packed: Buffer[] = [];
  while (at < bytes.length) {
    const size = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    const data = bytes.subarray(at + 8, at + 8 + size);
    if (type === "IHDR") head = data;
    if (type === "IDAT") packed.push(data);
    at += 12 + size;
  }
  const [width, height] = [head.readUInt32BE(0), head.readUInt32BE(4)];
  // Eight bits a channel, with alpha, and every line unfiltered: what the script writes.
  expect([head[8], head[9]]).toEqual([8, 6]);
  const lines = inflateSync(Buffer.concat(packed));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(lines[y * (width * 4 + 1)]).toBe(0);
    lines.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, rgba };
}

/** Whether a cell of the sheet has anything drawn in it. */
function drawn(sheet: Picture, cell: number, row: number, column: number): boolean {
  for (let y = row * cell; y < (row + 1) * cell; y++) {
    for (let x = column * cell; x < (column + 1) * cell; x++) if ((sheet.rgba[(y * sheet.width + x) * 4 + 3] as number) > 0) return true;
  }
  return false;
}

describe("the mascot's pixel sprite", () => {
  test("the sheet, the cat alone and the list of moves on disk are what the script writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mascot-pixel-"));
    try {
      const run = spawnSync(process.execPath, [join(HOME, "make-sprite.mjs"), `${dir}/`], { encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      for (const file of FILES.filter((name) => name.endsWith(".png"))) {
        const [kept, made] = [pixels(join(HOME, file)), pixels(join(dir, file))];
        expect({ file, width: kept.width, height: kept.height }).toEqual({ file, width: made.width, height: made.height });
        expect({ file, same: kept.rgba.equals(made.rgba) }).toEqual({ file, same: true });
      }
      expect(readFileSync(join(HOME, "nouride-pixel.json"), "utf8")).toBe(readFileSync(join(dir, "nouride-pixel.json"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every move the list names is a row of the sheet, with a cat in each of its frames and none after them", () => {
    const list = JSON.parse(readFileSync(join(HOME, "nouride-pixel.json"), "utf8")) as Sheet;
    const sheet = pixels(join(HOME, list.sheet));
    const across = sheet.width / list.cell;
    expect(list.moves.length).toBeGreaterThan(2);
    expect(sheet.height).toBe(list.moves.length * list.cell);
    expect(across).toBe(Math.max(...list.moves.map((move) => move.frames)));
    expect(list.moves.map((move) => move.row)).toEqual(list.moves.map((_, row) => row));
    for (const move of list.moves) {
      expect(move.fps).toBeGreaterThan(0);
      const cells = Array.from({ length: across }, (_, column) => drawn(sheet, list.cell, move.row, column));
      expect({ move: move.name, cells }).toEqual({ move: move.name, cells: cells.map((_, column) => column < move.frames) });
    }
  });

  test("the cat alone is the cat of the sheet's first frame, on its own grid", () => {
    const list = JSON.parse(readFileSync(join(HOME, "nouride-pixel.json"), "utf8")) as Sheet;
    const [sheet, alone] = [pixels(join(HOME, list.sheet)), pixels(join(HOME, "nouride-pixel-32.png"))];
    expect([alone.width, alone.height]).toEqual([list.cat, list.cat]);
    // The cell holds the grid whole, with room over it: a move may lift the cat, and its raised paw reaches past it.
    expect(list.at[0] + list.cat).toBeLessThanOrEqual(list.cell);
    expect(list.at[1] + list.cat).toBe(list.cell);
    const first = Buffer.alloc(list.cat * list.cat * 4);
    for (let y = 0; y < list.cat; y++) sheet.rgba.copy(first, y * list.cat * 4, ((list.at[1] + y) * sheet.width + list.at[0]) * 4, ((list.at[1] + y) * sheet.width + list.at[0] + list.cat) * 4);
    expect(alone.rgba.equals(first)).toBe(true);
  });
});
