/**
 * Where the Office puts each agent (0.8.1): its own desk, seat and bed, at the one its status says, kept while others
 * come and go — and the way it walks between them: straight lines along the aisles, its room's lane and the hall, out
 * of a room only through its door, never through a wall.
 */

import { describe, expect, test } from "bun:test";
import { FEET, layoutOffice, scaleFor, SIDE_BY_SIDE_WIDTH, STACK_BELOW, type OfficeLayout, type Point, type Spot, type Status } from "@/commons/office/lib/layout";
import { along, lengthOf, route, straightened } from "@/commons/office/lib/route";
import { IN_OFFICE, roster } from "@/commons/office/lib/roster";

const six = (status: Status) => ["nero", "nestor", "nexa", "nix", "nouva", "nox"].map((id) => ({ id, status }));

describe("the Office's layout", () => {
  test("gives every agent its own desk, seat and bed, three to a row, and puts it at the one its status says", () => {
    const layout = layoutOffice(six("idle"));
    expect(layout.desks).toHaveLength(6);
    expect(layout.beds).toHaveLength(6);
    expect(layout.sofas).toHaveLength(2);
    expect(new Set([...layout.places.values()].map((spot) => spot.key)).size).toBe(6);
    expect(new Set(layout.desks.slice(0, 3).map((desk) => desk.y)).size).toBe(1);

    const mixed = layoutOffice([
      { id: "a", status: "working" },
      { id: "b", status: "waiting" },
      { id: "c", status: "idle" },
      { id: "d", status: "asleep" },
    ]);
    expect([...mixed.places].map(([id, spot]) => `${id}:${spot.key}`)).toEqual(["a:desk:0", "b:desk:1", "c:sofa:2", "d:bed:3"]);
  });

  test("puts the orchestrator's desk alone at the front of the workroom, in the middle, and the others' behind it", () => {
    const team = [{ id: "nouva", status: "working" as const, lead: true }, ...["nero", "nix", "nox"].map((id) => ({ id, status: "working" as const }))];
    const layout = layoutOffice(team);
    const lead = layout.places.get("nouva")!;
    expect(lead.key).toBe("desk:lead");
    expect(layout.lead).toEqual(layout.desks[0]!);
    // Halfway between the left and the right column's desks, and in front of every other desk.
    expect(layout.lead!.x).toBe((layout.desks[1]!.x + layout.desks[3]!.x) / 2);
    for (const id of ["nero", "nix", "nox"]) expect(layout.places.get(id)!.y).toBeGreaterThan(lead.y);
    expect(layout.homes.get("nouva")).toBe(0);
    // Its seat and bed are the first, like any home 0.
    expect(layoutOffice(team.map((agent) => ({ ...agent, status: "asleep" as const }))).places.get("nouva")!.key).toBe("bed:0");
  });

  test("keeps an agent's home whoever else comes or goes", () => {
    const first = layoutOffice([{ id: "b", status: "asleep" }, { id: "c", status: "asleep" }]);
    const second = layoutOffice([{ id: "a", status: "asleep" }, ...[...first.places.keys()].map((id) => ({ id, status: "asleep" as const }))], first.homes);
    expect(second.places.get("b")?.key).toBe(first.places.get("b")?.key);
    expect(second.places.get("c")?.key).toBe(first.places.get("c")?.key);
    expect(second.places.get("a")?.key).toBe("bed:2");
    // Its status moves it to its own desk, seat or bed — the same home.
    const third = layoutOffice([{ id: "b", status: "working" }, { id: "c", status: "asleep" }], second.homes);
    expect(third.places.get("b")?.key).toBe(`desk:${second.homes.get("b")}`);
    expect(third.places.get("c")?.key).toBe(first.places.get("c")?.key);
  });

  test("grows downwards a row for each three agents, and keeps its width", () => {
    expect(layoutOffice(six("idle")).height).toBeGreaterThan(layoutOffice(six("idle").slice(0, 3)).height);
    expect(layoutOffice(six("idle")).width).toBe(layoutOffice([]).width);
    expect(layoutOffice([], new Map(), 38).away).toBe(38);
  });
});

