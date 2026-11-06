/**
 * A force-directed graph on one canvas.
 *
 * - **Layout**: `d3-force`, settled partly before the first frame so it opens as a shape rather than
 *   a burst, then left to finish on screen. It stops once it settles, and nothing is drawn after that
 *   until something changes — an open graph in a background tab costs nothing.
 * - **Camera**: `d3-zoom`, which handles wheel, pinch, and a pan released anywhere, including outside
 *   the canvas.
 * - **Pointer**: ours. Hit by distance (`hit.ts`); a press that travels less than
 *   `CLICK_TOLERANCE_PX` is a click whatever the mouse did on the way; the pointer is captured on
 *   press, so a release over something drawn on top of the canvas still ends the gesture.
 *
 * Positions are kept by id across `setData`, so changing a filter moves the graph instead of
 * re-laying it from nothing.
 */

import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from "d3-force";
import { quadtree, type Quadtree } from "d3-quadtree";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { drawLabels, drawLinks, drawNodes, type Scene, type SceneLink } from "./draw.ts";
import { prepareData, type DataNode } from "./data.ts";
import { CLICK_TOLERANCE_PX, hitRadius, pick } from "./hit.ts";
import type { GraphLinkInput, GraphNodeInput, GraphTheme, GraphViewOptions } from "./types.ts";

type Node = DataNode;
type Link = { source: string | Node; target: string | Node; input: GraphLinkInput };

/** Hubs named before any zoom: enough to read the map, few enough not to cover it. */
const NAMED_HUBS = 14;
const ZOOM_EXTENT: [number, number] = [0.15, 12];
const FOCUS_ZOOM = 2.2;
const FIT_PADDING = 48;
const MOVE_MS = 600;

interface Press {
  pointer: number;
  x: number;
  y: number;
  node: Node | null;
  dragging: boolean;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

export class GraphView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sim: Simulation<Node, Link>;
  private readonly camera: ZoomBehavior<HTMLCanvasElement, unknown>;
  private readonly resizer: ResizeObserver;
  private theme: GraphTheme;
  private readonly onSelect: (id: string | null) => void;

  private nodes: Node[] = [];
  private links: Link[] = [];
  private byId = new Map<string, Node>();
  private neighbours = new Map<string, Set<string>>();
  private named = new Set<string>();
  private tree: Quadtree<Node> | null = null;
  private reach = 0;
  /** The ids of the nodes and links last laid out — a restyle that keeps them does not move anything. */
  private shape = "";

  private transform: ZoomTransform = zoomIdentity;
  private width = 0;
  private height = 0;
  private frame = 0;
  private tween = 0;
  /** Fit to the screen once the layout settles, unless the person has moved the view since. */
  private fitPending = false;

  private hover: string | null = null;
  private selected: string | null = null;
  private highlighted: ReadonlySet<string> = new Set();
  private press: Press | null = null;

