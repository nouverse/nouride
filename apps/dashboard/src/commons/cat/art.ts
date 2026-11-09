/**
 * The Nouride cat, as pixel maps (0.8.1): one drawing per part and pose, in symbols rather than colours,
 * so every fur and outfit is the same drawing under another palette. A 32×32 frame, front on: the head (with its eye
 * zone), a body per pose, the tail; outfits are laid on the body's torso and arm cells, hats and accessories on the
 * head's anchors. Drawn here, simple and consistent; a pixel artist can redraw any map without touching the code.
 *
 * Symbols: `.` nothing · `o` outline · `F` fur · `f` fur in shade · `h` fur in light · `t` a tabby stripe (fur where
 * plain) · `m` muzzle and belly · `p` pink of an ear · `n` nose · `k` dark (mouth) · `e` an eye, in the fur's eye colour · `w` white · `B` torso and
 * `A` arm (fur, or the outfit over it) · `O` `q` `l` outfit, in shade, in light · `g` glass · `s` a strap or frame ·
 * `H` `j` `J` the helmet, in shade, in light · `u` `v` a photochromic lens, dark at the top and lighter below.
 */

/** Rows of symbols; a half is mirrored into the whole, the way a face is. */
const mirrored = (halves: string[]): string[] => halves.map((half) => half + [...half].reverse().join(""));

/** The head, 20×15, its eye zone the `E` cells (fur, with the eyes drawn over). */
export const HEAD = mirrored([
  "...oo.....",
  "..ohFo....",
  "..ohpFo...",
  "..oFppFooo",
  ".oFFpFFtFt",
  ".oFFFFFFFF",
  "oFFFFFFFFF",
  "oFFEEEFFFF",
  "oFFEEEFFFF",
  "oFFFFFFFmm",
  "otFFFFFFmn",
  "ofFFFFFmmk",
  ".ofFFFFFmm",
  "..offFFFFF",
  "...ooooooo",
]);

/** Where the head goes in the frame, and its anchors relative to it. */
export const HEAD_AT = { x: 6, y: 3 } as const;
export const EYES_AT = [
  { x: 3, y: 7 },
  { x: 14, y: 7 },
] as const;

/** The eyes, 3×2 each, the left one drawn and the right one its mirror. */
export const EYES: Record<"round" | "sleepy" | "sparkly" | "closed", string[]> = {
  round: [".ew", ".ee"],
  sleepy: ["...", "eee"],
  sparkly: ["ewe", "eew"],
  closed: ["...", ".kk"],
};

/** The bodies, 20 wide, under the head. `B` torso, `A` arm, `L` a leg, all fur until an outfit covers them. */
const STAND_TOP = [
  "...oBBBBBBBBBBBBo...",
  "..oABBBBBBBBBBBBAo..",
  ".oAABBBBBBBBBBBBAAo.",
  ".oAABBBBmmmmBBBBAAo.",
  ".oAABBBmmmmmmBBBAAo.",
  ".ohAoBBmmmmmmBBoAho.",
  "..oooBBBmmmmBBBooo..",
  "....oBBBBBBBBBBo....",
];
export const BODIES: Record<"stand" | "step" | "sit" | "wave", string[]> = {
  stand: [...STAND_TOP, "....oFFFFooFFFFo....", "....oFFFFooFFFFo....", "...ohhFFo..oFFhho...", "...ooooo....ooooo..."],
  step: [...STAND_TOP, "....oFFFFooFFFFo....", "...ohhFFo..oFFFFo...", "...ooooo...ohhFFo...", "...........ooooo...."],
  // Behind a desk: what shows above it.
  sit: STAND_TOP.slice(0, 7),
  // One arm up beside the head, its place at the side closed.
  wave: [
    "...oBBBBBBBBBBBBo...",
    "...oBBBBBBBBBBBBAo..",
    "...oBBBBBBBBBBBBAAo.",
    "...oBBBBmmmmBBBBAAo.",
    "...oBBBmmmmmmBBBAAo.",
    "...oBBBmmmmmmBBoAho.",
    "...ooBBBmmmmBBBooo..",
    "....oBBBBBBBBBBo....",
    "....oFFFFooFFFFo....",
    "....oFFFFooFFFFo....",
    "...ohhFFo..oFFhho...",
    "...ooooo....ooooo...",
  ],
};
export const BODY_AT = { x: 6, y: 17 } as const;

/** The raised arm of `wave`, beside the head, its paw open. */
export const RAISED_ARM = {
  at: { x: 3, y: 9 },
  rows: [".oo..", "ohho.", "ohAo.", ".oAAo", ".oAAo", "..oAo", "..oAo", "..oAo", "...oo"],
};

/** The tail, curling up at the right of a standing cat. */
export const TAIL = { at: { x: 24, y: 19 }, rows: ["..oo", ".oFo", ".oFo", "oFo.", "oFo.", "oFo.", ".oFo", "..oo"] };