describe("who is in this office", () => {
  const agent = (id: string, since: number | null) => ({ id, since });

  test("is the orchestrator and then the agents made first — twelve at most — the rest in another office", () => {
    const many = Array.from({ length: 49 }, (_, i) => agent(`a${String(i).padStart(2, "0")}`, 1_000 + i));
    // Made last, it is here all the same, at the front.
    const { here, away } = roster([...many, agent("nouva", 9_999)], "nouva");
    expect(IN_OFFICE).toBe(12);
    expect(here.map((a) => a.id)).toEqual(["nouva", ...many.slice(0, 11).map((a) => a.id)]);
    // Fifty in all: twelve here, thirty-eight in another office.
    expect(away).toHaveLength(38);
    expect(away[0]!.id).toBe("a11");
  });

  test("puts agents the daemon never dated last, and breaks a tie by id", () => {
    const { here } = roster([agent("zed", null), agent("bob", 5), agent("amy", 5), agent("cat", 1)], null);
    expect(here.map((a) => a.id)).toEqual(["cat", "amy", "bob", "zed"]);
  });
});

/** Which room a cat's feet are in there, or −1 in the hall. */
function roomAt(layout: OfficeLayout, at: Point): number {
  const feet = { x: at.x + 16, y: at.y + FEET };
  return layout.rooms.findIndex((room) => feet.x >= room.x && feet.x < room.x + room.width && feet.y >= room.y && feet.y < room.y + room.height);
}

for (const stacked of [false, true]) {
  describe(`the way a cat walks, the rooms ${stacked ? "one above another" : "side by side"}`, () => {
    const states: Status[] = ["working", "idle", "asleep"];
    const team = (status: Status) => six(status).map((agent, i) => ({ ...agent, lead: i === 4 }));
    const layout = layoutOffice(team("idle"), new Map(), 0, stacked);
    const spots: Spot[] = [];
    for (const status of states) for (const spot of layoutOffice(team(status), new Map(), 0, stacked).places.values()) spots.push(spot);

    test("goes in straight lines, from one room to another only through their doors and along the hall", () => {
      const hallLine = (point: Point) => (stacked ? point.x === layout.rooms[0]!.hallDoor.x : point.y === layout.rooms[0]!.hallDoor.y);
      for (const from of spots) {
        for (const to of spots) {
          const way = route(layout, from, to);
          expect(way[0]).toEqual({ x: from.x, y: from.y });
          expect(way.at(-1)).toEqual({ x: to.x, y: to.y });
          for (let i = 1; i < way.length; i += 1) {
            const [a, b] = [way[i - 1]!, way[i]!];
            expect(a.x === b.x || a.y === b.y).toBe(true);
            const [ra, rb] = [roomAt(layout, a), roomAt(layout, b)];
            if (ra === -1 && rb === -1) expect([hallLine(a), hallLine(b)]).toEqual([true, true]);
            else if (ra !== rb) {
              // Never from one room straight into another: out of a room, it is through that room's door.
              expect(ra === -1 || rb === -1).toBe(true);
              const { door } = layout.rooms[ra === -1 ? rb : ra]!;
              const through = door.x >= Math.min(a.x, b.x) && door.x <= Math.max(a.x, b.x) && door.y >= Math.min(a.y, b.y) && door.y <= Math.max(a.y, b.y);
              expect(through).toBe(true);
            }
          }
        }
      }
    });

    test("leaves a desk round its side, not through it, and walks the aisle below its row", () => {
      const desk = layoutOffice(team("working"), new Map(), 0, stacked).places.get("nero")!;
      const seat = layoutOffice(team("idle"), new Map(), 0, stacked).places.get("nero")!;
      const way = route(layout, desk, seat);
      expect(way[1]).toEqual({ x: desk.x + 32, y: desk.y });
      expect(way[2]!.y).toBe(layout.rooms[0]!.aisles[desk.row]!);
    });
  });
}

