#!/usr/bin/env bun
/**
 * Cut `nouride-mascot.png` into its four poses.
 *
 *     bun run apps/site/scripts/crop-mascot-sheet.ts [output directory]
 *
 * It lives under `apps/site` rather than in `scripts/` because that is where `sharp` is installed —
 * it arrives with Astro. Bun resolves a bare import from the script's own directory, not the working
 * one, so a copy in `scripts/` cannot find it, and adding `sharp` to the root manifest would make
 * every CI job fetch a native binary for a tool that runs twice a year.
 *
 * Nothing in the repository uses the crops yet; run it when one is wanted. The output goes to
 * `packages/shared/assets` unless a directory is given.
 *
 * ## The source
 *
 * `nouride-mascot.png` is the transparent sheet: standing, scooter, riding and chibi, on a real alpha
 * channel. It was `nouride-1.png`, beside `nouride-2.png` — the same four poses baked onto a dark
 * background — and this script read a third sheet, `nouride-mascot.png` with a checkerboard drawn in
 * as pixels, that was never committed. The keying it needed for that went with it: on this sheet a
 * pixel is background when it is transparent, and keying by colour would cut the light grey of the
 * cat's fur.
 *
 * **The poses are not on a grid.** Quadrants were tried first: the scooter in the top-right pose
 * hangs below the midline, so the bottom-right crop came out with a stray wheel above the chibi's
 * ears. Figures are found as connected components and merged by proximity.
 */

import sharp from "sharp";

// The repository root, from where this file is: apps/site/scripts/.
const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = `${ROOT}/packages/shared/assets/nouride-mascot.png`;
const OUT = process.argv[2] ?? `${ROOT}/packages/shared/assets`;
const PAD = 10;
/**
 * Components closer than this are one figure — a detached paw, a puff of exhaust smoke.
 *
 * Three, found by trying on this sheet: at 6 the scooter and the chibi below it merge into one
 * 607x1121 crop, and 0 to 3 all give the same four.
 */
const MERGE_GAP = 3;
/** Below this alpha a pixel is background: the anti-aliased fringe of an outline is not a figure of its own. */
const ALPHA_FLOOR = 16;

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

// ── 1. What is background: whatever is (nearly) transparent.
const bg = new Uint8Array(W * H);
let stack: number[] = [];
for (let p = 0; p < W * H; p++) if ((data[p * C + 3] as number) < ALPHA_FLOOR) bg[p] = 1;

// ── 2. Label what is left, and take each component's box.
type Box = { x0: number; y0: number; x1: number; y1: number; area: number };
const seen = new Uint8Array(W * H);
const boxes: Box[] = [];
for (let p0 = 0; p0 < W * H; p0++) {
  if (bg[p0] || seen[p0]) continue;
  let area = 0;
  const box: Box = { x0: W, y0: H, x1: 0, y1: 0, area: 0 };
  seen[p0] = 1;
  stack = [p0];
  while (stack.length) {
    const p = stack.pop() as number;
    const x = p % W, y = (p - x) / W;
    area++;
    if (x < box.x0) box.x0 = x;
    if (x > box.x1) box.x1 = x;
    if (y < box.y0) box.y0 = y;
    if (y > box.y1) box.y1 = y;
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const np = ny * W + nx;
      if (bg[np] || seen[np]) continue;
      seen[np] = 1;
      stack.push(np);
    }
  }
  box.area = area;
  // Specks: compression noise along an outline, not a limb.
  if (area >= 200) boxes.push(box);
}

// ── 3. Merge components that touch or nearly touch, until nothing more merges.
const gap = (a: Box, b: Box) =>
  Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)) +
  Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
let merged = true;
while (merged) {
  merged = false;
  outer: for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as Box, b = boxes[j] as Box;
      if (gap(a, b) > MERGE_GAP) continue;
      a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
      a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
      a.area += b.area;
      boxes.splice(j, 1);
      merged = true;
      break outer;
    }
  }
}

boxes.sort((a, b) => b.area - a.area);
console.log(`${boxes.length} figure(s) found`);

// ── 4. Name them by where they sit, so the mapping is not positional guesswork.
const midX = W / 2, midY = H / 2;
const nameFor = (b: Box): string => {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  if (cy < midY) return cx < midX ? "mascot-standing" : "mascot-scooter";
  return cx < midX ? "mascot-riding" : "mascot-chibi";
};

const keyed = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
for (const b of boxes.slice(0, 4)) {
  const left = Math.max(0, b.x0 - PAD), top = Math.max(0, b.y0 - PAD);
  const box = {
    left, top,
    width: Math.min(W - 1, b.x1 + PAD) - left + 1,
    height: Math.min(H - 1, b.y1 + PAD) - top + 1,
  };
  const name = nameFor(b);
  const out = await sharp(keyed).extract(box).png({ compressionLevel: 9 }).toFile(`${OUT}/${name}.png`);
  console.log(`  ${name.padEnd(18)} ${out.width}x${out.height}  ${(out.size / 1024).toFixed(0)} KB`);
}
