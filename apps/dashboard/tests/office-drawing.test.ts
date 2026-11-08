/**
 * Nouride Office's drawing (0.8.1), as data: every pixel map one width a row; a cat as the grid its look and pose give —
 * its fur, its outfit where an outfit covers, a hat only where it has one, nothing below the chin in bed; each agent's
 * look its own parts and the rest from its id, the same every time and no twin of another's.
 */

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as CAT from "@/commons/cat/art";
import { compose, FRAME } from "@/commons/cat/compose";
import { lookOf, looksOf, type Look } from "@/commons/cat/look";
import * as FURNITURE from "@/commons/office/art/furniture";
import { lettering, sign } from "@/commons/office/art/lettering";
import { layoutOffice, type Point } from "@/commons/office/lib/layout";
import { route } from "@/commons/office/lib/route";
import { paintRooms, SIGN, wallOf } from "@/commons/office/lib/rooms";
import { OfficeScene } from "@/commons/office/lib/scene";

const LOOK: Look = { fur: "ginger", pattern: "plain", outfit: "none", outfitColor: "blue", hat: "none", accessory: "none", eyes: "round" };
const count = (grid: (string | null)[][], color: string) => grid.flat().filter((cell) => cell === color).length;

describe("the pixel maps", () => {
  test("each is one width a row — a row longer or shorter draws a crooked cat", () => {
    const maps: [string, readonly string[]][] = [
      ["head", CAT.HEAD],
      ...Object.entries(CAT.BODIES).map(([name, rows]): [string, readonly string[]] => [`body ${name}`, rows]),
      ...Object.entries(CAT.HATS).map(([name, hat]): [string, readonly string[]] => [`hat ${name}`, hat.rows]),
      ...Object.entries(CAT.ACCESSORIES).map(([name, accessory]): [string, readonly string[]] => [`accessory ${name}`, accessory.rows]),
      ...Object.entries(FURNITURE).filter((entry): entry is [string, string[]] => Array.isArray(entry[1])),
    ];
    expect(maps.length).toBeGreaterThan(15);
    expect(maps.filter(([, rows]) => new Set(rows.map((row) => row.length)).size !== 1).map(([name]) => name)).toEqual([]);
  });
});

describe("a cat", () => {
  test("is a 32×32 grid in its fur, outlined", () => {
    const grid = compose(LOOK, "stand");
    expect(grid).toHaveLength(FRAME);
    expect(grid.every((row) => row.length === FRAME)).toBe(true);
    expect(count(grid, CAT.FURS.ginger.F!)).toBeGreaterThan(100);
    expect(count(grid, CAT.COMMON.o!)).toBeGreaterThan(80);
  });

  test("wears its outfit in its colour where the outfit covers, and a tabby's stripes where a plain coat has none", () => {
    expect(count(compose(LOOK, "stand"), CAT.COLORS.blue.O!)).toBe(0);
    expect(count(compose({ ...LOOK, outfit: "hoodie" }, "stand"), CAT.COLORS.blue.O!)).toBeGreaterThan(40);
    expect(count(compose({ ...LOOK, outfit: "tee", outfitColor: "lime" }, "stand"), CAT.COLORS.lime.O!)).toBeGreaterThan(30);
    expect(count(compose(LOOK, "stand"), CAT.FURS.ginger.t!)).toBe(0);
    expect(count(compose({ ...LOOK, pattern: "tabby" }, "stand"), CAT.FURS.ginger.t!)).toBeGreaterThan(3);
  });

  test("has a hat only where its look has one, and in bed nothing below its chin", () => {
    expect(count(compose(LOOK, "stand"), CAT.COLORS.blue.q!)).toBe(0);
    expect(count(compose({ ...LOOK, hat: "beanie" }, "stand"), CAT.COLORS.blue.q!)).toBeGreaterThan(10);
    const asleep = compose({ ...LOOK, outfit: "hoodie" }, "sleep");
    expect(asleep.slice(18).flat().filter(Boolean)).toEqual([]);
  });

  test("blinks with its eyes closed, and a black cat's eyes are not lost in its fur", () => {
    expect(compose(LOOK, "stand", true)).not.toEqual(compose(LOOK, "stand"));
    expect(count(compose({ ...LOOK, fur: "black" }, "stand"), CAT.FURS.black.e!)).toBeGreaterThan(2);
  });
});

