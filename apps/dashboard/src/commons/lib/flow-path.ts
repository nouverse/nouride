/**
 * The line a jump is drawn with, in a flow that reads top to bottom: out to the side from where it starts, down a
 * lane of its own, and back in to the step it lands on. Pure geometry, so it is tested without a browser
 * (`tests/flow-path.test.ts`); `FlowLinks` measures the page and draws what this returns.
 */

export interface Point {
  x: number;
  y: number;
}

/** A jump as it is measured: where it leaves, where it lands, both in the flow's own box. */
export interface Span {
  key: string;
  from: Point;
  to: Point;
}

/**
 * A lane for each jump, so two whose stretches down the side overlap are not drawn on one line. The first free lane,
 * taken in the order the jumps start: a jump that ends before the next begins shares its lane.
 */
export function lanes(spans: readonly Span[]): Map<string, number> {
  const ends: number[] = [];
  const taken = new Map<string, number>();
  for (const span of [...spans].sort((a, b) => a.from.y - b.from.y || a.to.y - b.to.y)) {
    let lane = ends.findIndex((end) => end < span.from.y);
    if (lane < 0) lane = ends.length;
    ends[lane] = span.to.y;
    taken.set(span.key, lane);
  }
  return taken;
}

/**
 * The path of one jump: a straight run out to `side`, a rounded turn down, a rounded turn back, and a run in to the
 * step it lands on. The corners are as round as the room allows: a jump of a few pixels is still a curve, not a kink.
 */
export function jumpPath(from: Point, to: Point, side: number, radius = 14): string {
  const down = Math.max(0, to.y - from.y);
  const r = Math.max(0, Math.min(radius, down / 2, side - from.x, side - to.x));
  return [
    `M ${from.x} ${from.y}`,
    `H ${side - r}`,
    `Q ${side} ${from.y} ${side} ${from.y + r}`,
    `V ${to.y - r}`,
    `Q ${side} ${to.y} ${side - r} ${to.y}`,
    `H ${to.x}`,
  ].join(" ");
}

/**
 * The path of a lane's way back into the main line: from where the lane ends, a run to the side it goes down, a
 * rounded turn down beside the steps, and in to the step it goes back to. Down the gap between the steps and a lane
 * that stands beside them (`side` between the two), or down the steps' far side for a lane that hangs under its step
 * (`side` past both): each turn is made toward where it leads.
 */
export function returnPath(from: Point, to: Point, side: number, radius = 14): string {
  const down = Math.max(0, to.y - from.y);
  const r = Math.max(0, Math.min(radius, down / 2, Math.abs(from.x - side), Math.abs(to.x - side)));
  const [out, back] = [from.x >= side ? 1 : -1, to.x >= side ? 1 : -1];
  return [
    `M ${from.x} ${from.y}`,
    `H ${side + out * r}`,
    `Q ${side} ${from.y} ${side} ${from.y + r}`,
    `V ${to.y - r}`,
    `Q ${side} ${to.y} ${side + back * r} ${to.y}`,
    `H ${to.x}`,
  ].join(" ");
}

/** The arrow's head where a jump lands, pointing in at the step from the side it came down: its right, or its left. */
export function arrowHead(at: Point, size = 6, from: "right" | "left" = "right"): string {
  return `M ${at.x} ${at.y} l ${from === "right" ? size : -size} ${-size * 0.7} v ${size * 1.4} z`;
}
