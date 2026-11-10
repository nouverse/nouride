#!/usr/bin/env bun
/**
 * Cut the mascot's later poses out of their drawn sheets.
 *
 *     bun run apps/site/scripts/cut-mascot-poses.ts [output directory]
 *
 * Two sheets in `docs/design/mascot/grids`, twelve poses each on white, become 512px transparent files under
 * `docs/design/mascot` (`standing/`, `states/`, `riding/`), where a pose waits until a page draws it and it moves to
 * `packages/shared/assets/mascot`; a pose that has moved is written there. The first three sheets were cut before this
 * script and are not its business.
 *
 * It lives here for the reason `crop-mascot-sheet.ts` does: `sharp` is installed with Astro, under `apps/site`.
 *
 * ## What is background
 *
 * The sheet's white is pure; the cat's own white (face, paws, scooter) is cream, a few steps darker. So background is
 * the pure white the sheet's edge reaches, and a shadow, a puff of dust or a speed line, which have no outline, keep
 * their own colour: `cut-mascot-motion.ts` reaches through anything light, which is right for its three sheets and
 * turns a pale shadow into a dark smear on a dark page.
 *
 * White the outline closes off (between a leg and the scooter, under the wheels) is not reached from the edge. Such a
 * pocket is told from the cat's white the same way, by being pure. A few drawn highlights are pure white too (the eyes
 * wide open, a gleam on the headphones), and those are named in `keep` by a point inside each.
 *
 * The outline's soft edge is a blend of ink and white. Left as drawn it is a pale fringe on a dark page, so the few
 * pixels beside the background get the alpha that blend implies and their colour with the white taken back out.
 */

import { existsSync, mkdirSync } from "node:fs";
import sharp from "sharp";

// The repository root, from where this file is: apps/site/scripts/.
const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const GRIDS = `${ROOT}/docs/design/mascot/grids`;
const WAITING = `${ROOT}/docs/design/mascot`;
const DRAWN = `${ROOT}/packages/shared/assets/mascot`;
/** Where a pose goes: the directory given, or where it lives now, with the poses a page draws or among the ones waiting. */
const placeOf = (pose: string) => process.argv[2] ?? (existsSync(`${DRAWN}/${pose}.webp`) ? DRAWN : WAITING);

const SIZE = 512;
/** Clear space around a pose in its file, so a shadow or a spark is not flush with the edge. */
const PAD = 14;
/** A sheet is four poses across and three down. */
const COLS = 4;
const ROWS = 3;

/** A pixel this light or lighter (its darkest channel) is the sheet's white, not the cat's cream. */
const PURE = 246;
/** A closed-off area this light on average is a pocket of background. The cat's white averages about 240. */
const POCKET = 247;
/** What can be part of a closed-off light area at all. */
const LIGHT = 235;
/** How far from the background the outline's soft edge goes, in pixels, and how light a pixel of it can be. */
const FRINGE = 3;
const EDGE = 120;
/** The outline's ink, by its darkest channel: where the blend toward white started. */
const INK = 45;
/** Alpha below this is JPEG noise on the white, not an edge. */
const NOISE = 0.06;

type Point = readonly [number, number];
type Sheet = { file: string; poses: readonly string[]; keep: readonly Point[] };

const SHEETS: readonly Sheet[] = [
  {
    file: "nourider-4.jpeg",
    poses: [
      "riding/13-wheelie-wave", "riding/14-dust", "riding/15-startled", "riding/16-scarf",
      "riding/17-lookout", "riding/18-toss-box", "riding/19-turbo", "riding/20-hands-up",
      "riding/21-hurry", "riding/22-flag", "riding/23-peace", "riding/24-singing",
    ],
    // The startled cat's two eyes.
    keep: [[1483, 286], [1590, 243]],
  },
  {
    file: "nourider-5.jpeg",
    poses: [
      "standing/13-deep-work", "standing/14-jump", "states/13-lost", "states/14-star",
      "states/15-inspecting", "states/16-no-signal", "standing/15-parked", "riding/25-cool",
      "riding/26-cruise", "riding/27-zoom", "riding/28-drift", "riding/29-hello",
    ],
    // The gleam on the headphones' band, and the two on the magnifying glass.
    keep: [[373, 101], [558, 847], [557, 871]],
  },
];

type Box = { x0: number; y0: number; x1: number; y1: number };
type Cut = { rgba: Buffer; width: number; height: number };
type Part = Box & { area: number; cell: number; pixels: number[] };

/**
 * The connected areas of a sheet where `inside` holds, each with the cell of the grid its middle is in. A pose's
 * parts (a spark, a question mark, a puff of dust) are not joined to it, and one may cross the line between two cells:
 * the middle is what says whose it is.
 */
function parts(width: number, height: number, inside: (p: number) => boolean, least: number): Part[] {
  const seen = new Uint8Array(width * height);
  const found: Part[] = [];
  for (let p0 = 0; p0 < width * height; p0++) {
    if (seen[p0] || !inside(p0)) continue;
    const part: Part = { x0: width, y0: height, x1: 0, y1: 0, area: 0, cell: 0, pixels: [p0] };
    let sumX = 0;
    let sumY = 0;
    seen[p0] = 1;
    for (let at = 0; at < part.pixels.length; at++) {
      const p = part.pixels[at] as number;
      const x = p % width;
      const y = (p - x) / width;
      sumX += x;
      sumY += y;
      if (x < part.x0) part.x0 = x;
      if (x > part.x1) part.x1 = x;
      if (y < part.y0) part.y0 = y;
      if (y > part.y1) part.y1 = y;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (seen[np] || !inside(np)) continue;
        seen[np] = 1;
        part.pixels.push(np);
      }
    }
    part.area = part.pixels.length;
    if (part.area < least) continue;
    const col = Math.min(COLS - 1, Math.floor(sumX / part.area / (width / COLS)));
    const row = Math.min(ROWS - 1, Math.floor(sumY / part.area / (height / ROWS)));
    part.cell = row * COLS + col;
    found.push(part);
  }
  return found;
}

