/**
 * One frame: links, then nodes, then labels — labels last so no node is drawn over one.
 *
 * What is lit follows the pointer, set by the engine: the node under it and its neighbours stay
 * bright, the rest fades. Labels come with zoom — hubs first, everything else only up close or when
 * pointed at — and one that would overlap a label already placed is left out, so a dense middle
 * shows a few names you can read rather than many you cannot.
 */

import { HALO } from "./hit.ts";
import type { GraphLinkInput, GraphNodeInput, GraphTheme } from "./types.ts";

export type SceneNode = GraphNodeInput & { x?: number; y?: number };
export interface SceneLink {
  source: SceneNode;
  target: SceneNode;
  input: GraphLinkInput;
}

export interface Scene {
  nodes: readonly SceneNode[];
  links: readonly SceneLink[];
  theme: GraphTheme;
  /** What stays bright, or null for everything. */
  lit: ReadonlySet<string> | null;
  /** Pointed at or selected: ringed, and always labelled. */
  focused: ReadonlySet<string>;
  /** Hubs named before any zoom. */
  named: ReadonlySet<string>;
  /** The zoom. */
  k: number;
}

const DIM = 0.1;
const LABEL_MAX = 46;
/** Labels weighed per frame, at most — each is checked against those already placed. */
const LABELS_MAX = 160;
/** Zoom past which every node is labelled, and past which a lit one is. */
const LABEL_ALL_AT = 3.2;
const LABEL_LIT_AT = 2.8;
/** Labels' face when the theme names none. */
const SYSTEM_FONT = "ui-sans-serif, system-ui, sans-serif";

function clip(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1).trimEnd()}…` : label;
}

export function drawLinks(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { theme, lit, k } = scene;
  for (const link of scene.links) {
    const both = lit !== null && lit.has(link.source.id) && lit.has(link.target.id);
    ctx.strokeStyle = lit === null ? (link.input.color ?? theme.link) : both ? (link.input.litColor ?? link.target.color) : theme.linkFaint;
    // Screen pixels, whatever the zoom: a link is a hairline up close as much as far away.
    ctx.lineWidth = (both ? 1.3 : (link.input.width ?? 0.45)) / k;
    ctx.setLineDash(link.input.dashed ? [2 / k, 2 / k] : []);
    ctx.beginPath();
    ctx.moveTo(link.source.x ?? 0, link.source.y ?? 0);
    ctx.lineTo(link.target.x ?? 0, link.target.y ?? 0);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

export function drawNodes(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { theme, lit, focused, k } = scene;
  for (const node of scene.nodes) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const dim = lit !== null && !lit.has(node.id);
    const isFocused = focused.has(node.id);
    const alpha = dim ? DIM : 1;

    ctx.globalAlpha = alpha;
    if (node.hub || isFocused) {
      ctx.beginPath();
      ctx.arc(x, y, node.radius * (isFocused ? 2.3 : HALO), 0, Math.PI * 2);
      ctx.fillStyle = `${node.color}24`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, node.radius, 0, Math.PI * 2);
    ctx.fillStyle = node.color;
    ctx.globalAlpha = alpha * (node.opacity ?? 1);
    ctx.fill();
    if (isFocused) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.6 / k;
      ctx.strokeStyle = theme.text;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

export function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { theme, lit, focused, named, k } = scene;
  const wanted = scene.nodes.filter((node) => {
    if (focused.has(node.id)) return true;
    if (lit !== null && !lit.has(node.id)) return false;
    if (!node.hub) return k > LABEL_ALL_AT || (lit !== null && k > LABEL_LIT_AT);
    return lit !== null || named.has(node.id) || node.radius * k > 9;
  });
  wanted.sort((a, b) => Number(focused.has(b.id)) - Number(focused.has(a.id)) || Number(Boolean(b.hub)) - Number(Boolean(a.hub)) || b.radius - a.radius);

  const placed: [number, number, number, number][] = [];
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  for (const node of wanted.slice(0, LABELS_MAX)) {
    const isFocused = focused.has(node.id);
    const size = (node.hub ? 11.5 : 10) / k;
    ctx.font = `${node.hub ? 650 : 500} ${size}px ${theme.font || SYSTEM_FONT}`;
    const text = node.hub ? node.label : clip(node.label);
    const width = ctx.measureText(text).width;
    const x = node.x ?? 0;
    const top = (node.y ?? 0) + node.radius + 3 / k;
    const box: [number, number, number, number] = [x - width / 2, top, x + width / 2, top + size * 1.2];
    if (!isFocused && placed.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
    placed.push(box);
    ctx.lineWidth = 3.5 / k;
    ctx.strokeStyle = theme.backdrop;
    ctx.strokeText(text, x, top);
    ctx.fillStyle = node.hub || isFocused ? theme.text : theme.muted;
    ctx.fillText(text, x, top);
  }
}
