/**
 * The Office's rooms, painted once per layout, theme and time of day (0.8.1): walls with their windows, the sign on
 * the lobby's wall, the floors, the walls between the rooms, the hall — along the bottom, or down the left when the
 * rooms are one above another — with a door into each room, and the furniture nothing is drawn in front of. What is in front of a cat — a desk, a blanket, a sofa's seat — and the
 * clock's hands are drawn each frame, by the scene.
 */

import { BED_BACK, CHAIR, COFFEE, FURNITURE_PALETTE, PLANT, SHELF, SOFA_BACK } from "../art/furniture";
import { sign } from "../art/lettering";
import { WALL, type OfficeLayout } from "./layout";
import { mapSprite } from "./sprites";

export type Theme = "light" | "dark";

const COLORS = {
  light: { wall: "#ebe6d8", wallShade: "#d9d1bd", base: "#b9a98a", floors: ["#d9c7a6", "#cfdbc9", "#dcd3ea"], line: "#c8bfa8", hall: ["#e6dfcf", "#dcd3bf"], rug: ["#e9b98f", "#d99a6c"], lead: ["#9cc5f5", "#6fa6ea"] },
  dark: { wall: "#2b2e3b", wallShade: "#232530", base: "#191b23", floors: ["#4a3f33", "#33413a", "#3a3550"], line: "#1d1f28", hall: ["#2c2e38", "#262831"], rug: ["#6b4a3a", "#563a2d"], lead: ["#24497a", "#1b3a63"] },
} as const;
const SKY = {
  day: { glass: "#bfe3ff", light: "#ffffff", frame: "#ffffff" },
  night: { glass: "#13203f", light: "#fff4b0", frame: "#3e4252" },
} as const;
const SIGN_PALETTE = { o: "#1e1b24", B: "#0a5cc2", T: "#ffffff" };
export const SIGN = sign("Nouride Office");
const CLOCK_FACE = [".ooooooo.", "oWWWWWWWo", "oWWWWWWWo", "oWWWWWWWo", "oWWWWWWWo", "oWWWWWWWo", "oWWWWWWWo", "oWWWWWWWo", ".ooooooo."];

/** Where the lobby's sign and clock hang, from the layout: what the scene draws the clock's hands on. */
export function wallOf(layout: Pick<OfficeLayout, "rooms">): { sign: { x: number; y: number }; clock: { x: number; y: number } } {
  const lobby = layout.rooms[1]!;
  const x = lobby.x + Math.floor((lobby.width - SIGN[0]!.length) / 2) + 6;
  return { sign: { x, y: lobby.y + 8 }, clock: { x: x + SIGN[0]!.length + 4, y: lobby.y + 10 } };
}

/** Day from six in the morning to six in the evening, by the clock of the person looking. */
export function isDaytime(hour: number): boolean {
  return hour >= 6 && hour < 18;
}