describe("the way a cat walks", () => {
  const layout = layoutOffice(six("idle"));

  test("turns round where it is when it is sent back the way it came", () => {
    const desk = layoutOffice(six("working")).places.get("nox")!;
    const bed = layoutOffice(six("asleep")).places.get("nox")!;
    const there = route(layout, desk, bed);
    const halfway = along(there, lengthOf(there) / 2);
    const back = straightened([halfway.at, ...halfway.ahead, ...route(layout, bed, desk).slice(1)]);
    expect(lengthOf(back)).toBeCloseTo(lengthOf(there) / 2, 0);
    expect(back.at(-1)).toEqual({ x: desk.x, y: desk.y });
  });

  test("is somewhere on its way at every moment, facing the way it last went sideways", () => {
    const way: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 4, y: 10 }];
    expect(along(way, 5)).toMatchObject({ at: { x: 5, y: 0 }, facing: "right" });
    expect(along(way, 15)).toMatchObject({ at: { x: 10, y: 5 }, facing: "right" });
    expect(along(way, 23)).toMatchObject({ at: { x: 7, y: 10 }, facing: "left" });
    expect(along(way, 99)).toMatchObject({ at: { x: 4, y: 10 }, ahead: [] });
  });
});

describe("on a narrow page", () => {
  test("puts the rooms one above another, the hall down their left, each room as tall as its rows", () => {
    const team = six("idle").map((agent, i) => ({ ...agent, lead: i === 4 }));
    const wide = layoutOffice(team);
    const narrow = layoutOffice(team, new Map(), 0, true);
    expect(wide.width).toBe(SIDE_BY_SIDE_WIDTH);
    expect(narrow.width).toBeLessThan(SIDE_BY_SIDE_WIDTH / 2);
    const [workroom, lobby, bedroom] = narrow.rooms as [OfficeLayout["rooms"][0], OfficeLayout["rooms"][0], OfficeLayout["rooms"][0]];
    expect(new Set(narrow.rooms.map((room) => room.x)).size).toBe(1);
    expect([lobby.y, bedroom.y]).toEqual([workroom.y + workroom.height, lobby.y + lobby.height]);
    // The orchestrator's row and two of desks behind it; two rows of seats and of beds.
    expect(workroom.height).toBeGreaterThan(lobby.height);
    expect(narrow.hall).toEqual({ x: 0, y: 0, width: workroom.x, height: narrow.height });
    expect(narrow.height).toBe(bedroom.y + bedroom.height);
  });
});

describe("the Office's size", () => {
  test("is a whole scale where the page holds two offices, a half step below that, and stacked the page's width", () => {
    expect(scaleFor(343, 248, true)).toBeCloseTo(343 / 248, 5);
    expect(scaleFor(600, 248, true)).toBe(2);
    // Stacked on a wide page is twice the office at most: one above another, the rooms are tall already.
    expect(scaleFor(800, 248, true)).toBe(2);
    // A 750-pixel window's column stacks: side by side it would be drawn at once its size.
    expect(753 < STACK_BELOW && scaleFor(753, SIDE_BY_SIDE_WIDTH) < 1.5).toBe(true);
    expect(1_088 < STACK_BELOW).toBe(false);
    expect(scaleFor(1700, 546)).toBe(3);
    expect(scaleFor(1100, 546)).toBe(2);
    expect(scaleFor(3000, 546)).toBe(4);
    expect(scaleFor(1040, 546)).toBe(1.5);
    expect(scaleFor(700, 546)).toBe(1);
    expect(scaleFor(343, 546)).toBeCloseTo(0.628, 3);
  });
});