/**
 * The outfits, laid on a body's torso (`B`), belly (`m`) and arm (`A`) cells: which of them each covers, and what it
 * adds. A tee leaves the arms below the sleeve; a jacket leaves the belly, as an open front over a shirt.
 */
export const OUTFITS: Record<"hoodie" | "tee" | "jacket", { torso: boolean; belly: "outfit" | "shirt" | "fur"; sleeves: number; details: { x: number; y: number; c: string }[] }> = {
  hoodie: {
    torso: true,
    belly: "outfit",
    sleeves: 99,
    // A pocket's seam, and the hood's strings.
    details: [
      { x: 7, y: 5, c: "q" }, { x: 8, y: 5, c: "q" }, { x: 9, y: 5, c: "q" }, { x: 10, y: 5, c: "q" }, { x: 11, y: 5, c: "q" }, { x: 12, y: 5, c: "q" },
      { x: 8, y: 1, c: "w" }, { x: 8, y: 2, c: "w" }, { x: 11, y: 1, c: "w" }, { x: 11, y: 2, c: "w" },
      { x: 4, y: 0, c: "q" }, { x: 5, y: 0, c: "q" }, { x: 14, y: 0, c: "q" }, { x: 15, y: 0, c: "q" },
    ],
  },
  tee: { torso: true, belly: "outfit", sleeves: 2, details: [{ x: 9, y: 0, c: "q" }, { x: 10, y: 0, c: "q" }] },
  jacket: {
    torso: true,
    belly: "shirt",
    sleeves: 99,
    // Lapels down each side of the open front.
    details: [{ x: 7, y: 0, c: "q" }, { x: 12, y: 0, c: "q" }, { x: 7, y: 1, c: "q" }, { x: 12, y: 1, c: "q" }, { x: 7, y: 2, c: "q" }, { x: 12, y: 2, c: "q" }],
  },
};

/** The hats, placed on the head's top left (`HEAD_AT`), in the outfit's colours — the helmet in its own grey. */
export const HATS: Record<"beanie" | "cap" | "beret" | "headband" | "headphones" | "helmet", { at: { x: number; y: number }; rows: string[] }> = {
  beanie: {
    at: { x: 1, y: -3 },
    rows: [
      ".......ooo........",
      "......olllo.......",
      "....ooooooooooo...",
      "..ooOOOOOOOOOOOOo.",
      ".oOOOlOOOOOOOlOOOo",
      ".oOOOlOOOOOOOlOOOo",
      "oqqqqqqqqqqqqqqqqo",
      "oqqqqqqqqqqqqqqqqo",
      ".oooooooooooooooo.",
    ],
  },
  cap: {
    at: { x: 2, y: 0 },
    rows: [
      "....oooooooo........",
      "..ooOOOOOOOOoo......",
      ".oOOlOOOOOOOOOo.....",
      ".oOOlOOOOOOOOOOooooo",
      "oqqqqqqqqqqqqqqqqqqo",
      ".oooooooooooooooooo.",
    ],
  },
  beret: {
    at: { x: 0, y: 0 },
    rows: [
      "........oo........",
      "...ooooooooooo....",
      ".ooOOOOOOOOOOOOoo.",
      "oOOOlllOOOOOOOOOOo",
      ".oqqqqqqqqqqqqqqo.",
      "..oooooooooooooo..",
    ],
  },
  headband: {
    at: { x: 0, y: 3 },
    rows: ["oooooooooooooooooooo", "oOOOOOOOOOOOOOOOOOlo", "oooooooooooooooooolo", "..................oo"],
  },
  // A hat since 0.8.1, an accessory before. Symmetric about the head (20 wide): a band over the ear tips, down outside
  // the ears, and a cup on each side of the head, in the outfit's colours. Drawn 26 wide from x −3 so its middle is the
  // head's: one drawn 20 wide from −1 sat a pixel inside the face on the right, its cup over the cheek.
  headphones: {
    at: { x: -3, y: -3 },
    rows: mirrored([
      ".......oooooo",
      ".....ooOOOOOO",
      "....oOOoooooo",
      "...oOOo......",
      "..oOOo.......",
      "..oOo........",
      "..oOo........",
      ".oooo........",
      "olOOo........",
      "olOOo........",
      "oOOOo........",
      "oOOqo........",
      "oqqqo........",
      ".oooo........",
    ]),
  },
  // The mascot's: a grey half-helmet whose dome sits between the ears, so both stand clear of it pink and all, a white
  // N on its front, the brim across the forehead just over the glasses and a pad down each side of the head. Its own
  // grey rather than the outfit's colour, as the mascot's is grey over a purple hoodie. Drawn 22 wide from x −1, so the
  // pads sit just outside the head.
  helmet: {
    at: { x: -1, y: 1 },
    rows: [
      "........oooooo........",
      ".......oJwwJwHo.......",
      ".......oJwHwwHo.......",
      "......oJHwHHwHjo......",
      "ojjjjjjjjjjjjjjjjjjjjo",
      "oHjo..............oHjo",
      "oHjo..............oHjo",
      "oHjo..............oHjo",
      "ojjo..............ojjo",
      ".oo................oo.",
    ],
  },
};