  constructor(container: HTMLElement, options: GraphViewOptions) {
    this.theme = options.theme;
    this.onSelect = options.onSelect ?? (() => {});

    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "none", cursor: "grab", userSelect: "none" });
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.sim = forceSimulation<Node, Link>()
      .alphaDecay(0.03)
      .velocityDecay(0.35)
      .force("link", forceLink<Node, Link>().id((node) => node.id).distance((link) => link.input.distance ?? 40))
      .force("charge", forceManyBody<Node>().strength((node) => (node.hub ? -70 - Math.min(node.degree, 200) * 1.5 : -22)).distanceMax(420))
      // Weak, so a node with few links stays near the rest instead of drifting to the edge.
      .force("x", forceX<Node>(0).strength(0.02))
      .force("y", forceY<Node>(0).strength(0.02))
      .on("tick", () => {
        this.tree = null;
        this.draw();
      })
      .on("end", () => {
        if (this.fitPending) this.fit();
      })
      .stop();

    this.camera = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent(ZOOM_EXTENT)
      // A press on a node is a click or a drag, ours; anywhere else d3 pans. Wheel always zooms.
      .filter((event: Event) => event.type === "wheel" || (event.type !== "dblclick" && !(event as MouseEvent).button && !this.press?.node))
      .on("zoom", (event: { transform: ZoomTransform; sourceEvent: Event | null }) => {
        this.transform = event.transform;
        if (event.sourceEvent) {
          this.fitPending = false;
          cancelAnimationFrame(this.tween);
        }
        this.draw();
      });
    select(this.canvas).call(this.camera).on("dblclick.zoom", null);

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);

    this.resizer = new ResizeObserver(([entry]) => {
      if (entry) this.resize(entry.contentRect.width, entry.contentRect.height);
    });
    this.resizer.observe(container);
  }

  // ─── data ───

  setData(nodes: readonly GraphNodeInput[], links: readonly GraphLinkInput[]): void {
    const first = this.nodes.length === 0;
    const next = prepareData(this.byId, nodes, links, NAMED_HUBS);
    const restyle = next.shape === this.shape;
    this.shape = next.shape;
    this.byId = next.byId;
    this.neighbours = next.neighbours;
    this.nodes = next.nodes;
    this.links = next.links.map((input) => ({ source: input.source, target: input.target, input }));
    this.named = next.named;
    this.reach = 0;
    for (const node of this.nodes) this.reach = Math.max(this.reach, hitRadius(node, ZOOM_EXTENT[0]));
    if (this.hover && !next.byId.has(this.hover)) this.hover = null;

    if (restyle) {
      // Same nodes and links, new colours or sizes — a theme switch. Redraw where everything already is.
      this.sim.force<ReturnType<typeof forceLink<Node, Link>>>("link")!.links(this.links);
      this.draw();
      return;
    }
    this.sim.nodes(this.nodes);
    this.sim.force<ReturnType<typeof forceLink<Node, Link>>>("link")!.links(this.links);
    this.tree = null;
    this.fitPending = true;
    if (first) {
      // Most of the settling before the first frame, so it opens as a shape.
      this.sim.alpha(1);
      this.sim.tick(this.nodes.length > 600 ? 40 : 80);
      this.fit(0);
    } else {
      this.sim.alpha(0.6);
    }
    this.sim.restart();
  }

  setTheme(theme: GraphTheme): void {
    this.theme = theme;
    this.draw();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.draw();
  }

  /** What to light when nothing is pointed at or selected — search matches. */
  setHighlighted(ids: ReadonlySet<string>): void {
    this.highlighted = ids;
    this.draw();
  }

  // ─── camera ───

  /** Bring a node to the middle of what is visible — `offset` is how much of each edge something covers, in pixels. */
  focus(id: string, offset: { right?: number; bottom?: number } = {}): void {
    const node = this.byId.get(id);
    if (!node || node.x === undefined || node.y === undefined) return;
    const k = Math.max(this.transform.k, FOCUS_ZOOM);
    const cx = (this.width - (offset.right ?? 0)) / 2;
    const cy = (this.height - (offset.bottom ?? 0)) / 2;
    this.moveTo(zoomIdentity.translate(cx - node.x * k, cy - node.y * k).scale(k), MOVE_MS);
  }

  zoomBy(factor: number): void {
    const t = this.transform;
    const k = Math.min(ZOOM_EXTENT[1], Math.max(ZOOM_EXTENT[0], t.k * factor));
    const [gx, gy] = t.invert([this.width / 2, this.height / 2]);
    this.moveTo(zoomIdentity.translate(this.width / 2 - gx * k, this.height / 2 - gy * k).scale(k), 250);
  }

  fit(duration = 700): void {
    // Before the first resize there is nothing to fit into; it stays pending, and the resize fits.
    if (!this.nodes.length || !this.width || !this.height) return;
    this.fitPending = false;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const node of this.nodes) {
      x0 = Math.min(x0, (node.x ?? 0) - node.radius);
      y0 = Math.min(y0, (node.y ?? 0) - node.radius);
      x1 = Math.max(x1, (node.x ?? 0) + node.radius);
      y1 = Math.max(y1, (node.y ?? 0) + node.radius);
    }
    const k = Math.min(ZOOM_EXTENT[1], Math.max(ZOOM_EXTENT[0], Math.min((this.width - FIT_PADDING * 2) / (x1 - x0 || 1), (this.height - FIT_PADDING * 2) / (y1 - y0 || 1))));
    this.moveTo(zoomIdentity.translate(this.width / 2 - ((x0 + x1) / 2) * k, this.height / 2 - ((y0 + y1) / 2) * k).scale(k), duration);
  }

  private moveTo(target: ZoomTransform, duration: number): void {
    cancelAnimationFrame(this.tween);
    const canvas = select(this.canvas);
    if (!duration) {
      this.camera.transform(canvas, target);
      return;
    }
    const from = this.transform;
    const start = performance.now();
    const step = (now: number) => {
      const t = easeOut(Math.min(1, (now - start) / duration));
      const k = from.k + (target.k - from.k) * t;
      this.camera.transform(canvas, zoomIdentity.translate(from.x + (target.x - from.x) * t, from.y + (target.y - from.y) * t).scale(k));
      if (t < 1) this.tween = requestAnimationFrame(step);
    };
    this.tween = requestAnimationFrame(step);
  }

  // ─── pointer ───

  private local(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private nodeAt(point: { x: number; y: number }): Node | null {
    if (!this.nodes.length) return null;
    this.tree ??= quadtree<Node>().x((node) => node.x ?? 0).y((node) => node.y ?? 0).addAll(this.nodes);
    const [x, y] = this.transform.invert([point.x, point.y]);
    return pick(this.tree, x, y, this.transform.k, this.reach);
  }

  private setHover(id: string | null): void {
    if (!this.press) this.canvas.style.cursor = id ? "pointer" : "grab";
    if (id === this.hover) return;
    this.hover = id;
    this.draw();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const point = this.local(event);
    const node = this.nodeAt(point);
    this.press = { pointer: event.pointerId, ...point, node, dragging: false };
    this.canvas.setPointerCapture(event.pointerId);
    cancelAnimationFrame(this.tween);
    if (node) this.setHover(node.id);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = this.local(event);
    const press = this.press;
    if (!press || press.pointer !== event.pointerId) {
      this.setHover(this.nodeAt(point)?.id ?? null);
      return;
    }
    // A press on the background is d3's pan; nothing to hover while it lasts.
    if (!press.node) return;
    if (!press.dragging && Math.hypot(point.x - press.x, point.y - press.y) > CLICK_TOLERANCE_PX) {
      press.dragging = true;
      this.fitPending = false;
      this.canvas.style.cursor = "grabbing";
      this.sim.alphaTarget(0.25).restart();
    }
    if (press.dragging) {
      const [x, y] = this.transform.invert([point.x, point.y]);
      press.node.fx = x;
      press.node.fy = y;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const press = this.press;
    if (!press || press.pointer !== event.pointerId) return;
    const point = this.local(event);
    this.end(press);
    const moved = Math.hypot(point.x - press.x, point.y - press.y) > CLICK_TOLERANCE_PX;
    if (press.node && !press.dragging) this.onSelect(press.node.id);
    else if (!press.node && !moved) this.onSelect(null);
    this.setHover(this.nodeAt(point)?.id ?? null);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.press?.pointer === event.pointerId) this.end(this.press);
  };

  private readonly onPointerLeave = (): void => {
    if (!this.press) this.setHover(null);
  };

  private end(press: Press): void {
    this.press = null;
    if (this.canvas.hasPointerCapture(press.pointer)) this.canvas.releasePointerCapture(press.pointer);
    if (press.node && press.dragging) {
      press.node.fx = null;
      press.node.fy = null;
      this.sim.alphaTarget(0);
    }
  }

  // ─── drawing ───

  private resize(width: number, height: number): void {
    const ratio = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    if (this.fitPending && this.nodes.length) this.fit(0);
    this.draw();
  }

  /** Ask for a frame; several asks before it comes are one frame. */
  private draw(): void {
    if (!this.frame) this.frame = requestAnimationFrame(this.paint);
  }

  private readonly paint = (): void => {
    this.frame = 0;
    const { ctx, transform: t } = this;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(ratio * t.k, 0, 0, ratio * t.k, ratio * t.x, ratio * t.y);

    const focus = this.hover ?? this.selected;
    const lit = focus ? new Set([focus, ...(this.neighbours.get(focus) ?? [])]) : this.highlighted.size ? this.highlighted : null;
    const scene: Scene = {
      nodes: this.nodes,
      links: this.links as SceneLink[],
      theme: this.theme,
      lit,
      focused: new Set([this.hover, this.selected].filter((id): id is string => id !== null)),
      named: this.named,
      k: t.k,
    };
    drawLinks(ctx, scene);
    drawNodes(ctx, scene);
    drawLabels(ctx, scene);
  };

  destroy(): void {
    this.sim.stop();
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.tween);
    this.resizer.disconnect();
    select(this.canvas).on(".zoom", null);
    this.canvas.remove();
  }
}
