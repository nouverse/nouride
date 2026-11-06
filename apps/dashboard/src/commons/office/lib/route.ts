/**
 * The way a cat walks from one place to another in the Office (0.8.1): out from its furniture to the aisle below its
 * row, along the aisle to its room's door lane, along the lane to its door and out to the hall, along the hall, and the
 * same the other way round into the room it is going to — never through a wall or a desk, whether the rooms are side
 * by side or one above another. Pure: corners in, corners and a position along them out.
 */

import type { OfficeLayout, Point, Spot } from "./layout";

export function route(layout: Pick<OfficeLayout, "rooms">, from: Spot, to: Spot): Point[] {
  if (from.key === to.key) return [{ x: to.x, y: to.y }];
  const leave = [{ x: from.x, y: from.y }, ...from.out];
  const arrive = [...[...to.out].reverse(), { x: to.x, y: to.y }];
  const out = leave.at(-1)!;
  const into = arrive[0]!;
  const middle: Point[] = [];
  if (from.room === to.room && from.row !== to.row) {
    // Up or down its own room's lane, from one aisle to the other.
    const lane = layout.rooms[from.room]!.lane;
    middle.push({ x: lane, y: out.y }, { x: lane, y: into.y });
  } else if (from.room !== to.room) {
    // Along its lane to its door, out to the hall, along it to the other room's door, and in along that room's lane.
    const away = layout.rooms[from.room]!;
    const back = layout.rooms[to.room]!;
    middle.push({ x: away.lane, y: out.y }, away.door, away.hallDoor, back.hallDoor, back.door, { x: back.lane, y: into.y });
  }
  return straightened([...leave, ...middle, ...arrive]);
}

/**
 * The same way with no corner it does not turn at: a point repeated, or one on the line between its neighbours — which
 * is also a way back along the line it came, so a cat sent back the way it was walking turns round where it is.
 */
export function straightened(points: readonly Point[]): Point[] {
  let way = [...points];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 1; i < way.length; i += 1) {
      const [a, b, c] = [way[i - 1]!, way[i]!, way[i + 1]];
      const same = a.x === b.x && a.y === b.y;
      const inLine = c !== undefined && ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y));
      if (same || inLine) {
        way = [...way.slice(0, i), ...way.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return way;
}

export function lengthOf(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.abs(points[i]!.x - points[i - 1]!.x) + Math.abs(points[i]!.y - points[i - 1]!.y);
  return length;
}

/**
 * Where a cat is this far along its way, which way it faces — the way it last went sideways, or none yet — and the
 * corners it has still to reach.
 */
export function along(points: readonly Point[], distance: number): { at: Point; facing: "left" | "right" | null; ahead: Point[] } {
  let left = Math.max(0, distance);
  let facing: "left" | "right" | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1]!, points[i]!];
    if (b.x !== a.x) facing = b.x < a.x ? "left" : "right";
    const step = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (left < step) {
      const t = left / step;
      return { at: { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) }, facing, ahead: points.slice(i) };
    }
    left -= step;
  }
  return { at: { ...points.at(-1)! }, facing, ahead: [] };
}
