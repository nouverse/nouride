#!/usr/bin/env bun
/**
 * Cut the landing page's moving cat out of its drawn sheets.
 *
 *     bun run apps/site/scripts/cut-mascot-motion.ts [output directory]
 *
 * Three sheets in `docs/design/mascot/grids`, each drawn on white, become three transparent files in
 * `packages/shared/assets/mascot/motion`: `hero.webp` (the cat on its scooter, large), `idle.webp` (four frames
 * standing, side by side) and `ride.webp` (six frames riding, side by side). A strip's frames share one cell size and
 * one anchor, so a page steps through them by moving the background and the cat stays put.
 *
 * It lives here for the reason `crop-mascot-sheet.ts` does: `sharp` is installed with Astro, under `apps/site`.
 *
 * ## Why not key the white out by colour
 *
 * The cat's face, paws and scooter are white too. So white is background only where it can be reached from the
 * sheet's edge without crossing the dark outline, which is drawn closed around every figure. None of these three
 * sheets has a pocket of background the outline closes off; one that does would keep it white, and show it.
 *
 * The outline's soft edge is a blend of ink and white. Left as drawn it is a pale fringe on a dark page, so each
 * reached pixel gets the alpha that blend implies and its colour with the white taken back out.
 */

import sharp from "sharp";

// The repository root, from where this file is: apps/site/scripts/.
const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const SHEETS = `${ROOT}/docs/design/mascot/grids`;
const OUT = process.argv[2] ?? `${ROOT}/packages/shared/assets/mascot/motion`;

/** A pixel this light or lighter (its darkest channel) can be background or the edge of an outline. */
const REACH = 120;
/** The outline's ink, by its darkest channel: where the blend toward white started. */
const INK = 45;
/** Alpha below this is JPEG noise on the white, not an edge. */
const NOISE = 0.06;
type Cut = { rgba: Buffer; width: number; height: number };
type Box = { x0: number; y0: number; x1: number; y1: number };

