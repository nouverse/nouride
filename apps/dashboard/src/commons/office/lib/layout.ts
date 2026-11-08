/**
 * Where everything is in the Office (0.8.1, MISSIONS §9), in its own pixels: three rooms — the workroom, the lobby and
 * the bedroom — side by side over a hall, or, on a page too narrow for that, one above another beside a hall down the
 * left. Every agent has a home: its own desk, its own seat on a sofa and its own bed, three to a row, and it is at the
 * one its status says — working or waiting at its desk, idle on its seat, asleep in its bed. The orchestrator's desk
 * stands alone at the front of the workroom, in the middle; the others' desks are in rows behind it. A home is kept
 * while the agent is here, so nobody moves desk because somebody else came or went. Pure: agents in, places out;
 * `route.ts` has the ways between them, `roster.ts` who is here at all.
 */

export type Status = "working" | "waiting" | "idle" | "asleep";
export type Furniture = "desk" | "sofa" | "bed";

export interface Point {
  x: number;
  y: number;
}

/** A place a cat can be: where its 32×32 frame goes, what it is at, and the way from it to the aisle below its row. */
export interface Spot extends Point {
  key: string;
  furniture: Furniture;
  room: number;
  row: number;
  /** The corners from the place to its row's aisle, the place itself left out. */
  out: Point[];
}

export interface OfficeRoom {
  name: "workroom" | "lobby" | "bedroom";
  x: number;
  y: number;
  width: number;
  height: number;
  /** The frame's x of a cat walking its door lane, the strip along the room's left wall. */
  lane: number;
  /** The frame's y of a cat walking each row's aisle, top row first. */
  aisles: number[];
  /** Where its lane meets the hall — its door — and that place on the hall's line, as a cat's frame there. */
  door: Point;
  hallDoor: Point;
}

export interface OfficeLayout {
  width: number;
  height: number;
  /** Side by side over the hall, or one above another beside it (`stacked`, a narrow page). */
  stacked: boolean;
  rooms: OfficeRoom[];
  /** Each desk's left edge and the top of the frame of the cat behind it — the orchestrator's first, when it is here. */
  desks: Point[];
  /** The orchestrator's desk, when it is here: `desks[0]`. */
  lead: Point | null;
  /** Each sofa's left edge and top. */
  sofas: Point[];
  /** Each bed's left edge and top. */
  beds: Point[];
  /** The hall: the strip it fills — across the bottom, or down the left — and the line a cat walks along it. */
  hall: { x: number; y: number; width: number; height: number };
  /** How many agents are in another office (`roster.ts`): a door at the hall's end says so. */
  away: number;
  /** Where each agent is now, by id. */
  places: Map<string, Spot>;
  /** Each agent's home, by id: the index of its desk, seat and bed — the orchestrator's 0. */
  homes: Map<string, number>;
}

export const WALL = 34;
/** A standing cat's feet, from the top of its frame. */
export const FEET = 28;
const TOP = WALL + 4;
const ROW = 48;
const HALL = 28;
/** Under a stacked room's last row: room to walk its aisle before the next room's wall. */
const STACKED_FOOT = 8;
const COLUMNS = 3;
const LANE = 28;
const DESK_PITCH = 64;
const BED_PITCH = 52;
/** A sofa for three, 76 wide: each seat's cat frame from its left edge, and the frame's top from the sofa's. */
const SOFA_SEATS = [-2, 22, 45];
const SEAT_RISE = 15;
/** 544 in all, so a page's 1,088-pixel column — `max-w-6xl` less its padding — draws the office at twice its size. */
const LOBBY_WIDTH = LANE + 6 + 76 + 30;
const WIDTHS = [LANE + COLUMNS * DESK_PITCH, LOBBY_WIDTH, LANE + COLUMNS * BED_PITCH];
/** Side by side, the office is this wide. */
export const SIDE_BY_SIDE_WIDTH = WIDTHS.reduce((sum, width) => sum + width, 0);
/**
 * A page column narrower than this has the rooms one above another: side by side they would be drawn under one and a
 * half times their size, the cats too small to tell apart and their names cut short (a 750-pixel window, 0.8.1).
 */
export const STACK_BELOW = SIDE_BY_SIDE_WIDTH * 1.5;

const AT: Record<Status, Furniture> = { working: "desk", waiting: "desk", idle: "sofa", asleep: "bed" };

/**
 * The layout for these agents — the orchestrator marked `lead` — how many more are in another office, and whether the
 * rooms are `stacked`. `homes` is each one's home last time: kept, so an agent keeps its desk, seat and bed whoever
 * else comes or goes; the orchestrator's is always the first; a new agent takes the first free one, in the order given.
 */
