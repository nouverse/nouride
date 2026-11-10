/**
 * The dashboard's app icons, for a phone's home screen and an installed app, drawn from the cat in `src/commons/cat`:
 * the mascot's look (black tuxedo, lilac hoodie, the helmet with its N, the photochromic glasses), its head alone as the
 * design rules give the app icon, each pixel of the 32-pixel art a square of whole screen pixels, on a lavender disc on
 * the night theme's ground. Drawn rather than committed, as the favicon is copied rather than committed
 * (`scripts/sync-brand.ts`): one source, and a cat redrawn in `art.ts` is the icon the next build ships. The same
 * pixels every time, so a test draws them too.
 *
 * Four files under `public/icons/`, which `manifest.webmanifest` and `index.html` name: a 192 and a 512 on a rounded
 * tile, for a browser's install and a desktop's app list; a 512 to be masked (Android cuts its own shape out of it, so
 * the head sits inside the middle 80% circle every mask keeps); and a 180 for an iPhone, which rounds its own corners
 * and fills anything transparent with black. The dashboard's `build` and `dev` run this before Vite.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { HEAD, HEAD_AT } from "../src/commons/cat/art";
import { compose } from "../src/commons/cat/compose";
import type { Look } from "../src/commons/cat/look";
import { GROUNDS } from "../src/commons/lib/theme";

/** The mascot's own look, as `docs/design/mascot` draws it. */
const MASCOT: Look = { fur: "black", pattern: "tuxedo", outfit: "hoodie", outfitColor: "lilac", hat: "helmet", accessory: "photochromic", eyes: "round" };

/** The night theme's ground, as the manifest's colours are: an installed app's splash is drawn in it. */
const GROUND = GROUNDS.dark;

export interface AppIcon {
  /** Where it is served, under the dashboard. */
  file: string;
  size: number;
  /** How many screen pixels a pixel of the art takes. */
  scale: number;
  /** A rounded tile with clear corners, or the ground to every edge for a platform that cuts its own shape. */
  shape: "tile" | "square";
  /** What the manifest says it is for; none for the iPhone's, which only `index.html` names. */
  purpose?: "any" | "maskable";
}

export const APP_ICONS: readonly AppIcon[] = [
  { file: "icons/icon-192.png", size: 192, scale: 6, shape: "tile", purpose: "any" },
  { file: "icons/icon-512.png", size: 512, scale: 16, shape: "tile", purpose: "any" },
  { file: "icons/icon-maskable-512.png", size: 512, scale: 14, shape: "square", purpose: "maskable" },
  { file: "icons/apple-touch-icon.png", size: 180, scale: 6, shape: "square" },
];

/**
 * The lavender behind the head: the night theme's `--fill-secondary`, the brand's own, as a disc. On the ground alone
 * the black cat's outline was the ground's colour and the head read as a grey smudge at a home screen's size.
 */
export const DISC = "#a99af0";

/** A tile's corner, as a share of its side: an app icon's squircle, near enough at these sizes. */
const CORNER = 0.22;
/** The disc's radius, as a share of the side: a hair wider than the head, and inside the 40% a mask keeps. */
export const DISC_RADIUS = 0.37;

/** The mascot's head, as rows of colours (`null` where there is none), cut from the standing cat to its own width. */
function head(): (string | null)[][] {
  const rows = compose(MASCOT, "stand").slice(HEAD_AT.y, HEAD_AT.y + HEAD.length);
  const used = rows.flatMap((row) => row.flatMap((color, x) => (color ? [x] : [])));
  const [left, right] = [Math.min(...used), Math.max(...used)];
  return rows.map((row) => row.slice(left, right + 1));
}

/** How much of the pixel at (x, y) a shape covers, from 4×4 samples in it: 1 inside, 0 outside, between on its edge. */
function cover(x: number, y: number, inside: (px: number, py: number) => boolean): number {
  let hits = 0;
  for (let sy = 0; sy < 4; sy += 1) for (let sx = 0; sx < 4; sx += 1) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits += 1;
  return hits / 16;
}

/** A square of `size` with its corners rounded. */
const inTile = (size: number) => (px: number, py: number) => {
  const radius = size * CORNER;
  const dx = Math.max(radius - px, 0, px - (size - radius));
  const dy = Math.max(radius - py, 0, py - (size - radius));
  return dx * dx + dy * dy <= radius * radius;
};

/** The disc in the middle of a square of `size`. */
const inDisc = (size: number) => (px: number, py: number) => (px - size / 2) ** 2 + (py - size / 2) ** 2 <= (size * DISC_RADIUS) ** 2;

const channels = (color: string): [number, number, number] => [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16)) as [number, number, number];

/** One icon's pixels, RGBA, row by row. */
export function iconPixels(icon: AppIcon): Uint8Array {
  const { size, scale, shape } = icon;
  const art = head();
  const [width, height] = [art[0]!.length * scale, art.length * scale];
  const [left, top] = [Math.floor((size - width) / 2), Math.floor((size - height) / 2)];
  const [ground, disc] = [channels(GROUND), channels(DISC)];
  const [tile, round] = [inTile(size), inDisc(size)];
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = x >= left && y >= top ? art[Math.floor((y - top) / scale)]?.[Math.floor((x - left) / scale)] : undefined;
      const lit = cover(x, y, round);
      const behind = ground.map((c, i) => Math.round(c * (1 - lit) + disc[i]! * lit));
      const alpha = shape === "tile" ? cover(x, y, tile) : 1;
      pixels.set([...(color ? channels(color) : behind), Math.round(alpha * 255)], (y * size + x) * 4);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A PNG of RGBA pixels: 8 bits a channel, no filter on any row (the art is flat colour, and deflate takes it well). */
export function png(size: number, pixels: Uint8Array): Uint8Array {
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y += 1) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Write every icon under `<public>/`: the dashboard's own `public/` unless told another. */
export function writeAppIcons(publicDir: string = fileURLToPath(new URL("../public", import.meta.url))): void {
  for (const icon of APP_ICONS) {
    const path = join(publicDir, icon.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png(icon.size, iconPixels(icon)));
  }
}

if (import.meta.main) {
  writeAppIcons();
  console.log(`✓ app icons drawn: ${APP_ICONS.length} files`);
}
