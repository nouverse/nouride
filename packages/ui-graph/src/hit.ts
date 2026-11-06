/**
 * Which node is under the pointer — by distance, in graph units, against a quadtree.
 *
 * Not by colour. The usual canvas trick paints every node in a unique colour on a hidden canvas and
 * reads the pixel under the pointer; the edge of each circle is antialiased into colours that match
 * nothing, and the hidden canvas is repainted on a throttle, so while the layout moves it lags what
 * is drawn. Both showed as nodes that could be hovered, clicked or dragged only sometimes. A distance
 * is exact at any zoom and always current.
 */

import type { Quadtree } from "d3-quadtree";

/** Screen pixels added around every node: a small dot zoomed out is still something you can hit. */
export const HIT_SLACK_PX = 3;
/** A hub's halo, as a multiple of its radius. Drawn, so it is also hit. */
export const HALO = 1.8;
/** How far, in screen pixels, a press may travel and still be a click rather than a drag or a pan. */
export const CLICK_TOLERANCE_PX = 5;

export interface Hittable {
  x?: number;
  y?: number;
  radius: number;
  hub?: boolean;
}

/** How far from its centre a node answers the pointer, in graph units at zoom `k`. */
export function hitRadius(node: Hittable, k: number): number {
  const base = node.radius + HIT_SLACK_PX / k;
  return node.hub ? Math.max(base, node.radius * HALO) : base;
}

/**
 * The node at a point, or null. Where areas overlap — a small node on a hub's halo — the one whose
 * centre is nearest relative to its own size wins, so the small node is hit on itself and the hub
 * everywhere else on it.
 *
 * `reach` is the largest hit radius any node has, which bounds the search.
 */
export function pick<T extends Hittable>(tree: Quadtree<T>, x: number, y: number, k: number, reach: number): T | null {
  let best: T | null = null;
  let bestRatio = Infinity;
  tree.visit((quad, x0, y0, x1, y1) => {
    if (!("length" in quad)) {
      for (let leaf: typeof quad | undefined = quad; leaf; leaf = leaf.next) {
        const node = leaf.data;
        const distance = Math.hypot((node.x ?? 0) - x, (node.y ?? 0) - y);
        const ratio = distance / hitRadius(node, k);
        if (ratio <= 1 && ratio < bestRatio) {
          best = node;
          bestRatio = ratio;
        }
      }
    }
    // Skip a quadrant that is wholly further than `reach` from the point.
    return x0 > x + reach || x1 < x - reach || y0 > y + reach || y1 < y - reach;
  });
  return best;
}
