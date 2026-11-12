#!/usr/bin/env bun
/**
 * The Nouride cat as a small pixel sprite that can be drawn in any pose: its pixels, its moves, and the sheet of them.
 *
 *     bun make-sprite.mjs [output directory]
 *
 * The painted poses are one picture each: a move they do not hold needs a new painting. This cat is 32 pixels a
 * side and placed by hand, so a new move is a few rows of letters. It keeps what makes the mascot itself: the helmet
 * with its letter, the lavender sunglasses, the hoodie, the tail with a white tip. It does not keep the painting.
 *
 * The cat is drawn in parts (head, torso, legs, tail, a raised arm), each a list of rows on the 32 grid. A frame says
 * which variant of each part and how many pixels it is moved; a move is a list of frames. Parts are only ever moved by
 * whole pixels: turning or scaling a pixel drawing breaks its grid.
 *
 * It writes `nouride-pixel.png`, every move a row of 48 pixel cells (the cat stands at the foot of a cell, with room
 * over it to hop and beside it to wave), `nouride-pixel-32.png`, the cat alone, and `nouride-pixel.json`, which says
 * what is in the sheet. It needs nothing installed: the PNG is written here.
 */

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = process.argv[2] ?? new URL(".", import.meta.url).pathname;

/** The colours, one letter each: the painted cat's own. A dot is nothing. */
const PALETTE = {
  K: [40, 31, 46], // outline
  H: [72, 70, 82], // helmet, pants, the tail's dark
  h: [104, 100, 118], // the helmet's rim
  W: [252, 248, 244], // fur, the letter
  w: [222, 213, 216], // fur in shade
  P: [150, 133, 200], // hoodie
  p: [118, 104, 162], // hoodie in shade
  L: [56, 48, 72], // lens
  l: [150, 140, 182], // the light on a lens
  E: [236, 140, 132], // inside an ear, the nose, a paw's pad
  O: [240, 150, 110], // the helmet's stripe, the hoodie's strings, the marks beside a wave
};

/** The cat's grid, and the cell a frame is drawn in: the grid's left top corner is at `AT` in the cell. */
const GRID = 32;
const CELL = 48;
const AT = [8, 16];

/** Whole rows of the grid, from row `y` down, as a part. */
const rows = (y, lines) => lines.map((line, i) => [y + i, 0, line]);
/** A part with left and right changed over. */
const mirrored = (part) => part.map(([y, x, line]) => [y, GRID - x - line.length, [...line].reverse().join("")]);

const HEAD = rows(1, [
  "......K..................K......",
  ".....KEK................KEK.....",
  ".....KEEK..KKKKKKKKKK..KEEK.....",
  "....KHEEHKKHHHHHHHHHHKKHEEHK....",
  "....KHHEHHHHHHWHHWHHHHHHEHHK....",
  "...KHOHHHHHHHHWWHWHHHHHHHHHHK...",
  "...KHOHHHHHHHHWHWWHHHHHHHHHHK...",
  "...KHOHHHHHHHHWHHWHHHHHHHHHHK...",
  "...KHHHHHHHHHHHHHHHHHHHHHHHHK...",
  "...KhhhhhhhhhhhhhhhhhhhhhhhhK...",
  "...KHKLllLLLLKWWWWKLllLLLLKHK...",
  "...KHKLLllLLLKWWWWKLLllLLLKHK...",
  "...KHKLLLLLLLKKKKKKLLLLLLLKHK...",
  "...KHKKLLLLLKKWWWWKKLLLLLKKHK...",
  "...KHHKKKKKKKWWEEWWKKKKKKKHHK...",
  "....KHWWWWWWWWWWWWWWWWWWWWHK....",
  ".....KWWWWWWWWKWWKWWWWWWWWK.....",
  "......KwWWWWWWWKKWWWWWWWwK......",
  ".......KKwWWWWWWWWWWWWwKK.......",
]);

