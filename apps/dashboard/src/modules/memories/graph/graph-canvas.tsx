/**
 * Memory's graph on `@nouride/ui-graph`: this file decides how memory looks — a colour per kind, a
 * size per importance or reach, which links are dashed — and the package draws it, lays it out and
 * answers the pointer. It knows nothing of conversations, and this file nothing of canvases.
 *
 * The engine is made once per page and fed what changes, so a filter or a hover never rebuilds it.
 */

import { GraphView, type GraphLinkInput, type GraphNodeInput } from "@nouride/ui-graph";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { GraphLink, GraphNode, GraphNodeKind, MemoryGraph } from "@/commons/lib/api.memory";
import { usePalette, type Palette } from "./palette";

const LINK_DISTANCE: Record<GraphLink["kind"], number> = { related: 26, tag: 46, participant: 64, mention: 72, agent: 86, link: 30, similar: 34, collection: 52, about: 70 };
/** The side panel's width plus its margin (`sm:w-80` and `right-3`), in pixels. */
const PANEL_WIDTH = 344;
/** Where the panel moves to the bottom (`sm:`), and how much of the canvas it then covers. */
const WIDE_PX = 640;
const PANEL_BOTTOM = 0.55;

/** What a conversation or a document is, a dot among many; the rest are hubs, which join them. */
const isLeaf = (kind: GraphNodeKind) => kind === "episode" || kind === "document";

function radius(node: GraphNode): number {
  if (node.kind === "episode") return 2.4 + (node.importance ?? 2) * 0.55;
  if (node.kind === "document") return 3.2 + Math.min(2, Math.sqrt(node.degree) * 0.4);
  return Math.min(20, 3.6 + Math.sqrt(node.degree) * 1.15);
}

function toNodes(graph: MemoryGraph, hidden: ReadonlySet<GraphNodeKind>, palette: Palette): GraphNodeInput[] {
  return graph.nodes
    .filter((node) => !hidden.has(node.kind))
    .map((node) => ({
      id: node.id,
      label: node.kind === "tag" ? `#${node.label}` : node.label,
      color: palette.kinds[node.kind],
      radius: radius(node),
      hub: !isLeaf(node.kind),
      ...(node.kind === "episode" ? { opacity: 0.55 + (node.importance ?? 2) * 0.09 } : node.kind === "document" ? { opacity: 0.8 } : {}),
    }));
}

function toLinks(graph: MemoryGraph, palette: Palette): GraphLinkInput[] {
  return graph.links.map((link) => ({
    source: link.source,
    target: link.target,
    distance: LINK_DISTANCE[link.kind],
    // Talked about, and close in meaning: a looser tie than taking part or a link, so dashed.
    ...(link.kind === "mention" || link.kind === "similar" ? { dashed: true } : {}),
    ...(link.kind === "related" ? { color: palette.related, litColor: palette.kinds.episode, width: 0.8 } : {}),
  }));
}

export interface GraphCanvasProps {
  graph: MemoryGraph;
  hidden: ReadonlySet<GraphNodeKind>;
  selected: string | null;
  /** Labels matching the search box; empty lights nothing. */
  matches: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
}

export function GraphCanvas({ graph, hidden, selected, matches, onSelect }: GraphCanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<GraphView | null>(null);
  const palette = usePalette();
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const theme = useMemo(
    () => ({ text: palette.text, muted: palette.muted, backdrop: palette.backdrop, link: palette.link, linkFaint: palette.linkFaint, font: palette.font }),
    [palette],
  );

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const instance = new GraphView(el, { theme, onSelect: (id) => onSelectRef.current(id) });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one engine for the page's life; what changes is fed below
  }, []);

  useEffect(() => view.current?.setData(toNodes(graph, hidden, palette), toLinks(graph, palette)), [graph, hidden, palette]);
  useEffect(() => {
    view.current?.setTheme(theme);
    // A canvas does not redraw when a font arrives, so labels drawn before the page's face loaded are drawn again.
    void document.fonts?.ready.then(() => view.current?.setTheme(theme));
  }, [theme]);
  useEffect(() => view.current?.setHighlighted(matches), [matches]);

  // Selected from anywhere — a click, the search box, the side panel: lit, and brought into view.
  useEffect(() => {
    view.current?.setSelected(selected);
    if (!selected || !box.current) return;
    const wide = box.current.clientWidth >= WIDE_PX;
    view.current?.focus(selected, wide ? { right: PANEL_WIDTH } : { bottom: box.current.clientHeight * PANEL_BOTTOM });
  }, [selected]);

  return (
    <div className="relative h-full w-full">
      <div ref={box} className="absolute inset-0" />
      <div className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-xl border border-base-content/[0.08] bg-base-100/85 shadow-sm backdrop-blur">
        <button type="button" className="btn btn-ghost btn-sm btn-square rounded-none" aria-label="Zoom in" onClick={() => view.current?.zoomBy(1.4)}>
          <Plus size={15} />
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-square rounded-none" aria-label="Zoom out" onClick={() => view.current?.zoomBy(1 / 1.4)}>
          <Minus size={15} />
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-square rounded-none border-t border-base-content/[0.08]" aria-label="Fit to screen" onClick={() => view.current?.fit(500)}>
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}