export function paintRooms(context: CanvasRenderingContext2D, layout: OfficeLayout, theme: Theme, daytime: boolean): void {
  const colors = COLORS[theme];
  const sky = SKY[daytime ? "day" : "night"];
  const hall = layout.hall;
  context.imageSmoothingEnabled = false;

  layout.rooms.forEach((room, i) => {
    context.fillStyle = colors.wall;
    context.fillRect(room.x, room.y, room.width, WALL);
    context.fillStyle = colors.wallShade;
    context.fillRect(room.x, room.y + WALL - 4, room.width, 4);
    context.fillStyle = colors.floors[i]!;
    context.fillRect(room.x, room.y + WALL, room.width, room.height - WALL);
    context.fillStyle = colors.line;
    for (let y = room.y + WALL + 8; y < room.y + room.height; y += 12) context.fillRect(room.x, y, room.width, 1);
    context.fillStyle = colors.base;
    context.fillRect(room.x, room.y + WALL, room.width, 1);
  });

  // The hall: tiles from end to end.
  for (let y = hall.y; y < hall.y + hall.height; y += 7) {
    for (let x = hall.x; x < hall.x + hall.width; x += 7) {
      context.fillStyle = colors.hall[(Math.floor(x / 7) + Math.floor(y / 7)) % 2]!;
      context.fillRect(x, y, 7, 7);
    }
  }
  if (layout.stacked) paintLeftWalls(context, layout, colors);
  else paintBottomWalls(context, layout, colors);

  // Windows: two in the workroom, one in the bedroom — the sky as it is outside now.
  const workroom = layout.rooms[0]!;
  const bedroom = layout.rooms[2]!;
  for (const x of [workroom.x + 56, workroom.x + 108]) paintWindow(context, x, workroom.y + 6, sky, daytime);
  paintWindow(context, bedroom.x + Math.floor(bedroom.width / 2) - 9, bedroom.y + 6, sky, daytime);

  const wall = wallOf(layout);
  context.drawImage(mapSprite("sign", SIGN, SIGN_PALETTE), wall.sign.x, wall.sign.y);
  context.drawImage(mapSprite("clock", CLOCK_FACE, { o: "#1e1b24", W: "#ffffff" }), wall.clock.x, wall.clock.y);

  // A rug under each sofa; the furniture behind whoever is at it.
  for (const sofa of layout.sofas) {
    context.fillStyle = colors.rug[1]!;
    context.fillRect(sofa.x - 4, sofa.y + 4, 84, 18);
    context.fillStyle = colors.rug[0]!;
    context.fillRect(sofa.x - 2, sofa.y + 6, 80, 14);
  }
  // The orchestrator's desk, at the front: a rug of its own under it.
  if (layout.lead) {
    context.fillStyle = colors.lead[1]!;
    context.fillRect(layout.lead.x - 8, layout.lead.y + 8, 56, 32);
    context.fillStyle = colors.lead[0]!;
    context.fillRect(layout.lead.x - 6, layout.lead.y + 10, 52, 28);
  }
  for (const sofa of layout.sofas) context.drawImage(mapSprite("sofa-back", SOFA_BACK, FURNITURE_PALETTE), sofa.x, sofa.y);
  for (const desk of layout.desks) context.drawImage(mapSprite("chair", CHAIR, FURNITURE_PALETTE), desk.x + 11, desk.y + 13);
  for (const bed of layout.beds) context.drawImage(mapSprite("bed-back", BED_BACK, FURNITURE_PALETTE), bed.x, bed.y);
  const lobby = layout.rooms[1]!;
  if (layout.away > 0) paintOtherOffice(context, layout, colors.base);
  context.drawImage(mapSprite("shelf", SHELF, FURNITURE_PALETTE), workroom.x + 26, workroom.y + 6);
  context.drawImage(mapSprite("coffee", COFFEE, FURNITURE_PALETTE), lobby.x + lobby.width - 32, lobby.y + WALL - 6);
  context.drawImage(mapSprite("plant", PLANT, FURNITURE_PALETTE), lobby.x + lobby.width - 17, lobby.y + WALL - 4);
}

type Colors = (typeof COLORS)[Theme];

/** Side by side: walls between the rooms down to the hall, and a low wall along it with a door at each room's lane. */
function paintBottomWalls(context: CanvasRenderingContext2D, layout: OfficeLayout, colors: Colors): void {
  const hall = layout.hall.y;
  for (const room of layout.rooms.slice(1)) {
    context.fillStyle = colors.wallShade;
    context.fillRect(room.x - 2, 0, 4, hall);
    context.fillStyle = colors.base;
    context.fillRect(room.x - 2, WALL, 1, hall - WALL);
    context.fillRect(room.x + 1, WALL, 1, hall - WALL);
  }
  for (const room of layout.rooms) {
    const door = { from: room.lane + 3, to: room.lane + 31 };
    // A low wall on the hall's side of the rooms — below the last aisle, so nobody walks along its top — its top lit,
    // a doorway through it, framed, with a mat in front.
    for (const [from, to] of [[room.x, door.from - 2], [door.to + 2, room.x + room.width]] as const) {
      context.fillStyle = colors.wallShade;
      context.fillRect(from, hall, to - from, 6);
      context.fillStyle = colors.wall;
      context.fillRect(from, hall, to - from, 2);
      context.fillStyle = colors.base;
      context.fillRect(from, hall + 6, to - from, 1);
    }
    context.fillStyle = "#1e1b24";
    context.fillRect(door.from - 2, hall - 3, 2, 10);
    context.fillRect(door.to, hall - 3, 2, 10);
    context.fillStyle = colors.rug[1]!;
    context.fillRect(door.from + 3, hall + 8, door.to - door.from - 6, 3);
  }
}