/** The accessories, placed on the head (`HEAD_AT`) — the scarf on the body (`BODY_AT`). */
export const ACCESSORIES: Record<"glasses" | "sunglasses" | "scarf" | "photochromic", { on: "head" | "body"; at: { x: number; y: number }; rows: string[] }> = {
  // A lens around each eye zone (`EYES_AT`, x 3–5 and 14–16), the bridge between them.
  glasses: {
    on: "head",
    at: { x: 2, y: 6 },
    rows: ["sssss......sssss", "s...ssssssss...s", "s...s......s...s", "sssss......sssss"],
  },
  sunglasses: {
    on: "head",
    at: { x: 2, y: 6 },
    rows: ["sssss......sssss", "swggssssssssgwgs", "sgggs......sgggs", "sssss......sssss"],
  },
  // The mascot's: lenses tinted purple-grey, darker at the top as a photochromic lens is in the sun, a glint in each.
  photochromic: {
    on: "head",
    at: { x: 2, y: 6 },
    rows: ["sssss......sssss", "suuwssssssssuuws", "svvvs......svvvs", "sssss......sssss"],
  },
  scarf: {
    on: "body",
    at: { x: 2, y: -1 },
    rows: ["..oooooooooooooo..", ".oOlOlOlOlOlOlOlo.", ".oOOOOOOOOOOOOOOo.", "..oooooooooOlo....", "..........oOOo....", "..........oOlo....", "...........oo....."],
  },
};

/**
 * The tuxedo coat: white where `x` is, over any fur — a bib from the muzzle down and a blaze between the eyes on the
 * head (mirrored, as the head is), the hands, the feet (the last `paws` rows of a body with legs), and the tail's tip
 * (its first `tailTip` rows). The belly is white too, as the coat's muzzle colour.
 */
export const TUXEDO = {
  head: mirrored([
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    ".........x",
    ".........x",
    ".........x",
    "......xxxx",
    "......xxxx",
    "......xxxx",
    "......xxxx",
    "......xxxx",
    "..........",
  ]),
  paws: 3,
  tailTip: 3,
};

export type Palette = Record<string, string>;

/** The furs, as what `F`, `f`, `h`, `t` and `m` stand for. */
export const FURS: Record<"ginger" | "grey" | "black" | "white" | "brown" | "cream", Palette> = {
  ginger: { F: "#f0a35a", f: "#c9763a", h: "#ffd29a", t: "#b9652c", m: "#fff3e3", e: "#1e1b24" },
  grey: { F: "#9aa3ad", f: "#6f7782", h: "#c9d0d8", t: "#5d646e", m: "#eef1f4", e: "#1e1b24" },
  // Dark eyes would be lost in black fur: a black cat's are amber.
  black: { F: "#3a3d44", f: "#26282d", h: "#5b5f69", t: "#1b1c20", m: "#d9d9de", e: "#e8c84a" },
  white: { F: "#f4f1ea", f: "#d6d0c4", h: "#ffffff", t: "#c9c2b4", m: "#ffffff", e: "#1e1b24" },
  brown: { F: "#9a6a48", f: "#74492f", h: "#c39570", t: "#5d3a24", m: "#f1dfcf", e: "#1e1b24" },
  cream: { F: "#ecd8b5", f: "#cdb488", h: "#fff1d6", t: "#b99c6c", m: "#fffaf0", e: "#1e1b24" },
};

/** The outfit colours, as what `O`, `q` and `l` stand for — a hat and a scarf wear them too. */
export const COLORS: Record<"blue" | "lime" | "peach" | "charcoal" | "sage" | "lilac" | "white", Palette> = {
  blue: { O: "#2f8cf5", q: "#1f62b8", l: "#79b6ff" },
  lime: { O: "#a6d94a", q: "#78a92e", l: "#d3f08a" },
  peach: { O: "#f6b48f", q: "#d68865", l: "#ffd8c2" },
  charcoal: { O: "#4a4f58", q: "#33373e", l: "#6d737d" },
  sage: { O: "#8fb59a", q: "#6a8e75", l: "#b9d6c1" },
  lilac: { O: "#b7a3e0", q: "#8f79c2", l: "#d9cdf5" },
  // Off-white with a cool shade, so it reads as cloth on a white cat too.
  white: { O: "#f4f3ee", q: "#c4c7cf", l: "#ffffff" },
};

/** What every cat shares. */
export const COMMON: Palette = {
  o: "#1e1b24", p: "#f2a2b0", n: "#e57a8e", k: "#1e1b24", w: "#ffffff", g: "#2a2d35", s: "#26272c",
  // The helmet's dark grey, as the mascot's: darker than grey fur and lighter than black, so it reads on either.
  H: "#5c616b", j: "#41454d", J: "#7f858f",
  // A photochromic lens: purple-grey, darker above.
  u: "#3a3150", v: "#5d5080",
};