describe("each agent's look", () => {
  test("is its own parts, the rest from its id — the same every time, and another id's is another", () => {
    expect(lookOf("nouva")).toEqual(lookOf("nouva"));
    expect(lookOf("nouva", { hat: "beret", fur: "white" })).toMatchObject({ hat: "beret", fur: "white" });
    const ids = ["nouva", "nox", "coder", "mira", "budi", "e2e-a"];
    expect(new Set(ids.map((id) => JSON.stringify(lookOf(id)))).size).toBe(ids.length);
  });

  test("in one office is no twin of another's, where the hash left the colours free", () => {
    const nouva = lookOf("nouva");
    const { outfitColor: _left, ...rest } = nouva;
    // An agent whose own parts are nouva's but for its outfit colour, and whose id's hash gives that colour too: a twin.
    const id = Array.from({ length: 500 }, (_, i) => `twin-${i}`).find((candidate) => lookOf(candidate, rest).outfitColor === nouva.outfitColor)!;
    expect(lookOf(id, rest)).toEqual(nouva);
    const looks = looksOf([{ id: "nouva" }, { id, look: rest }]);
    expect(looks.get(id)).not.toEqual(looks.get("nouva"));
    expect(looks.get(id)).toMatchObject(rest);
  });
});

describe("headphones", () => {
  test("sit the same on both sides of the head — none over the face", () => {
    // Drawn 20 wide from x −1 they sat a pixel inside the face on the right, a cup over the cheek (seen in a
    // screenshot, 0.8.1). Asleep, a plain cat is its head alone, which is symmetric, so the headphones must be too.
    const grid = compose({ ...LOOK, hat: "headphones" }, "sleep");
    const mismatched = grid.flatMap((row, y) => row.flatMap((cell, x) => (cell === row[FRAME - 1 - x] ? [] : [`${x},${y}`])));
    expect(mismatched).toEqual([]);
    expect(count(grid, CAT.COLORS.blue.O!)).toBeGreaterThan(20);
  });
});

describe("a colour added after look-v1", () => {
  test("is one a person picks: the hash gives none, so every cat nobody styled looks as it did", () => {
    // Recorded before white was added (0.8.1): each id's colour from the hash, and forty agents' after twins moved on.
    const before: Record<string, string> = {"nouva": "lilac", "nero": "sage", "nestor": "charcoal", "nexa": "blue", "nix": "lilac", "nox": "charcoal", "coder": "charcoal", "codey": "blue", "wren": "blue", "claudy": "blue", "agent-01": "lilac", "helper": "peach", "a": "charcoal", "b": "peach", "c": "lime", "d": "blue"};
    expect(Object.fromEntries(Object.keys(before).map((id) => [id, lookOf(id).outfitColor as string]))).toEqual(before);
    const twins: Record<string, string> = {"agent-0": "blue/grey", "agent-1": "charcoal/ginger", "agent-2": "peach/cream", "agent-3": "lime/ginger", "agent-4": "blue/white", "agent-5": "charcoal/brown", "agent-6": "peach/white", "agent-7": "charcoal/brown", "agent-8": "sage/cream", "agent-9": "lime/brown", "agent-10": "lilac/ginger", "agent-11": "sage/grey", "agent-12": "lime/black", "agent-13": "sage/grey", "agent-14": "lilac/black", "agent-15": "peach/grey", "agent-16": "lime/black", "agent-17": "blue/white", "agent-18": "lilac/brown", "agent-19": "sage/white", "agent-20": "sage/cream", "agent-21": "lime/brown", "agent-22": "sage/white", "agent-23": "lime/brown", "agent-24": "blue/cream", "agent-25": "lilac/brown", "agent-26": "sage/white", "agent-27": "lime/brown", "agent-28": "peach/white", "agent-29": "lilac/brown", "agent-30": "charcoal/brown", "agent-31": "blue/cream", "agent-32": "charcoal/brown", "agent-33": "sage/grey", "agent-34": "lilac/black", "agent-35": "blue/grey", "agent-36": "lime/ginger", "agent-37": "blue/cream", "agent-38": "lilac/ginger", "agent-39": "peach/grey"};
    const many = looksOf(Object.keys(twins).map((id) => ({ id })));
    expect(Object.fromEntries(Object.keys(twins).map((id) => [id, `${many.get(id)!.outfitColor}/${many.get(id)!.fur}`]))).toEqual(twins);
    expect([...many.values()].some((look) => look.outfitColor === "white")).toBe(false);
  });

  test("white is drawn white, and a cat that picks it wears it", () => {
    expect(lookOf("nix", { outfitColor: "white" }).outfitColor).toBe("white");
    const grid = compose({ ...LOOK, outfit: "hoodie", outfitColor: "white" }, "stand");
    expect(count(grid, CAT.COLORS.white.O!)).toBeGreaterThan(20);
  });
});

