#!/usr/bin/env bun
/**
 * Cut the mascot's poses into parts that can move.
 *
 *     bun run apps/site/scripts/cut-mascot-pieces.ts            write the pieces
 *     bun run apps/site/scripts/cut-mascot-pieces.ts --check    say whether the pieces on disk are what it would write
 *
 * A pose is a painting, and a part drawn again by hand is another cat. So the parts are the pose's own pixels: every
 * pixel goes to exactly one part, along the lines in `mascot-piece-cuts.ts`, and each part keeps the pose's canvas.
 * Laid over each other, back to front, they are the pose again, and a page turns one about a point on that canvas.
 * They are written beside the poses: `packages/shared/assets/mascot/pieces/<set>`.
 *
 * ## What a part hides
 *
 * Where a part lies over another, the one under has a hole in it. The hole is painted with the under part's own
 * colour, and only where something above covers it in the still pose: it shows when a part moves, never in the still
 * picture.
 *
 * ## An outline's soft edge
 *
 * The outline's edge is a blend of ink and what it was painted on. Against another part (a foot on its shadow) that
 * is a pale rim once the part has left, so there the edge becomes ink that lets the ground through.
 *
 * That, and the ground between the legs, is all the stacked parts differ from the pose by: a few dozen pixels. A cut
 * that lost a part differs by thousands, and the script refuses it.
 *
 * It lives here for the reason `crop-mascot-sheet.ts` does: `sharp` is installed with Astro, under `apps/site`.
 */

import { existsSync, mkdirSync } from "node:fs";
import sharp from "sharp";
import { CUTS, type Colour, type Cut, type Lift, type Part, type Point, type Region } from "./mascot-piece-cuts.ts";

// The repository root, from where this file is: apps/site/scripts/.
const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const MASCOT = `${ROOT}/packages/shared/assets/mascot`;
const PIECES = `${MASCOT}/pieces`;
/** More pixels than this far from the pose, and a part was lost rather than an edge softened. */
const FAR_ALLOWED = 80;
/** A channel this far off, as seen, is a pixel the eye would tell from the pose's. */
const FAR = 24;
/** Paint goes only under a pixel this solid: under a see-through one it would show in the still picture. */
const SOLID = 240;

type Piece = { name: string; z: number; save: boolean; rgba: Buffer };
/** The pose and who owns each of its pixels: an index into the cut's parts. */
type Pose = { src: Buffer; W: number; H: number; owner: Int16Array; parts: readonly Part[] };