const TORSO = {
  // Both paws at its sides.
  down: rows(20, [
    "........KPKKKKKKKKKKKKPK........",
    ".......KPPPPPKwwwwKPPPPPK.......",
    "......KPPPPPPPKwwKPPPPPPPK......",
    "......KPPPPPOPPKKPPOPPPPPK......",
    "......KPPpPPOPPPPPPOPPpPPK......",
    "......KWWpPPPPPPPPPPPPpWWK......",
    ".......KKKppppppppppppKKK.......",
  ]),
  // The viewer's right paw is up: the sleeve goes on in `ARM`.
  waving: rows(20, [
    "........KPKKKKKKKKKKKKPK........",
    ".......KPPPPPKwwwwKPPPPPK.......",
    "......KPPPPPPPKwwKPPPPPPPK......",
    "......KPPPPPOPPKKPPOPPPPPK......",
    "......KPPpPPOPPPPPPOPPpPPK......",
    "......KWWpPPPPPPPPPPPPpPK.......",
    ".......KKKppppppppppppKK........",
  ]),
};

const STEP = rows(27, [
  ".........KHHHHHHHHHHHHK.........",
  "........KWWWWWKKKHHHHHK.........",
  ".........KKKKK...KWWWWWK........",
  "..................KKKKK.........",
]);
const LEGS = {
  stand: rows(27, [
    ".........KHHHHHHHHHHHHK.........",
    ".........KHHHHHKKHHHHHK.........",
    "........KWWWWWK..KWWWWWK........",
    ".........KKKKK....KKKKK.........",
  ]),
  // One foot off the ground: the viewer's left, then the right.
  stepLeft: STEP,
  stepRight: mirrored(STEP),
  // Bent, a row shorter: the torso and head come down a pixel on to it.
  crouch: rows(28, [
    ".........KHHHHHKKHHHHHK.........",
    ".......KWWWWWWK..KWWWWWWK.......",
    "........KKKKKK....KKKKKK........",
  ]),
  // In the air, feet together.
  air: rows(27, [
    ".........KHHHHHHHHHHHHK.........",
    "..........KHHHHKKHHHHK..........",
    "..........KWWWWKKWWWWK..........",
    "...........KKKK..KKKK...........",
  ]),
};

/** The tail, behind the body: each row is where it is and what it holds. Its tip goes up and down, the root stays. */
const TAIL = {
  mid: [[19, 2, "KK"], [20, 1, "KWWK"], [21, 1, "KWWWK"], [22, 2, "KHWK"], [23, 2, "KHHK"], [24, 3, "KHH"], [25, 4, "KH"], [26, 5, "K"]],
  up: [[18, 2, "KK"], [19, 1, "KWWK"], [20, 1, "KWWWK"], [21, 2, "KHWK"], [22, 2, "KHHK"], [23, 2, "KHHK"], [24, 3, "KHH"], [25, 4, "KH"], [26, 5, "K"]],
  down: [[20, 1, "KK"], [21, 0, "KWWK"], [22, 0, "KWWWK"], [23, 1, "KHWK"], [24, 2, "KHHK"], [25, 3, "KHH"], [26, 4, "KK"]],
};

/** The raised arm and its paw, beside the cheek: held up, and reaching out a pixel further. */
const SLEEVE = [[21, 25, "PPPK"], [22, 25, "PPK"], [23, 26, "K"]];
const ARM = {
  up: [[15, 28, "KKK"], [16, 27, "KWWWK"], [17, 27, "KWEWK"], [18, 27, "KWWWK"], [19, 26, "KPPPK"], [20, 25, "KPPPK"], ...SLEEVE],
  out: [[14, 29, "KKK"], [15, 28, "KWWWK"], [16, 28, "KWEWK"], [17, 28, "KWWWK"], [18, 27, "KPPPK"], [19, 26, "KPPPK"], [20, 25, "KPPPK"], ...SLEEVE],
};
/** The marks beside a waving paw. */
const SPARKS = [[12, 33, "O"], [13, 34, "O"], [16, 35, "OO"], [19, 34, "O"], [20, 33, "O"]];

/**
 * The moves. A frame names a variant of each part; `lift` raises the whole cat, `bob` lowers its head, `lean` moves
 * its head sideways, `sit` lowers its head and torso on to bent legs. `fps` is how fast the frames follow each other.
 */