describe("headphones, a hat since 0.8.1", () => {
  // Seventy ids' looks and drawings before they moved, an accessory then (0.8.1).
  const before: Record<string, { look: Record<string, string>; grid: string }> = {"agent-0":{"look":{"fur":"grey","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"cap","accessory":"glasses","eyes":"round"},"grid":"ad6aae0"},"agent-1":{"look":{"fur":"ginger","pattern":"tabby","outfit":"tee","outfitColor":"charcoal","hat":"cap","accessory":"scarf","eyes":"sparkly"},"grid":"37989b32"},"agent-2":{"look":{"fur":"cream","pattern":"plain","outfit":"hoodie","outfitColor":"peach","hat":"headband","accessory":"headphones","eyes":"sparkly"},"grid":"4b70e88d"},"agent-3":{"look":{"fur":"ginger","pattern":"tabby","outfit":"none","outfitColor":"lime","hat":"cap","accessory":"headphones","eyes":"sleepy"},"grid":"fd1242ba"},"agent-4":{"look":{"fur":"white","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"beret","accessory":"none","eyes":"sparkly"},"grid":"ad182cfd"},"agent-5":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"charcoal","hat":"headband","accessory":"none","eyes":"round"},"grid":"59211a5f"},"agent-6":{"look":{"fur":"white","pattern":"plain","outfit":"hoodie","outfitColor":"peach","hat":"beanie","accessory":"none","eyes":"sleepy"},"grid":"3ad6da6c"},"agent-7":{"look":{"fur":"brown","pattern":"tabby","outfit":"none","outfitColor":"charcoal","hat":"none","accessory":"glasses","eyes":"sparkly"},"grid":"8626ac74"},"agent-8":{"look":{"fur":"cream","pattern":"plain","outfit":"jacket","outfitColor":"sage","hat":"cap","accessory":"glasses","eyes":"round"},"grid":"25470689"},"agent-9":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"lime","hat":"beret","accessory":"headphones","eyes":"sleepy"},"grid":"d0219704"},"agent-10":{"look":{"fur":"ginger","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"beanie","accessory":"headphones","eyes":"round"},"grid":"923ecbe2"},"agent-11":{"look":{"fur":"grey","pattern":"plain","outfit":"hoodie","outfitColor":"sage","hat":"beanie","accessory":"headphones","eyes":"sleepy"},"grid":"51b5657b"},"agent-12":{"look":{"fur":"black","pattern":"tabby","outfit":"tee","outfitColor":"lime","hat":"beanie","accessory":"none","eyes":"sparkly"},"grid":"243d6b30"},"agent-13":{"look":{"fur":"grey","pattern":"plain","outfit":"jacket","outfitColor":"sage","hat":"beret","accessory":"sunglasses","eyes":"sparkly"},"grid":"7968ddca"},"agent-14":{"look":{"fur":"black","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"cap","accessory":"headphones","eyes":"round"},"grid":"faa1fb0f"},"agent-15":{"look":{"fur":"grey","pattern":"plain","outfit":"hoodie","outfitColor":"peach","hat":"beret","accessory":"headphones","eyes":"sleepy"},"grid":"b7c876da"},"agent-16":{"look":{"fur":"black","pattern":"tabby","outfit":"tee","outfitColor":"lime","hat":"headband","accessory":"glasses","eyes":"sleepy"},"grid":"103ea613"},"agent-17":{"look":{"fur":"white","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"cap","accessory":"headphones","eyes":"round"},"grid":"536587ad"},"agent-18":{"look":{"fur":"brown","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"headband","accessory":"scarf","eyes":"sparkly"},"grid":"5f53c5f8"},"agent-19":{"look":{"fur":"white","pattern":"plain","outfit":"hoodie","outfitColor":"sage","hat":"headband","accessory":"glasses","eyes":"sleepy"},"grid":"a8a079c2"},"agent-20":{"look":{"fur":"cream","pattern":"plain","outfit":"hoodie","outfitColor":"sage","hat":"beanie","accessory":"sunglasses","eyes":"sparkly"},"grid":"bd60bd61"},"agent-21":{"look":{"fur":"brown","pattern":"tabby","outfit":"none","outfitColor":"lime","hat":"beanie","accessory":"headphones","eyes":"sleepy"},"grid":"fd781154"},"agent-22":{"look":{"fur":"white","pattern":"plain","outfit":"jacket","outfitColor":"sage","hat":"beret","accessory":"scarf","eyes":"round"},"grid":"edb56708"},"agent-23":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"lime","hat":"none","accessory":"headphones","eyes":"sparkly"},"grid":"a75b17d3"},"agent-24":{"look":{"fur":"cream","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"cap","accessory":"headphones","eyes":"round"},"grid":"2a276a46"},"agent-25":{"look":{"fur":"brown","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"cap","accessory":"sunglasses","eyes":"sparkly"},"grid":"fda69351"},"agent-26":{"look":{"fur":"white","pattern":"plain","outfit":"jacket","outfitColor":"sage","hat":"none","accessory":"glasses","eyes":"sparkly"},"grid":"6241bb6e"},"agent-27":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"lime","hat":"headband","accessory":"scarf","eyes":"sleepy"},"grid":"e3fe79b0"},"agent-28":{"look":{"fur":"white","pattern":"plain","outfit":"hoodie","outfitColor":"peach","hat":"beanie","accessory":"glasses","eyes":"sparkly"},"grid":"f1f10430"},"agent-29":{"look":{"fur":"brown","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"beanie","accessory":"scarf","eyes":"round"},"grid":"b56a3d67"},"agent-30":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"charcoal","hat":"beret","accessory":"sunglasses","eyes":"round"},"grid":"97be3397"},"agent-31":{"look":{"fur":"cream","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"beret","accessory":"scarf","eyes":"sparkly"},"grid":"16f7a04b"},"agent-32":{"look":{"fur":"brown","pattern":"tabby","outfit":"none","outfitColor":"charcoal","hat":"headband","accessory":"scarf","eyes":"sparkly"},"grid":"a765a946"},"agent-33":{"look":{"fur":"grey","pattern":"plain","outfit":"hoodie","outfitColor":"sage","hat":"headband","accessory":"headphones","eyes":"round"},"grid":"ed72aa7"},"agent-34":{"look":{"fur":"black","pattern":"tabby","outfit":"tee","outfitColor":"lilac","hat":"none","accessory":"scarf","eyes":"sleepy"},"grid":"2d4f11ae"},"agent-35":{"look":{"fur":"grey","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"none","accessory":"none","eyes":"sparkly"},"grid":"4040a3d7"},"agent-36":{"look":{"fur":"ginger","pattern":"tabby","outfit":"none","outfitColor":"lime","hat":"beret","accessory":"glasses","eyes":"round"},"grid":"9c598d8e"},"agent-37":{"look":{"fur":"cream","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"none","accessory":"headphones","eyes":"sparkly"},"grid":"8e056af9"},"agent-38":{"look":{"fur":"ginger","pattern":"tabby","outfit":"tee","outfitColor":"lilac","hat":"beret","accessory":"headphones","eyes":"sleepy"},"grid":"6b6d1610"},"agent-39":{"look":{"fur":"grey","pattern":"plain","outfit":"jacket","outfitColor":"peach","hat":"beret","accessory":"scarf","eyes":"sleepy"},"grid":"c94667ae"},"agent-40":{"look":{"fur":"white","pattern":"plain","outfit":"jacket","outfitColor":"peach","hat":"beret","accessory":"headphones","eyes":"sparkly"},"grid":"f13a69b3"},"agent-41":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"charcoal","hat":"beanie","accessory":"headphones","eyes":"round"},"grid":"1444095c"},"agent-42":{"look":{"fur":"cream","pattern":"plain","outfit":"hoodie","outfitColor":"peach","hat":"beanie","accessory":"none","eyes":"round"},"grid":"7013dc0f"},"agent-43":{"look":{"fur":"ginger","pattern":"tabby","outfit":"none","outfitColor":"lime","hat":"headband","accessory":"none","eyes":"sleepy"},"grid":"ec154d11"},"agent-44":{"look":{"fur":"white","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"beanie","accessory":"sunglasses","eyes":"sleepy"},"grid":"d205a5c5"},"agent-45":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"lime","hat":"beanie","accessory":"glasses","eyes":"round"},"grid":"84d94128"},"agent-46":{"look":{"fur":"cream","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"beret","accessory":"glasses","eyes":"sleepy"},"grid":"701f2ead"},"agent-47":{"look":{"fur":"black","pattern":"tabby","outfit":"none","outfitColor":"lime","hat":"cap","accessory":"sunglasses","eyes":"sparkly"},"grid":"b8f8ee22"},"agent-48":{"look":{"fur":"cream","pattern":"plain","outfit":"jacket","outfitColor":"peach","hat":"headband","accessory":"headphones","eyes":"sleepy"},"grid":"5f17843d"},"agent-49":{"look":{"fur":"ginger","pattern":"tabby","outfit":"tee","outfitColor":"charcoal","hat":"beanie","accessory":"headphones","eyes":"sleepy"},"grid":"ddf2eab0"},"agent-50":{"look":{"fur":"ginger","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"beret","accessory":"sunglasses","eyes":"sleepy"},"grid":"231259aa"},"agent-51":{"look":{"fur":"grey","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"beanie","accessory":"none","eyes":"sparkly"},"grid":"41d40ba8"},"agent-52":{"look":{"fur":"ginger","pattern":"tabby","outfit":"tee","outfitColor":"charcoal","hat":"beanie","accessory":"headphones","eyes":"sleepy"},"grid":"ddf2eab0"},"agent-53":{"look":{"fur":"cream","pattern":"plain","outfit":"jacket","outfitColor":"sage","hat":"beanie","accessory":"glasses","eyes":"sparkly"},"grid":"7c7a1dc1"},"agent-54":{"look":{"fur":"black","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"beret","accessory":"sunglasses","eyes":"sleepy"},"grid":"18ae149b"},"agent-55":{"look":{"fur":"grey","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"headband","accessory":"glasses","eyes":"sparkly"},"grid":"b63f7cc4"},"agent-56":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"lime","hat":"none","accessory":"headphones","eyes":"sparkly"},"grid":"a75b17d3"},"agent-57":{"look":{"fur":"cream","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"none","accessory":"sunglasses","eyes":"sleepy"},"grid":"7905a209"},"agent-58":{"look":{"fur":"black","pattern":"tabby","outfit":"none","outfitColor":"lilac","hat":"headband","accessory":"headphones","eyes":"sparkly"},"grid":"5954a252"},"agent-59":{"look":{"fur":"white","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"none","accessory":"headphones","eyes":"sleepy"},"grid":"906900ca"},"nouva":{"look":{"fur":"brown","pattern":"tabby","outfit":"tee","outfitColor":"lilac","hat":"beanie","accessory":"none","eyes":"round"},"grid":"6bb827f3"},"nero":{"look":{"fur":"white","pattern":"plain","outfit":"hoodie","outfitColor":"sage","hat":"headband","accessory":"headphones","eyes":"sleepy"},"grid":"fb5211fe"},"nestor":{"look":{"fur":"ginger","pattern":"tabby","outfit":"tee","outfitColor":"charcoal","hat":"cap","accessory":"headphones","eyes":"sleepy"},"grid":"b6b745cf"},"nexa":{"look":{"fur":"grey","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"beanie","accessory":"glasses","eyes":"round"},"grid":"c2f9e174"},"nix":{"look":{"fur":"ginger","pattern":"tabby","outfit":"tee","outfitColor":"lilac","hat":"cap","accessory":"headphones","eyes":"sleepy"},"grid":"eee992db"},"nox":{"look":{"fur":"black","pattern":"tabby","outfit":"none","outfitColor":"charcoal","hat":"none","accessory":"glasses","eyes":"round"},"grid":"e27ce5de"},"coder":{"look":{"fur":"brown","pattern":"tabby","outfit":"none","outfitColor":"charcoal","hat":"cap","accessory":"glasses","eyes":"sleepy"},"grid":"2bf5a02b"},"codey":{"look":{"fur":"white","pattern":"plain","outfit":"jacket","outfitColor":"blue","hat":"cap","accessory":"scarf","eyes":"sleepy"},"grid":"6f77741"},"wren":{"look":{"fur":"grey","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"beret","accessory":"scarf","eyes":"sleepy"},"grid":"594940a7"},"claudy":{"look":{"fur":"white","pattern":"plain","outfit":"hoodie","outfitColor":"blue","hat":"headband","accessory":"headphones","eyes":"round"},"grid":"2a3e2f96"}};
  /** A drawing as a short hash of its pixels (FNV-1a), as they were recorded. */
  const drawing = (look: Parameters<typeof compose>[0]) => {
    const text = compose(look, "stand").map((row) => row.map((c) => c ?? ".").join(",")).join("|");
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return value.toString(16);
  };

  test("leave every cat nobody styled as it was, but for headphones under a hat, which come off", () => {
    for (const [id, was] of Object.entries(before)) {
      const now = lookOf(id);
      const { hat, accessory, ...rest } = was.look;
      expect({ id, ...now, hat: undefined, accessory: undefined }).toEqual({ id, ...rest, hat: undefined, accessory: undefined } as never);
      if (accessory !== "headphones") {
        // No headphones: the same hat and accessory, drawn the same to the pixel.
        expect([now.hat, now.accessory]).toEqual([hat, accessory] as never);
        expect(drawing(now)).toBe(was.grid);
      } else if (hat === "none") {
        // Headphones and no hat: worn as the hat now, and drawn the same to the pixel.
        expect([now.hat, now.accessory]).toEqual(["headphones", "none"]);
        expect(drawing(now)).toBe(was.grid);
      } else {
        // Under a hat: the hat stays, the headphones come off.
        expect([now.hat, now.accessory]).toEqual([hat, "none"] as never);
      }
    }
  });

  test("a hat picked — none too — keeps the hash's headphones off", () => {
    const id = Object.keys(before).find((key) => before[key]!.look.accessory === "headphones" && before[key]!.look.hat === "none")!;
    expect(lookOf(id).hat).toBe("headphones");
    expect(lookOf(id, { hat: "none" }).hat).toBe("none");
    expect(lookOf(id, { hat: "beret" }).hat).toBe("beret");
  });
});

