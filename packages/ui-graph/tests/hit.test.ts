/**
 * Hitting a node by distance: what the pointer is over, where areas overlap, and at any zoom.
 */

import { describe, expect, test } from "bun:test";
import { quadtree } from "d3-quadtree";
import { HALO, HIT_SLACK_PX, hitRadius, pick, type Hittable } from "../src/hit.ts";

type N = Hittable & { id: string };

function tree(nodes: N[]) {
  return quadtree<N>().x((node) => node.x ?? 0).y((node) => node.y ?? 0).addAll(nodes);
}

const reach = (nodes: N[], k: number) => Math.max(...nodes.map((node) => hitRadius(node, k)));

describe("hitRadius", () => {
  test("a small node keeps a few screen pixels around it, so zoomed out it is still hit", () => {
    expect(hitRadius({ radius: 2 }, 1)).toBe(2 + HIT_SLACK_PX);
    expect(hitRadius({ radius: 2 }, 0.25)).toBe(2 + HIT_SLACK_PX * 4);
  });

  test("a hub is hit on its halo, which is drawn", () => {
    expect(hitRadius({ radius: 10, hub: true }, 4)).toBe(10 * HALO);
  });
});

describe("pick", () => {
  test("the node under the point, and nothing off it", () => {
    const nodes: N[] = [{ id: "a", x: 0, y: 0, radius: 3 }, { id: "b", x: 100, y: 0, radius: 3 }];
    expect(pick(tree(nodes), 1, 1, 1, reach(nodes, 1))?.id).toBe("a");
    expect(pick(tree(nodes), 99, 0, 1, reach(nodes, 1))?.id).toBe("b");
    expect(pick(tree(nodes), 50, 0, 1, reach(nodes, 1))).toBeNull();
  });

  test("a small node on a hub's halo is hit on itself, the hub everywhere else", () => {
    const nodes: N[] = [{ id: "hub", x: 0, y: 0, radius: 10, hub: true }, { id: "dot", x: 14, y: 0, radius: 3 }];
    const r = reach(nodes, 1);
    expect(pick(tree(nodes), 14, 0, 1, r)?.id).toBe("dot");
    expect(pick(tree(nodes), -14, 0, 1, r)?.id).toBe("hub");
    expect(pick(tree(nodes), 2, 0, 1, r)?.id).toBe("hub");
  });

  test("between two overlapping nodes, the nearer one", () => {
    const nodes: N[] = [{ id: "a", x: 0, y: 0, radius: 4 }, { id: "b", x: 6, y: 0, radius: 4 }];
    expect(pick(tree(nodes), 2, 0, 1, reach(nodes, 1))?.id).toBe("a");
    expect(pick(tree(nodes), 4, 0, 1, reach(nodes, 1))?.id).toBe("b");
  });

  test("finds a node in a crowd of a thousand", () => {
    const nodes: N[] = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), x: (i % 40) * 20, y: Math.floor(i / 40) * 20, radius: 3 }));
    expect(pick(tree(nodes), 20 * 7 + 1, 20 * 11 - 1, 1, reach(nodes, 1))?.id).toBe(String(11 * 40 + 7));
  });
});