/** The sheet with its background made transparent. */
async function cut(file: string): Promise<Cut> {
  const { data, info } = await sharp(`${SHEETS}/${file}`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const light = (p: number) => Math.min(data[p * 3] as number, data[p * 3 + 1] as number, data[p * 3 + 2] as number);

  // What the edge of the sheet reaches through light pixels.
  const reached = new Uint8Array(W * H);
  const stack: number[] = [];
  const visit = (p: number) => {
    if (reached[p] || light(p) < REACH) return;
    reached[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < W; x++) { visit(x); visit((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { visit(y * W); visit(y * W + W - 1); }
  const spread = () => {
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % W;
      if (x > 0) visit(p - 1);
      if (x < W - 1) visit(p + 1);
      if (p >= W) visit(p - W);
      if (p < W * (H - 1)) visit(p + W);
    }
  };
  spread();

  const rgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    let alpha = 1;
    if (reached[p]) {
      alpha = Math.min(1, (255 - light(p)) / (255 - INK));
      if (alpha < NOISE) alpha = 0;
    }
    for (let c = 0; c < 3; c++) {
      const drawn = data[p * 3 + c] as number;
      // drawn = alpha * colour + (1 - alpha) * 255, solved for the colour.
      rgba[p * 4 + c] = alpha === 0 ? 0 : Math.max(0, Math.min(255, Math.round((drawn - (1 - alpha) * 255) / alpha)));
    }
    rgba[p * 4 + 3] = Math.round(alpha * 255);
  }
  return { rgba, width: W, height: H };
}

/** The runs of rows (or columns) inside `box` that hold anything: a sheet's figures, apart along one axis. */
function runs(img: Cut, box: Box, axis: "x" | "y"): Array<[number, number]> {
  const [from, to] = axis === "x" ? [box.x0, box.x1] : [box.y0, box.y1];
  const filled = (i: number) => {
    const [a0, a1] = axis === "x" ? [box.y0, box.y1] : [box.x0, box.x1];
    for (let j = a0; j <= a1; j++) {
      const p = axis === "x" ? j * img.width + i : i * img.width + j;
      if ((img.rgba[p * 4 + 3] as number) > 40) return true;
    }
    return false;
  };
  const found: Array<[number, number]> = [];
  let start = -1;
  for (let i = from; i <= to + 1; i++) {
    const on = i <= to && filled(i);
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      // A speck of compression noise is not a figure.
      if (i - start > 40) found.push([start, i - 1]);
      start = -1;
    }
  }
  return found;
}

const whole = (img: Cut): Box => ({ x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 });

/** Every figure's box, reading order: rows first, then each row's columns, each trimmed to its own height. */
function figures(img: Cut): Box[] {
  return runs(img, whole(img), "y").flatMap(([y0, y1]) =>
    runs(img, { ...whole(img), y0, y1 }, "x").map(([x0, x1]) => {
      const [own] = runs(img, { x0, x1, y0, y1 }, "y");
      return { x0, x1, y0: own?.[0] ?? y0, y1: own?.[1] ?? y1 };
    }),
  );
}

const extract = (img: Cut, b: Box) =>
  sharp(img.rgba, { raw: { width: img.width, height: img.height, channels: 4 } }).extract({
    left: b.x0,
    top: b.y0,
    width: b.x1 - b.x0 + 1,
    height: b.y1 - b.y0 + 1,
  });

/**
 * Frames side by side, every one `cell` tall, standing on the same line.
 *
 * `anchor` says which side of a frame holds still from one to the next: the scooter's front for the ride (the tail
 * behind it sways), the feet's middle for the cat standing (its tail swings out to the left).
 */
async function strip(img: Cut, boxes: Box[], cell: number, anchor: "right" | "feet", out: string) {
  const tallest = Math.max(...boxes.map((b) => b.y1 - b.y0 + 1));
  const scale = cell / tallest;
  const frames = await Promise.all(
    boxes.map(async (b) => {
      const w = Math.round((b.x1 - b.x0 + 1) * scale);
      const h = Math.round((b.y1 - b.y0 + 1) * scale);
      let hold = w;
      if (anchor === "feet") {
        const [feet] = runs(img, { ...b, y0: b.y1 - Math.round((b.y1 - b.y0) * 0.06) }, "x").slice(-1);
        hold = Math.round((((feet?.[0] ?? b.x0) + (feet?.[1] ?? b.x1)) / 2 - b.x0) * scale);
      }
      return { w, h, hold, png: await extract(img, b).resize(w, h).png().toBuffer() };
    }),
  );
  const left = Math.max(...frames.map((f) => f.hold));
  const right = Math.max(...frames.map((f) => f.w - f.hold));
  const width = left + right;
  await sharp({ create: { width: width * frames.length, height: cell, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(frames.map((f, i) => ({ input: f.png, left: i * width + left - f.hold, top: cell - f.h })))
    .webp({ quality: 88, alphaQuality: 95 })
    .toFile(out);
  console.log(`  ${out.split("/").pop()}  ${frames.length} frames of ${width}x${cell}`);
}

const hero = await cut("nouride-hero.jpeg");
const [heroBox] = figures(hero);
if (!heroBox) throw new Error("nouride-hero.jpeg: no figure found on the sheet");
await extract(hero, heroBox).resize({ width: 1100 }).webp({ quality: 90, alphaQuality: 95 }).toFile(`${OUT}/hero.webp`);
console.log("  hero.webp");

const idle = await cut("nouride-idle.jpeg");
const idleBoxes = figures(idle);
if (idleBoxes.length !== 4) throw new Error(`nouride-idle.jpeg: ${idleBoxes.length} figures found, 4 drawn`);
await strip(idle, idleBoxes, 480, "feet", `${OUT}/idle.webp`);

const ride = await cut("nouride-loop.jpeg");
const rideBoxes = figures(ride);
if (rideBoxes.length !== 6) throw new Error(`nouride-loop.jpeg: ${rideBoxes.length} figures found, 6 drawn`);
await strip(ride, rideBoxes, 320, "right", `${OUT}/ride.webp`);
