/**
 * A cat as a canvas, made once per look, pose and blink and kept (0.8.1): the Office copies a few dozen of these a
 * frame, and the Look tab one. `canvasOf` paints any small image pixel by pixel, for the furniture too.
 */

import { compose, type Grid, type Pose } from "./compose";
import type { Look } from "./look";

const cache = new Map<string, HTMLCanvasElement>();

export function canvasOf(width: number, height: number, paint: (image: ImageData) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const image = context.createImageData(width, height);
  paint(image);
  context.putImageData(image, 0, 0);
  return canvas;
}

export function setPixel(image: ImageData, x: number, y: number, color: string): void {
  const at = (y * image.width + x) * 4;
  image.data[at] = Number.parseInt(color.slice(1, 3), 16);
  image.data[at + 1] = Number.parseInt(color.slice(3, 5), 16);
  image.data[at + 2] = Number.parseInt(color.slice(5, 7), 16);
  image.data[at + 3] = 255;
}

function gridCanvas(grid: Grid): HTMLCanvasElement {
  return canvasOf(grid[0]?.length ?? 0, grid.length, (image) => grid.forEach((row, y) => row.forEach((color, x) => color && setPixel(image, x, y, color))));
}

/** A cat, as its look in this pose. */
export function catSprite(look: Look, pose: Pose, blink = false): HTMLCanvasElement {
  const key = `${JSON.stringify(look)}:${pose}:${blink}`;
  let sprite = cache.get(key);
  if (!sprite) {
    sprite = gridCanvas(compose(look, pose, blink));
    cache.set(key, sprite);
  }
  return sprite;
}