describe("the sign", () => {
  test("says NOURIDE OFFICE, letter by letter, on the lobby's wall", () => {
    const rows = lettering("NOURIDE OFFICE");
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
    // The N, first: two uprights and the diagonal between them.
    expect(rows.map((row) => row.slice(0, 5))).toEqual(["T...T", "TT..T", "T.T.T", "T..TT", "T...T", "T...T", "T...T"]);
    expect(SIGN).toEqual(sign("Nouride Office"));
    expect(() => lettering("NOURIDE HQ")).toThrow('no letter "H"');
    const layout = layoutOffice([]);
    const lobby = layout.rooms[1]!;
    const { sign: at, clock } = wallOf(layout);
    expect(at.x).toBeGreaterThan(lobby.x);
    expect(clock.x + 9).toBeLessThanOrEqual(lobby.x + lobby.width);
  });
});

describe("the other office", () => {
  test("has a door at the hall's end only when some agents are there", () => {
    // Its sign is a small canvas: a document of its own, not one another file left behind.
    const globals = globalThis as unknown as { document?: unknown };
    const had = globals.document;
    globals.document = new Window().document;
    const doorways = (away: number) => {
      const layout = layoutOffice([{ id: "nouva", status: "idle", lead: true }], new Map(), away);
      const rects: number[][] = [];
      const context = new Proxy({}, { get: (_t, key) => (key === "fillRect" ? (...args: number[]) => rects.push(args) : () => {}), set: () => true }) as unknown as CanvasRenderingContext2D;
      paintRooms(context, layout, "dark", true);
      return rects.filter(([x, , w]) => x === layout.width - 5 && w === 5).length;
    };
    try {
      expect(doorways(38)).toBe(1);
      expect(doorways(0)).toBe(0);
    } finally {
      globals.document = had;
    }
  });
});

