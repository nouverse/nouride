/**
 * What `GraphView.setData` decides before it touches the simulation: which nodes and links stand, how many links
 * each node has, who neighbours whom, where a new node starts, which hubs are named, and whether this is the same
 * graph restyled. Pure, so it is tested without a canvas; the view does the drawing and the physics.
 */

import type { SimulationNodeDatum } from "d3-force";
import type { GraphLinkInput, GraphNodeInput } from "./types.ts";

export type DataNode = GraphNodeInput & SimulationNodeDatum & { degree: number };

export interface Prepared {
  /** The ids and links, as one string: equal to the last one means only colours or sizes changed. */
  shape: string;
  byId: Map<string, DataNode>;
  /** Hubs first: drawn under the rest, so a small node beside a hub is on top of it. */
  nodes: DataNode[];
  /** The links whose both ends are among the nodes. */
  links: GraphLinkInput[];
  neighbours: Map<string, Set<string>>;
  /** The `namedHubs` hubs with the most links — named before any zoom. */
  named: Set<string>;
}

/** The shape of a graph: its node ids and its links, in order. */
export function shapeOf(nodes: readonly GraphNodeInput[], links: readonly GraphLinkInput[]): string {
  return `${nodes.map((node) => node.id).join("\n")}|${links.map((link) => `${link.source}>${link.target}`).join("\n")}`;
}

/**
 * The next data, against the nodes already laid out: a node kept by id keeps its position (and is the same object, so
 * the simulation keeps its velocity); a new one starts beside a neighbour that has a position, offset by `jitter`
 * (−0.5 to 0.5, scaled to 30 units), rather than at the origin.
 */
export function prepareData(
  previous: ReadonlyMap<string, DataNode>,
  nodes: readonly GraphNodeInput[],
  links: readonly GraphLinkInput[],
  namedHubs: number,
  jitter: () => number = () => Math.random() - 0.5,
): Prepared {
  const byId = new Map<string, DataNode>();
  for (const input of nodes) {
    const known = previous.get(input.id);
    byId.set(input.id, known ? Object.assign(known, input, { degree: 0 }) : { ...input, degree: 0 });
  }
  const kept = links.filter((link) => byId.has(link.source) && byId.has(link.target));
  const neighbours = new Map<string, Set<string>>();
  for (const link of kept) {
    byId.get(link.source)!.degree += 1;
    byId.get(link.target)!.degree += 1;
    for (const [a, b] of [[link.source, link.target], [link.target, link.source]] as const) {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      neighbours.get(a)!.add(b);
    }
  }
  for (const node of byId.values()) {
    if (node.x !== undefined) continue;
    const anchor = [...(neighbours.get(node.id) ?? [])].map((id) => byId.get(id)).find((other) => other?.x !== undefined);
    if (anchor) {
      node.x = anchor.x! + jitter() * 30;
      node.y = anchor.y! + jitter() * 30;
    }
  }
  const sorted = [...byId.values()].sort((a, b) => Number(Boolean(b.hub)) - Number(Boolean(a.hub)));
  const named = new Set(sorted.filter((node) => node.hub).sort((a, b) => b.degree - a.degree).slice(0, namedHubs).map((node) => node.id));
  return { shape: shapeOf(nodes, links), byId, nodes: sorted, links: kept, neighbours, named };
}