function inside(polygon: readonly Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
const holds = (region: Region, x: number, y: number) => (typeof region === "function" ? region(x, y) : inside(region, x, y));
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
/** A pixel's four channels, by its index. */
const rgbaAt = (buf: Buffer, p: number): [number, number, number, number] => [buf[p * 4] as number, buf[p * 4 + 1] as number, buf[p * 4 + 2] as number, buf[p * 4 + 3] as number];
const passes = (buf: Buffer, p: number, test: Colour) => test(...rgbaAt(buf, p));

/** Who owns each pixel of the pose: the first part, in the cut's order, whose claim holds it. */
function owners(cut: Cut, src: Buffer, W: number, H: number): Int16Array {
  const owner = new Int16Array(W * H).fill(-1);
  const solid = (p: number) => (src[p * 4 + 3] as number) > 0;
  const indexOf = (name: string) => {
    const index = cut.parts.findIndex((part) => part.name === name);
    if (index < 0) throw new Error(`${cut.set}: no part is called ${name}`);
    return index;
  };
  cut.parts.forEach((part, index) => {
    if (!part.flood) return;
    const stack = part.flood.seeds.map(([x, y]) => y * W + x);
    while (stack.length) {
      const p = stack.pop() as number;
      const [x, y] = [p % W, Math.floor(p / W)];
      if (owner[p] !== -1 || !solid(p) || !holds(part.flood.within, x + 0.5, y + 0.5) || !passes(src, p, part.flood.pass)) continue;
      owner[p] = index;
      if (x > 0) stack.push(p - 1);
      if (x < W - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - W);
      if (y < H - 1) stack.push(p + W);
    }
  });
  // A claim's box first: most pixels are outside most polygons, and the box says so without walking the polygon.
  const boxes = cut.parts.map((part) => {
    const xs = (part.claim ?? []).map((point) => point[0]);
    const ys = (part.claim ?? []).map((point) => point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
  });
  for (let p = 0; p < W * H; p++) {
    if (!solid(p) || owner[p] !== -1) continue;
    const x = (p % W) + 0.5;
    const y = Math.floor(p / W) + 0.5;
    owner[p] = cut.parts.findIndex((part, index) => {
      const box = boxes[index] as (typeof boxes)[number];
      return part.claim !== undefined && x >= box[0] && y >= box[1] && x <= box[2] && y <= box[3] && inside(part.claim, x, y);
    });
  }
  for (const rule of cut.refine ?? []) {
    const [from, to] = [indexOf(rule.from), indexOf(rule.to)];
    for (let p = 0; p < W * H; p++) {
      if (owner[p] === from && holds(rule.within, (p % W) + 0.5, Math.floor(p / W) + 0.5) && passes(src, p, rule.when)) owner[p] = to;
    }
  }
  // What no claim reached (a row past a polygon's edge) goes to whoever owns the nearest pixel.
  const given = new Map<number, number>();
  for (let p = 0; p < W * H; p++) {
    if (!solid(p) || owner[p] !== -1) continue;
    const [x, y] = [p % W, Math.floor(p / W)];
    let best = Infinity;
    for (let qy = Math.max(0, y - 8); qy <= Math.min(H - 1, y + 8); qy++) {
      for (let qx = Math.max(0, x - 8); qx <= Math.min(W - 1, x + 8); qx++) {
        const d = (qx - x) ** 2 + (qy - y) ** 2;
        const who = owner[qy * W + qx] as number;
        if (d < best && who >= 0) { best = d; given.set(p, who); }
      }
    }
    if (!given.has(p)) throw new Error(`${cut.set}: the pixel at ${x},${y} is in no part and near none`);
  }
  for (const [p, who] of given) owner[p] = who;
  return owner;
}

/** A part's paint under the parts above it, into `out`: before its own pixels, which go over it. */
async function underpaint(pose: Pose, index: number, out: Buffer): Promise<void> {
  const { src, W, H, owner, parts } = pose;
  const part = parts[index] as Part;
  const zOf = (p: number) => ((owner[p] as number) < 0 ? -1 : (parts[owner[p] as number] as Part).z);
  const hidden = (p: number) => zOf(p) > part.z && (src[p * 4 + 3] as number) >= SOLID;
  const put = (p: number, r: number, g: number, b: number) => { out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = b; out[p * 4 + 3] = 255; };

  for (const step of part.under ?? []) {
    if ("paint" in step) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${step.paint}</svg>`;
      const paint = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
      for (let p = 0; p < W * H; p++) {
        const [r, g, b, a] = rgbaAt(paint, p);
        if (a > 127 && hidden(p)) put(p, r, g, b);
      }
      continue;
    }
    // Each covered pixel takes the nearest pixel of the part's own that passes: an outline does not, so the paint is
    // the cloth and not a smear of ink.
    const { region, reach = 26, pass = () => true } = step.fill;
    const near = nearestFirst(reach);
    const filled: number[] = [];
    for (let p = 0; p < W * H; p++) {
      const x = p % W;
      const y = (p - x) / W;
      if (!hidden(p) || !holds(region, x + 0.5, y + 0.5)) continue;
      for (let k = 0; k < near.length; k += 2) {
        const qx = x + (near[k] as number);
        const qy = y + (near[k + 1] as number);
        if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
        const q = qy * W + qx;
        if (owner[q] !== index || (src[q * 4 + 3] as number) !== 255 || !pass(src[q * 4] as number, src[q * 4 + 1] as number, src[q * 4 + 2] as number, 255)) continue;
        put(p, src[q * 4] as number, src[q * 4 + 1] as number, src[q * 4 + 2] as number);
        filled.push(p);
        break;
      }
    }
    soften(out, filled, W, H);
  }
}

const rings = new Map<number, Int16Array>();
/** Every step within `reach` of a pixel, as x and y by turns, the nearest first: the first that fits is the nearest. */
function nearestFirst(reach: number): Int16Array {
  const known = rings.get(reach);
  if (known) return known;
  const steps: Array<[number, number]> = [];
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) steps.push([dx, dy]);
  steps.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || a[1] - b[1] || a[0] - b[0]);
  const ring = Int16Array.from(steps.flat());
  rings.set(reach, ring);
  return ring;
}

/** Nearest-pixel paint comes out in streaks; averaged over its neighbours, twice, it is flat cloth. */
function soften(out: Buffer, filled: readonly number[], W: number, H: number): void {
  const mark = new Uint8Array(W * H);
  for (const p of filled) mark[p] = 1;
  for (let round = 0; round < 2; round++) {
    const next = filled.map((p) => {
      const [x, y] = [p % W, Math.floor(p / W)];
      const sum = [0, 0, 0];
      let n = 0;
      for (let qy = Math.max(0, y - 3); qy <= Math.min(H - 1, y + 3); qy++) {
        for (let qx = Math.max(0, x - 3); qx <= Math.min(W - 1, x + 3); qx++) {
          if (!mark[qy * W + qx]) continue;
          const [r, g, b] = rgbaAt(out, qy * W + qx);
          sum[0] = (sum[0] as number) + r; sum[1] = (sum[1] as number) + g; sum[2] = (sum[2] as number) + b;
          n++;
        }
      }
      return sum.map((channel) => Math.round(channel / n));
    });
    filled.forEach((p, k) => { const [r, g, b] = next[k] as number[]; out[p * 4] = r as number; out[p * 4 + 1] = g as number; out[p * 4 + 2] = b as number; });
  }
}

/** A pixel of a part's edge as ink that lets the ground through, or nothing where no rule is for it. */
function lifted(pose: Pose, rules: readonly (Lift & { offIndex: number })[], p: number): [number, number, number, number] | undefined {
  const { src, W, H, owner } = pose;
  const [r, g, b, a] = rgbaAt(src, p);
  if (a < SOLID) return undefined;
  const [x, y] = [p % W, Math.floor(p / W)];
  for (const rule of rules) {
    let near = false;
    if ("within" in rule) near = holds(rule.within, x + 0.5, y + 0.5) && rule.when(r, g, b, a);
    else {
      for (let qy = Math.max(0, y - 2); qy <= Math.min(H - 1, y + 2) && !near; qy++) {
        for (let qx = Math.max(0, x - 2); qx <= Math.min(W - 1, x + 2); qx++) if (owner[qy * W + qx] === rule.offIndex) { near = true; break; }
      }
    }
    if (!near) continue;
    const [ink, ground] = [luma(...rule.ink), luma(...rule.ground)];
    const solid = Math.max(0, Math.min(1, (ground - luma(r, g, b)) / (ground - ink)));
    if (solid < 0.97) return [rule.ink[0], rule.ink[1], rule.ink[2], Math.round(solid * a)];
  }
  return undefined;
}

/** How many pixels of the parts, laid over each other back to front, the eye would tell from the pose's. */
function farFromPose(pose: Pose, pieces: readonly Piece[]): number {
  const { src, W, H } = pose;
  const sorted = [...pieces].sort((a, b) => a.z - b.z);
  let far = 0;
  for (let p = 0; p < W * H; p++) {
    // As seen: each colour times how solid it is, so a pixel nobody can see does not count.
    const seen = [0, 0, 0, 0];
    for (const piece of sorted) {
      const [r, g, b, a] = rgbaAt(piece.rgba, p);
      const over = a / 255;
      seen[0] = r * over + (seen[0] as number) * (1 - over);
      seen[1] = g * over + (seen[1] as number) * (1 - over);
      seen[2] = b * over + (seen[2] as number) * (1 - over);
      seen[3] = a + (seen[3] as number) * (1 - over);
    }
    const [r, g, b, a] = rgbaAt(src, p);
    const off = Math.max(Math.abs((r * a) / 255 - (seen[0] as number)), Math.abs((g * a) / 255 - (seen[1] as number)), Math.abs((b * a) / 255 - (seen[2] as number)), Math.abs(a - (seen[3] as number)));
    if (off > FAR) far++;
  }
  return far;
}

/** A pose cut into its parts, each on the pose's canvas. */
async function cutPose(cut: Cut): Promise<{ W: number; H: number; pieces: Piece[] }> {
  const pose = sharp(`${MASCOT}/${cut.pose}`).ensureAlpha();
  const [left, top, width, height] = cut.crop ?? [0, 0, 0, 0];
  const { data: src, info } = await (cut.crop ? pose.extract({ left, top, width, height }) : pose).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const held: Pose = { src, W, H, owner: owners(cut, src, W, H), parts: cut.parts };
  const pieces: Piece[] = [];
  for (const [index, part] of cut.parts.entries()) {
    const rgba = Buffer.alloc(W * H * 4);
    await underpaint(held, index, rgba);
    const rules = (cut.lift ?? []).filter((rule) => rule.part === part.name).map((rule) => ({ ...rule, offIndex: "off" in rule ? cut.parts.findIndex((other) => other.name === rule.off) : -1 }));
    for (let p = 0; p < W * H; p++) {
      if (held.owner[p] !== index) continue;
      const [r, g, b, a] = lifted(held, rules, p) ?? rgbaAt(src, p);
      rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = a;
    }
    pieces.push({ name: part.name, z: part.z, save: part.save !== false, rgba });
  }
  const far = farFromPose(held, pieces);
  if (far > FAR_ALLOWED) throw new Error(`${cut.set}: the parts laid over each other differ from ${cut.pose} in ${far} pixels: a part was lost`);
  return { W, H, pieces };
}

/** Whether a file holds these pixels: a pixel nobody can see is the same whatever colour it is said to be. */
async function holdsPixels(file: string, rgba: Buffer, W: number, H: number): Promise<boolean> {
  if (!existsSync(file)) return false;
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== W || info.height !== H) return false;
  for (let p = 0; p < W * H; p++) {
    const [r, g, b, a] = rgbaAt(rgba, p);
    const [dr, dg, db, da] = rgbaAt(data, p);
    if (a !== da || (a > 0 && (r !== dr || g !== dg || b !== db))) return false;
  }
  return true;
}

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const cut of CUTS) {
  const { W, H, pieces } = await cutPose(cut);
  const dir = `${PIECES}/${cut.set}`;
  if (!check) mkdirSync(dir, { recursive: true });
  for (const piece of pieces.filter((each) => each.save)) {
    const file = `${dir}/${piece.name}.webp`;
    // Lossless: a part's edge that lost a little colour would be a seam where two parts meet.
    if (check) { if (!(await holdsPixels(file, piece.rgba, W, H))) stale.push(file.slice(ROOT.length + 1)); }
    else await sharp(piece.rgba, { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(file);
  }
  console.log(`${cut.set}: ${pieces.filter((each) => each.save).length} pieces from ${cut.pose}`);
}
if (stale.length) {
  console.error(`not what the cut writes: ${stale.join(", ")}. Run apps/site/scripts/cut-mascot-pieces.ts and look at the pieces.`);
  process.exit(1);
}
