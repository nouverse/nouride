/**
 * The jumps of a flow, drawn over it: a curved line at the side from where each one leaves to the step it lands on.
 * The flow's own markup says where those are, each by its `data-flow-anchor`, and this measures them: a picture laid over the
 * cards, never part of their layout, so a card that grows or moves is followed and nothing is positioned by hand.
 *
 * It is drawn inside the flow's box, the nearest element marked `data-flow`, which is `relative`: the picture fills
 * it, and every place is measured in it. Measured again when that box changes size, when the window does, and
 * whenever `version` changes (a step moved, a card opened). Drawn in the room the flow keeps at its side
 * (`FLOW_SIDE`); a flow too narrow for it, a phone's, draws none, and says each jump in words where it leaves.
 *
 * A lane's way back into the main line is drawn here too (`back`): a thread from the lane's end to the step it goes
 * back to. "Then back to step 2" was words alone, and with four boxes of one title a person could not see which box
 * they meant. Down the gap between the steps and a lane that stands beside them; down the steps' other side for a
 * lane that hangs under its step, where the flow has room there. On a phone the boxes fill the flow, and the words
 * are the whole of it.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { arrowHead, jumpPath, lanes, returnPath, type Span } from "@/commons/lib/flow-path";
import { cn } from "@/commons/lib/utils";

/** One jump: the anchor it leaves from and the anchor it lands on, by their names in the flow. */
export interface FlowLink {
  key: string;
  from: string;
  to: string;
  /** The run took it: drawn stronger, in the colour of what is done. */
  taken?: boolean;
  /** A lane's way back: it leaves from the near side of where the lane ends, and runs down beside the steps. */
  back?: boolean;
}

/** The room a flow keeps at its right for these lines, from a tablet's width up: the class its column carries. */
export const FLOW_SIDE = "md:pr-16";
/** How far inside that room the first lane runs, and how far apart the lanes are. */
const FIRST_LANE = 18;
const LANE_GAP = 11;

/** How far past the steps' edge a way back runs down, and the least room between a lane and the steps for one to be drawn. */
const BACK_FIRST = 16;
const BACK_ROOM = 34;
/** The least a way back down the steps' left stands in from the flow's own edge. */
const BACK_LEAST = 6;

interface Drawn extends Span {
  side: number;
  back: boolean;
  /** It comes in at the step's left: a way back down the steps' far side. */
  left: boolean;
}

interface Placed {
  left: number;
  top: number;
  width: number;
  height: number;
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
  const ends = (link: FlowLink): { from: Placed; to: Placed }[] => {
    const [from, to] = [anchor(link.from), anchor(link.to)];
    return from && to ? [{ from, to }] : [];
  };
  // In to the head of the card it lands on, a little below its top edge.
  const head = (to: Placed) => to.top + Math.min(30, to.height / 2);
  // A jump leaves from the far end of its chip, out to the side of the flow.
  const jumps = links.filter((link) => !link.back).flatMap((link) => ends(link).map(({ from, to }): Span => ({ key: link.key, from: { x: from.left + from.width, y: from.top + from.height / 2 }, to: { x: to.left + to.width + 7, y: head(to) } })));
  // A way back leaves from the near end of where its lane ends. Beside the steps it runs down the gap between them
  // and comes in at the step's right; from a lane under its step it runs down the steps' left and comes in there.
  const backs = links.filter((link) => link.back).flatMap((link) => ends(link).map(({ from, to }) => ({ key: link.key, from: { x: from.left - 4, y: from.top + from.height / 2 }, right: to.left + to.width + 7, left: to.left - 7, y: head(to) })));
  const beside = backs.filter((back) => back.from.x - back.right >= BACK_ROOM).map((back): Span => ({ key: back.key, from: back.from, to: { x: back.right, y: back.y } }));
  const under = backs.filter((back) => back.from.x - back.right < BACK_ROOM).map((back): Span => ({ key: back.key, from: back.from, to: { x: back.left, y: back.y } }));
  const [lane, gap, far] = [lanes(jumps), lanes(beside), lanes(under)];
  const edge = Math.max(0, ...jumps.map((jump) => jump.to.x));
  return [
    ...jumps.map((jump) => ({ ...jump, back: false, left: false, side: edge + FIRST_LANE + (lane.get(jump.key) ?? 0) * LANE_GAP })),
    // Each beside the step it lands on; two whose stretches overlap, a little apart.
    ...beside.map((back) => ({ ...back, back: true, left: false, side: back.to.x + BACK_FIRST + (gap.get(back.key) ?? 0) * LANE_GAP })),
    // Only where the flow has room left of its steps: on a phone they fill it.
    ...under.map((back) => ({ ...back, back: true, left: true, side: Math.min(back.from.x, back.to.x) - BACK_FIRST - (far.get(back.key) ?? 0) * LANE_GAP })).filter((back) => back.side >= BACK_LEAST),
  ];
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
          // A way back is in the colour of its lane's end, which says the same in words, and is a dashed thread
          // that is seen at rest: it is how the lane is read, where a jump's line is an aside.
          const tone = state === "active" ? "text-secondary" : state === "taken" || jump.back ? "text-success" : "text-base-content";
          const idle = state === "idle";
          return (
            // A line nobody is asking about is a faint row of dots: there, and out of the cards' way.
            <g key={jump.key} data-flow-link={jump.key} data-back={jump.back ? "" : undefined} data-state={state} opacity={idle ? (jump.back ? 0.75 : 0.4) : 1} className={cn("transition-colors duration-150", tone)}>
              <path d={jump.back ? returnPath(jump.from, jump.to, jump.side) : jumpPath(jump.from, jump.to, jump.side)} fill="none" stroke="currentColor" strokeWidth={idle ? (jump.back ? 1.75 : 1.5) : 2.25} strokeLinecap="round" strokeDasharray={idle ? (jump.back ? "5 5" : "1 5") : undefined} />
              <path d={arrowHead(jump.to, 6, jump.left ? "left" : "right")} fill="currentColor" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