const still = { torso: "down", legs: "stand", tail: "mid" };
const MOVES = [
  { name: "idle", fps: 4, frames: [still, { ...still, tail: "up", bob: 1 }, still, { ...still, tail: "down", bob: 1 }] },
  {
    name: "walk", fps: 8,
    frames: [{ ...still, legs: "stepLeft", lean: -1, tail: "up" }, { ...still, lift: 1 }, { ...still, legs: "stepRight", lean: 1, tail: "down" }, { ...still, lift: 1 }],
  },
  {
    name: "wave", fps: 6,
    frames: [{ ...still, torso: "waving", arm: "up" }, { ...still, torso: "waving", arm: "out", sparks: true, tail: "up" }, { ...still, torso: "waving", arm: "up" }, { ...still, torso: "waving", arm: "out", sparks: true, tail: "up" }],
  },
  {
    name: "hop", fps: 10,
    frames: [
      { ...still, legs: "crouch", sit: 1, tail: "down" },
      { ...still, legs: "air", lift: 6, tail: "down" },
      { ...still, legs: "air", lift: 11, tail: "up" },
      { ...still, legs: "air", lift: 12, tail: "up" },
      { ...still, legs: "air", lift: 6, tail: "up" },
      { ...still, legs: "crouch", sit: 1, tail: "mid" },
    ],
  },
];

for (const part of [HEAD, ...Object.values(TORSO), ...Object.values(LEGS)]) {
  for (const [y, , line] of part) if (line.length !== GRID) throw new Error(`row ${y} is ${line.length} wide, not ${GRID}: ${line}`);
}

/** A part's pixels into a cell's buffer, moved by `dx` and `dy`. */
function paint(cell, part, dx = 0, dy = 0) {
  for (const [y, x, line] of part) {
    for (let i = 0; i < line.length; i++) {
      const colour = PALETTE[line[i]];
      if (!colour) continue;
      const [px, py] = [AT[0] + x + i + dx, AT[1] + y + dy];
      if (px < 0 || py < 0 || px >= CELL || py >= CELL) throw new Error(`a pixel at ${px},${py} is off the cell`);
      cell.set([...colour, 255], (py * CELL + px) * 4);
    }
  }
}

/** One frame, drawn back to front. */
function draw(frame) {
  const cell = Buffer.alloc(CELL * CELL * 4);
  const up = -(frame.lift ?? 0);
  const sit = frame.sit ?? 0;
  paint(cell, TAIL[frame.tail], 0, up + sit);
  paint(cell, LEGS[frame.legs], 0, up);
  paint(cell, TORSO[frame.torso], 0, up + sit);
  paint(cell, HEAD, frame.lean ?? 0, up + sit + (frame.bob ?? 0));
  if (frame.arm) paint(cell, ARM[frame.arm], 0, up + sit);
  if (frame.sparks) paint(cell, SPARKS, 0, up + sit);
  return cell;
}

// ── A PNG, written here so the script needs nothing installed ───────────────────────────────────────────────────────

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  let c = 0xffffffff;
  for (const byte of body) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32BE(data.length, 0);
  sizes.writeUInt32BE((c ^ 0xffffffff) >>> 0, 4);
  return Buffer.concat([sizes.subarray(0, 4), body, sizes.subarray(4)]);
}
function png(rgba, width, height) {
  const lines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(lines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(lines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ── The sheet: a move a row, a frame a cell ─────────────────────────────────────────────────────────────────────────

const across = Math.max(...MOVES.map((move) => move.frames.length));
const sheet = Buffer.alloc(across * CELL * MOVES.length * CELL * 4);
for (const [row, move] of MOVES.entries()) {
  for (const [column, frame] of move.frames.entries()) {
    const cell = draw(frame);
    for (let y = 0; y < CELL; y++) cell.copy(sheet, ((row * CELL + y) * across * CELL + column * CELL) * 4, y * CELL * 4, (y + 1) * CELL * 4);
  }
}
writeFileSync(`${OUT}nouride-pixel.png`, png(sheet, across * CELL, MOVES.length * CELL));

const alone = Buffer.alloc(GRID * GRID * 4);
const standing = draw(still);
for (let y = 0; y < GRID; y++) standing.copy(alone, y * GRID * 4, ((AT[1] + y) * CELL + AT[0]) * 4, ((AT[1] + y) * CELL + AT[0] + GRID) * 4);
writeFileSync(`${OUT}nouride-pixel-32.png`, png(alone, GRID, GRID));

writeFileSync(
  `${OUT}nouride-pixel.json`,
  `${JSON.stringify({ sheet: "nouride-pixel.png", cell: CELL, cat: GRID, at: AT, moves: MOVES.map((move, row) => ({ name: move.name, row, frames: move.frames.length, fps: move.fps })) }, null, 2)}\n`,
);
console.log(`${MOVES.length} moves, ${MOVES.reduce((sum, move) => sum + move.frames.length, 0)} frames, a sheet of ${across * CELL} x ${MOVES.length * CELL}`);