/** One above another: each room's wall on the hall's side, a door in it level with the room's last aisle. */
function paintLeftWalls(context: CanvasRenderingContext2D, layout: OfficeLayout, colors: Colors): void {
  for (const room of layout.rooms) {
    // The doorway is as tall as a cat, its feet on the aisle.
    const door = { from: room.door.y + 6, to: room.door.y + 34 };
    for (const [from, to] of [[room.y, door.from - 2], [door.to + 2, room.y + room.height]] as const) {
      context.fillStyle = colors.wallShade;
      context.fillRect(room.x - 3, from, 3, to - from);
      context.fillStyle = colors.base;
      context.fillRect(room.x, from, 1, to - from);
    }
    context.fillStyle = "#1e1b24";
    context.fillRect(room.x - 4, door.from - 2, 5, 2);
    context.fillRect(room.x - 4, door.to, 5, 2);
    context.fillStyle = colors.rug[1]!;
    context.fillRect(room.x - 8, door.from + 3, 3, door.to - door.from - 6);
  }
}

/** More agents than this office holds: a door at the hall's end to the other office, a sign saying how many are there. */
function paintOtherOffice(context: CanvasRenderingContext2D, layout: OfficeLayout, base: string): void {
  const hall = layout.hall;
  const board = sign(`+${layout.away}`);
  context.fillStyle = "#1e1b24";
  if (layout.stacked) {
    // At the bottom of the hall down the left: the door below, the sign standing over it.
    context.fillRect(hall.x + 2, layout.height - 5, hall.width - 4, 5);
    context.fillStyle = base;
    context.fillRect(hall.x, layout.height - 7, hall.width, 2);
    context.drawImage(mapSprite(`away-${layout.away}`, board, SIGN_PALETTE), hall.x + Math.floor((hall.width - board[0]!.length) / 2), layout.height - board.length - 12);
    return;
  }
  const floor = { top: hall.y + 7, bottom: layout.height - 1 };
  context.fillRect(layout.width - 5, floor.top, 5, floor.bottom - floor.top);
  context.fillStyle = base;
  context.fillRect(layout.width - 7, floor.top - 2, 2, floor.bottom - floor.top + 2);
  const x = layout.width - board[0]!.length - 12;
  context.fillStyle = "#1e1b24";
  context.fillRect(x + 3, floor.top + 2 + board.length, 2, 4);
  context.fillRect(x + board[0]!.length - 5, floor.top + 2 + board.length, 2, 4);
  context.drawImage(mapSprite(`away-${layout.away}`, board, SIGN_PALETTE), x, floor.top + 2);
}

function paintWindow(context: CanvasRenderingContext2D, x: number, y: number, sky: (typeof SKY)[keyof typeof SKY], daytime: boolean): void {
  context.fillStyle = "#1e1b24";
  context.fillRect(x - 1, y - 1, 28, 20);
  context.fillStyle = sky.frame;
  context.fillRect(x, y, 26, 18);
  context.fillStyle = sky.glass;
  for (const [dx, dy] of [[2, 2], [14, 2], [2, 10], [14, 10]] as const) context.fillRect(x + dx, y + dy, 10, 6);
  context.fillStyle = sky.light;
  if (daytime) {
    context.fillRect(x + 4, y + 4, 5, 2);
    context.fillRect(x + 16, y + 12, 4, 1);
  } else {
    for (const [dx, dy] of [[4, 3], [9, 6], [17, 4], [21, 12], [6, 13]] as const) context.fillRect(x + dx, y + dy, 1, 1);
    context.fillRect(x + 18, y + 11, 3, 3);
  }
}
