/**
 * What the graph keeps and decides when its data changes — before anything is drawn.
 */

import { describe, expect, test } from "bun:test";
import { prepareData, shapeOf, type DataNode } from "../src/data.ts";
import type { GraphLinkInput, GraphNodeInput } from "../src/types.ts";

const node = (id: string, hub = false): GraphNodeInput => ({ id, label: id, color: "#000000", radius: 4, hub });
const link = (source: string, target: string): GraphLinkInput => ({ source, target });
const still = () => 0;

describe("prepareData", () => {
  test("a node it already laid out keeps its place — the same object — and takes the new look", () => {
    const first = prepareData(new Map(), [node("a")], [], 14, still);
    const a = first.byId.get("a")!;
    a.x = 10;
    a.y = 20;
    const next = prepareData(first.byId, [{ ...node("a"), color: "#ff0000" }], [], 14, still);
    expect(next.byId.get("a")).toBe(a);
    expect(next.byId.get("a")).toMatchObject({ x: 10, y: 20, color: "#ff0000" });
  });

  test("a new node starts beside a neighbour that has a place, not at the origin", () => {
    const before = new Map<string, DataNode>([["a", { ...node("a"), degree: 0, x: 100, y: -50 }]]);
    const next = prepareData(before, [node("a"), node("b"), node("c")], [link("b", "a")], 14, () => 0.5);
    expect(next.byId.get("b")).toMatchObject({ x: 115, y: -35 });
    // With no placed neighbour it is left to the layout.
    expect(next.byId.get("c")!.x).toBeUndefined();
  });

  test("a link to a node that is not there is dropped; degrees and neighbours count the rest, both ways", () => {
    const next = prepareData(new Map(), [node("a"), node("b")], [link("a", "b"), link("a", "gone")], 14, still);
    expect(next.links).toEqual([link("a", "b")]);
    expect(next.byId.get("a")!.degree).toBe(1);
    expect([...next.neighbours.get("b")!]).toEqual(["a"]);
  });

  test("hubs come first, and only the best-linked of them are named", () => {
    const hubs = ["h1", "h2", "h3"].map((id) => node(id, true));
    const links = [link("h3", "x"), link("h3", "y"), link("h2", "x"), link("h1", "y"), link("h1", "x"), link("h1", "z")];
    const next = prepareData(new Map(), [node("x"), node("y"), node("z"), ...hubs], links, 2, still);
    expect(next.nodes.slice(0, 3).map((n) => n.id).sort()).toEqual(["h1", "h2", "h3"]);
    expect([...next.named].sort()).toEqual(["h1", "h3"]);
  });

  test("the shape changes with a node or a link, and not with a colour — that is a restyle, not a re-layout", () => {
    const nodes = [node("a"), node("b")];
    expect(shapeOf(nodes.map((n) => ({ ...n, color: "#ffffff" })), [link("a", "b")])).toBe(shapeOf(nodes, [link("a", "b")]));
    expect(shapeOf(nodes, [link("a", "b")])).not.toBe(shapeOf(nodes, [link("b", "a")]));
    expect(shapeOf([...nodes, node("c")], [])).not.toBe(shapeOf(nodes, []));
  });
});