export function layoutOffice(
  agents: readonly { id: string; status: Status; lead?: boolean }[],
  homes: ReadonlyMap<string, number> = new Map(),
  away = 0,
  stacked = false,
): OfficeLayout {
  const lead = agents.find((agent) => agent.lead) ?? null;
  const home = new Map<string, number>();
  if (lead) home.set(lead.id, 0);
  const taken = (index: number) => [...home.values()].includes(index);
  for (const agent of agents) {
    const kept = homes.get(agent.id);
    if (agent !== lead && kept !== undefined && !taken(kept)) home.set(agent.id, kept);
  }
  let free = 0;
  for (const agent of agents) {
    if (home.has(agent.id)) continue;
    while (taken(free)) free += 1;
    home.set(agent.id, free);
  }
  const count = Math.max(agents.length, ...[...home.values()].map((index) => index + 1));
  const others = count - (lead ? 1 : 0);
  // The workroom has a row of its own for the orchestrator's desk; the lobby and the bedroom do not.
  const roomRows = [Math.max(1, (lead ? 1 : 0) + Math.ceil(others / COLUMNS)), Math.max(1, Math.ceil(count / COLUMNS)), Math.max(1, Math.ceil(count / COLUMNS))];
  const sharedRows = Math.max(...roomRows);

  // Side by side: one height, the hall across the bottom. Stacked: each room as tall as its rows, the hall down the left.
  const names = ["workroom", "lobby", "bedroom"] as const;
  const stackedWidth = Math.max(...WIDTHS);
  let along = 0;
  const rooms: OfficeRoom[] = names.map((name, i) => {
    const rows = stacked ? roomRows[i]! : sharedRows;
    const x = stacked ? HALL : along;
    const y = stacked ? along : 0;
    const width = stacked ? stackedWidth : WIDTHS[i]!;
    const height = TOP + rows * ROW + (stacked ? STACKED_FOOT : 0);
    along += stacked ? height : width;
    const aisles = Array.from({ length: rows }, (_, row) => y + TOP + row * ROW + 16);
    // Its door: at the hall's line below its lane, or in its left wall level with its last aisle.
    const door = stacked ? { x, y: aisles.at(-1)! } : { x, y: height + 14 - FEET };
    const hallDoor = stacked ? { x: (HALL - 32) / 2, y: door.y } : door;
    return { name, x, y, width, height, lane: x, aisles, door, hallDoor };
  });
  const [workroom, lobby, bedroom] = rooms as [OfficeRoom, OfficeRoom, OfficeRoom];
  const rowTop = (room: OfficeRoom, row: number) => room.y + TOP + row * ROW;
  const deskAt = (row: number, column: number) => ({ x: workroom.x + LANE + column * DESK_PITCH, y: rowTop(workroom, row) });

  // The orchestrator's in the middle of the front row; the rest three to a row behind it.
  const leadDesk = lead ? deskAt(0, Math.floor(COLUMNS / 2)) : null;
  const desks: Point[] = leadDesk ? [leadDesk] : [];
  for (let i = 0; i < Math.ceil(others / COLUMNS) * COLUMNS; i += 1) desks.push(deskAt((lead ? 1 : 0) + Math.floor(i / COLUMNS), i % COLUMNS));
  const beds: Point[] = [];
  for (let i = 0; i < Math.ceil(count / COLUMNS) * COLUMNS; i += 1) {
    beds.push({ x: bedroom.x + LANE + (i % COLUMNS) * BED_PITCH, y: rowTop(bedroom, Math.floor(i / COLUMNS)) + 14 });
  }
  const sofas = Array.from({ length: Math.max(1, Math.ceil(count / COLUMNS)) }, (_, row) => ({ x: lobby.x + LANE + 6, y: rowTop(lobby, row) + 22 }));

  /** Home `i`'s place at a piece of furniture, and the way out of it: round its side, then down to the aisle. */
  const spotAt = (furniture: Furniture, i: number): Spot => {
    if (furniture === "desk") {
      // Desk 0 is the orchestrator's when it is here, and the others' are counted after it.
      const desk = desks[i]!;
      const row = Math.round((desk.y - workroom.y - TOP) / ROW);
      // Behind the desk to the gap at its right, then down the gap.
      const key = leadDesk && i === 0 ? "desk:lead" : `desk:${i}`;
      return { key, furniture, room: 0, row, x: desk.x + 4, y: desk.y, out: [{ x: desk.x + 36, y: desk.y }, { x: desk.x + 36, y: workroom.aisles[row]! }] };
    }
    const row = Math.floor(i / COLUMNS);
    if (furniture === "bed") {
      const bed = beds[i]!;
      return { key: `bed:${i}`, furniture, room: 2, row, x: bed.x + 1, y: bed.y - 5, out: [{ x: bed.x + 27, y: bed.y - 5 }, { x: bed.x + 27, y: bedroom.aisles[row]! }] };
    }
    const sofa = sofas[row]!;
    const x = sofa.x + SOFA_SEATS[i % COLUMNS]!;
    return { key: `sofa:${i}`, furniture, room: 1, row, x, y: sofa.y - SEAT_RISE, out: [{ x, y: lobby.aisles[row]! }] };
  };

  const places = new Map<string, Spot>();
  for (const agent of agents) places.set(agent.id, spotAt(AT[agent.status], home.get(agent.id)!));
  const width = stacked ? HALL + stackedWidth : along;
  const height = stacked ? along : sharedRows * ROW + TOP + HALL;
  return {
    width,
    height,
    stacked,
    rooms,
    desks,
    lead: leadDesk,
    sofas,
    beds,
    hall: stacked ? { x: 0, y: 0, width: HALL, height } : { x: 0, y: height - HALL, width, height: HALL },
    away,
    places,
    homes: home,
  };
}

/**
 * How large the office is drawn in a page this wide. Side by side: a whole scale, up to 4, where the page holds twice
 * the office, and a half step below that, which a screen of two pixels to the point still draws square. Stacked: the
 * page's whole width on a phone, and twice its size at most — the rooms one above another are tall already.
 */
export function scaleFor(width: number, officeWidth: number, stacked = false): number {
  const fits = width / officeWidth;
  if (stacked) return Math.min(2, fits);
  if (fits >= 2) return Math.min(4, Math.floor(fits));
  return fits >= 1 ? Math.floor(fits * 2) / 2 : fits;
}
