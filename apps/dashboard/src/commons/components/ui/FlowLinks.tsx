/**
 * The jumps of a flow, drawn over it: a curved line at the side from where each one leaves to the step it lands on.
 * The flow's own markup says where those are, each by its `data-flow-anchor`, and this measures them: a picture laid over the
 * cards, never part of their layout, so a card that grows or moves is followed and nothing is positioned by hand.
 *
 * It is drawn inside the flow's box, the nearest element marked `data-flow`, which is `relative`: the picture fills
 * it, and every place is measured in it. Measured again when that box changes size, when the window does, and
 * whenever `version` changes (a step moved, a card opened). Drawn in the room the flow keeps at its side
 * (`FLOW_SIDE`); a flow too narrow for it, a phone's, draws none, and says each jump in words where it leaves.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { arrowHead, jumpPath, lanes, type Span } from "@/commons/lib/flow-path";
import { cn } from "@/commons/lib/utils";

/** One jump: the anchor it leaves from and the anchor it lands on, by their names in the flow. */
export interface FlowLink {
  key: string;
  from: string;
  to: string;
  /** The run took it: drawn stronger, in the colour of what is done. */
  taken?: boolean;
}

/** The room a flow keeps at its right for these lines, from a tablet's width up: the class its column carries. */
export const FLOW_SIDE = "md:pr-16";
/** How far inside that room the first lane runs, and how far apart the lanes are. */
const FIRST_LANE = 18;
const LANE_GAP = 11;

interface Drawn extends Span {
  side: number;
}

/**
 * Where an element is in the flow's box, by its place in the layout and not as it is drawn: a card sliding to a new
 * place, or held by the pointer, is measured where it belongs, so a line never points at where a card used to be.
 */
function placeIn(flow: HTMLElement, element: HTMLElement): { left: number; top: number; width: number; height: number } {
  let [left, top] = [0, 0];
  for (let node: HTMLElement | null = element; node && node !== flow; node = node.offsetParent as HTMLElement | null) {
    left += node.offsetLeft;
    top += node.offsetTop;
  }
  return { left, top, width: element.offsetWidth, height: element.offsetHeight };
}

function measure(flow: HTMLElement, links: readonly FlowLink[]): Drawn[] {
  const anchor = (name: string) => {
    const found = flow.querySelector<HTMLElement>(`[data-flow-anchor="${name}"]`);
    return found ? placeIn(flow, found) : null;
  };
  const spans = links.flatMap((link): Span[] => {
    const [from, to] = [anchor(link.from), anchor(link.to)];
    if (!from || !to) return [];
    // Out from the middle of where it leaves, in to the head of the card it lands on, a little below its top edge.
    return [{ key: link.key, from: { x: from.left + from.width, y: from.top + from.height / 2 }, to: { x: to.left + to.width + 7, y: to.top + Math.min(30, to.height / 2) } }];
  });
  const lane = lanes(spans);
  const edge = Math.max(0, ...spans.map((span) => span.to.x));
  return spans.map((span) => ({ ...span, side: edge + FIRST_LANE + (lane.get(span.key) ?? 0) * LANE_GAP }));
}

export function FlowLinks({
  links,
  active,
  version,
  className,
}: {
  links: readonly FlowLink[];
  /** The jump the pointer or the focus is on: drawn in the colour of where you are. */
  active: string | null;
  /** Anything that changes when the cards may have moved. */
  version: unknown;
  className?: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  const wanted = links.map((link) => `${link.key} ${link.from} ${link.to}`).join("\n");

  useLayoutEffect(() => {
    // Found from the layer itself: a ref of the flow's own is not set yet when this first runs, a child's effect
    // running before its parent's ref, and the first drawing found no flow to measure.
    const flow = layer.current?.closest<HTMLElement>("[data-flow]");
    if (!flow) return;
    const redraw = () => setDrawn(measure(flow, links));
    redraw();
    window.addEventListener("resize", redraw);
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redraw);
    watch?.observe(flow);
    return () => {
      window.removeEventListener("resize", redraw);
      watch?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `links` by what it says (`wanted`), not by its identity
  }, [wanted, version]);

  return (
    <div ref={layer} aria-hidden="true" className={cn("pointer-events-none absolute inset-0 max-md:hidden", className)}>
      <svg className="size-full overflow-visible">
        {drawn.map((jump) => {
          const state = active === jump.key ? "active" : links.find((link) => link.key === jump.key)?.taken ? "taken" : "idle";
          const tone = state === "active" ? "text-secondary" : state === "taken" ? "text-success" : "text-base-content";
          return (
            // A line nobody is asking about is a faint row of dots: there, and out of the cards' way.
            <g key={jump.key} data-flow-link={jump.key} data-state={state} opacity={state === "idle" ? 0.4 : 1} className={cn("transition-colors duration-150", tone)}>
              <path d={jumpPath(jump.from, jump.to, jump.side)} fill="none" stroke="currentColor" strokeWidth={state === "idle" ? 1.5 : 2.25} strokeLinecap="round" strokeDasharray={state === "idle" ? "1 5" : undefined} />
              <path d={arrowHead(jump.to)} fill="currentColor" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