/** The sheet with its background, and the pockets of it, made transparent. */
async function cut(sheet: Sheet): Promise<Cut> {
  const { data, info } = await sharp(`${GRIDS}/${sheet.file}`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const light = (p: number) => Math.min(data[p * 3] as number, data[p * 3 + 1] as number, data[p * 3 + 2] as number);

  // 1. What the edge of the sheet reaches through pure white.
  const reached = new Uint8Array(W * H);
  let front: number[] = [];
  const visit = (p: number) => {
    if (reached[p] || light(p) < PURE) return;
    reached[p] = 1;
    front.push(p);
  };
  for (let x = 0; x < W; x++) { visit(x); visit((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { visit(y * W); visit(y * W + W - 1); }
  while (front.length) {
    const p = front.pop() as number;
    const x = p % W;
    if (x > 0) visit(p - 1);
    if (x < W - 1) visit(p + 1);
    if (p >= W) visit(p - W);
    if (p < W * (H - 1)) visit(p + W);
  }

  // 2. The pockets: closed-off light areas that are pure white on average, but for the ones drawn that way.
  const kept = new Set(sheet.keep.map(([x, y]) => y * W + x));
  let found = 0;
  for (const area of parts(W, H, (p) => !reached[p] && light(p) >= LIGHT, 30)) {
    const mean = area.pixels.reduce((sum, p) => sum + light(p), 0) / area.area;
    if (mean < POCKET) continue;
    // A point of `keep` is the area's middle, which a ring-shaped one does not hold: near enough is inside its box.
    const drawn = [...kept].some((p) => {
      const x = p % W;
      const y = (p - x) / W;
      return x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;
    });
    if (drawn) {
      found++;
      continue;
    }
    for (const p of area.pixels) reached[p] = 1;
  }
  if (found !== sheet.keep.length) throw new Error(`${sheet.file}: ${sheet.keep.length} highlights to keep, ${found} found where they were`);

  // 3. The outline's soft edge: the few pixels beside the background, each as far from it as `edge` says.
  const edge = new Uint8Array(W * H);
  front = [];
  for (let p = 0; p < W * H; p++) if (reached[p]) front.push(p);
  for (let step = 1; step <= FRINGE; step++) {
    const next: number[] = [];
    for (const p of front) {
      const x = p % W;
      for (const np of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (np < 0 || np >= W * H || reached[np] || edge[np] || light(np) < EDGE) continue;
        edge[np] = step;
        next.push(np);
      }
    }
    front = next;
  }

  const rgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    let alpha = 1;
    if (reached[p]) alpha = 0;
    else if (edge[p]) {
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

/** Each cell's pose: the box around its parts, and the sheet inside that box with every other cell's parts taken out. */
function poses(img: Cut): Array<{ box: Box; rgba: Buffer }> {
  const { width: W, height: H } = img;
  const drawn = parts(W, H, (p) => (img.rgba[p * 4 + 3] as number) > 40, 60);
  return Array.from({ length: COLS * ROWS }, (_, cell) => {
    const own = drawn.filter((part) => part.cell === cell);
    if (own.length === 0) throw new Error(`cell ${cell + 1}: nothing drawn in it`);
    const box: Box = {
      x0: Math.min(...own.map((part) => part.x0)),
      y0: Math.min(...own.map((part) => part.y0)),
      x1: Math.max(...own.map((part) => part.x1)),
      y1: Math.max(...own.map((part) => part.y1)),
    };
    const w = box.x1 - box.x0 + 1;
    const h = box.y1 - box.y0 + 1;
    const rgba = Buffer.alloc(w * h * 4);
    // Only this pose's parts, and the soft edge around them: a neighbour's spark inside the box is not this pose's.
    for (const part of own) {
      for (const p of part.pixels) {
        const x = p % W;
        const y = (p - x) / W;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < box.x0 || nx > box.x1 || ny < box.y0 || ny > box.y1) continue;
            img.rgba.copy(rgba, ((ny - box.y0) * w + (nx - box.x0)) * 4, (ny * W + nx) * 4, (ny * W + nx) * 4 + 4);
          }
        }
      }
    }
    return { box, rgba };
  });
}

for (const sheet of SHEETS) {
  const img = await cut(sheet);
  for (const [cell, pose] of poses(img).entries()) {
    const file = `${placeOf(sheet.poses[cell] as string)}/${sheet.poses[cell]}.webp`;
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await sharp(pose.rgba, { raw: { width: pose.box.x1 - pose.box.x0 + 1, height: pose.box.y1 - pose.box.y0 + 1, channels: 4 } })
      .resize(SIZE - PAD * 2, SIZE - PAD * 2, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 88, alphaQuality: 95 })
      .toFile(file);
    console.log(`  ${sheet.poses[cell]}.webp`);
  }
}