describe("a cat whose status changes", () => {
  const look = lookOf("nox");
  const as = (status: "idle" | "asleep") => [{ id: "nox", status, unavailable: false, look }];
  const onTheWay = (way: Point[], at: Point) =>
    way.some((a, i) => {
      const b = way[i + 1];
      return !!b && at.x >= Math.min(a.x, b.x) && at.x <= Math.max(a.x, b.x) && at.y >= Math.min(a.y, b.y) && at.y <= Math.max(a.y, b.y);
    });

  test("walks its way there — it is not there at once, nor ever off its way — and is there at the end", () => {
    const scene = new OfficeScene({ getContext: () => null } as unknown as HTMLCanvasElement);
    const idle = layoutOffice([{ id: "nox", status: "idle" }]);
    const asleep = layoutOffice([{ id: "nox", status: "asleep" }], idle.homes);
    scene.update(idle, as("idle"), 0, false);
    scene.update(asleep, as("asleep"), 1_000, false);
    const way = route(asleep, idle.places.get("nox")!, asleep.places.get("nox")!);
    expect(scene.walking("nox", 1_000)).toBe(true);
    for (let t = 1_000; t < 6_000; t += 250) expect(onTheWay(way, scene.positionOf("nox", t)!)).toBe(true);
    expect(scene.positionOf("nox", 1_500)).not.toEqual(scene.positionOf("nox", 1_000));
    const bed = asleep.places.get("nox")!;
    expect(scene.positionOf("nox", 60_000)).toEqual({ x: bed.x, y: bed.y });
    expect(scene.walking("nox", 60_000)).toBe(false);
  });

  test("when the page turns the rooms — made narrow, or wide — is simply in its place in the new office", () => {
    const scene = new OfficeScene({ getContext: () => null } as unknown as HTMLCanvasElement);
    const wide = layoutOffice([{ id: "nox", status: "idle" }]);
    const narrow = layoutOffice([{ id: "nox", status: "asleep" }], wide.homes, 0, true);
    scene.update(wide, as("idle"), 0, false);
    scene.update(narrow, as("asleep"), 1_000, false);
    expect(scene.walking("nox", 1_000)).toBe(false);
    expect(scene.positionOf("nox", 1_000)).toEqual({ x: narrow.places.get("nox")!.x, y: narrow.places.get("nox")!.y });
  });

  test("with reduced motion is simply there", () => {
    const scene = new OfficeScene({ getContext: () => null } as unknown as HTMLCanvasElement);
    const idle = layoutOffice([{ id: "nox", status: "idle" }]);
    const asleep = layoutOffice([{ id: "nox", status: "asleep" }], idle.homes);
    scene.update(idle, as("idle"), 0, true);
    scene.update(asleep, as("asleep"), 1_000, true);
    expect(scene.walking("nox", 1_000)).toBe(false);
    expect(scene.positionOf("nox", 1_000)).toEqual({ x: asleep.places.get("nox")!.x, y: asleep.places.get("nox")!.y });
  });
});

describe("what is drawn over a cat", () => {
  test("one that cannot work sleeps in bed like the rest, no alert; at work or waiting while it cannot, the alert (0.8.15)", async () => {
    const { bubbleFor } = await import("@/commons/office/lib/scene");
    expect(bubbleFor({ status: "asleep", unavailable: true }, false)).toBe("zed");
    expect(bubbleFor({ status: "working", unavailable: true }, false)).toBe("alert");
    expect(bubbleFor({ status: "waiting", unavailable: false }, false)).toBe("question");
    expect(bubbleFor({ status: "working", unavailable: false }, true)).toBeNull();
    expect(bubbleFor({ status: "idle", unavailable: false }, false)).toBeNull();
  });
});
