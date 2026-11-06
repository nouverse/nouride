/**
 * The furniture as canvases, made once per piece and palette and kept: what the Office copies each frame besides cats.
 */

import { canvasOf, setPixel } from "@/commons/cat/sprite";

const cache = new Map<string, HTMLCanvasElement>();

/** A pixel map of symbols, in a palette. */
export function mapSprite(name: string, rows: readonly string[], palette: Record<string, string>): HTMLCanvasElement {
  const key = `${name}:${JSON.stringify(palette)}`;
  let sprite = cache.get(key);
  if (!sprite) {
    sprite = canvasOf(rows[0]?.length ?? 0, rows.length, (image) =>
      rows.forEach((row, y) => [...row].forEach((symbol, x) => symbol !== "." && palette[symbol] && setPixel(image, x, y, palette[symbol]!))),
    );
    cache.set(key, sprite);
  }
  return sprite;
}
