/**
 * Where each pose is cut into parts: the lines `cut-mascot-pieces.ts` cuts along.
 *
 * A cut is read off the pose itself, enlarged: a line runs along the far edge of the outline two parts share, so the
 * part on top keeps the whole outline, or through cloth where the picture already draws a fold. Coordinates are the
 * pose's own pixels: 512 a side, or the one frame taken out of a strip of frames (`crop`). Left and right are the
 * viewer's.
 *
 * `parts` is in the order a pixel is claimed (the first part whose claim holds it), which is not the order they are
 * drawn in: `z` is that, back to front. A part with `save: false` takes its pixels and is not written: the ground
 * shadow, which a page draws in its own theme's colour.
 */

export type Point = readonly [number, number];
export type Rgb = readonly [number, number, number];
/** A region of the canvas: a polygon, or a test of a point. */
export type Region = readonly Point[] | ((x: number, y: number) => boolean);
/** A test of a pixel's colour. */
export type Colour = (r: number, g: number, b: number, a: number) => boolean;
/** What is painted under the parts above: the part's own nearest colour carried on, or shapes drawn in SVG. */
export type Under = { fill: { region: Region; reach?: number; pass?: Colour } } | { paint: string };
export type Part = {
  name: string;
  z: number;
  save?: false;
  claim?: readonly Point[];
  /** Claimed by spreading from the seeds through every pixel that passes, inside the region. */
  flood?: { seeds: readonly Point[]; within: Region; pass: Colour };
  under?: readonly Under[];
};
/** Within a box, what one part holds of another's colour goes over: a line drawn a pixel off is put right by colour. */
export type Refine = { from: string; to: string; within: Region; when: Colour };
/**
 * An outline's soft edge holds some of the colour it was painted on. Where that is another part (`off`), or ground
 * left in a box (`within`), the edge is turned into ink that lets the ground through, so it carries no pale rim away.
 */
export type Lift = { part: string; ink: Rgb; ground: Rgb } & ({ off: string } | { within: Region; when: Colour });
export type Cut = {
  set: string;
  pose: string;
  /** The frame of a strip the pose is: left, top, width, height. */
  crop?: readonly [number, number, number, number];
  parts: readonly Part[];
  refine?: readonly Refine[];
  lift?: readonly Lift[];
};

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const oval = (cx: number, cy: number, rx: number, ry: number) => (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
/** A band along a cut line, on the side `normal` points to, `depth` deep. */
const band = (line: readonly Point[], normal: Point, depth: number): Point[] => [
  ...line,
  ...[...line].reverse().map(([x, y]): Point => [x + normal[0] * depth, y + normal[1] * depth]),
];
const strokes = (ink: string, width: number, paths: readonly string[]) =>
  `<g fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join("")}</g>`;

const purple: Colour = (r, g, b) => b - r > 20 && b - g > 30 && luma(r, g, b) > 100;
const orange: Colour = (r, g, b) => r > 190 && r - b > 55 && g > 110;
const light: Colour = (r, g, b) => luma(r, g, b) >= 196;

// ── Standing, waving ────────────────────────────────────────────────────────────────────────────────────────────────

const WAVING_INK: Rgb = [62, 50, 68];
const cloth: Colour = (r, g, b, a) => purple(r, g, b, a) || luma(r, g, b) > 170;
const fur: Colour = (r, g, b) => luma(r, g, b) >= 78;
const helmet: Colour = (r, g, b) => luma(r, g, b) >= 78 && luma(r, g, b) < 125 && Math.abs(r - g) < 14;

const EAR_RIGHT: Point[] = [[262, 66], [300, 86], [340, 104], [354, 106]];
const EAR_LEFT: Point[] = [[166, 92], [150, 108], [145, 113], [141, 120], [132.5, 128.5], [123, 136.5], [116, 144.5], [111, 152.5], [106, 161], [98, 168], [86, 170]];
const WRIST: Point[] = [[391, 294], [385, 293.5], [378, 289], [370, 283.5], [362, 276], [356, 268], [351, 259]];
const JAW: Point[] = [[398, 240], [350, 256], [344, 258.5], [336, 264], [328, 269.5], [320, 274], [312, 277.5], [304, 280.5], [296, 283.5], [290, 285], [288, 281.5], [276, 282.5], [262, 283.5], [250, 284.5], [246, 287], [244, 291], [240, 292], [224, 292], [200, 292], [176, 292], [152, 292.5], [140, 296], [60, 296]];
const HEM: Point[] = [[346, 388], [336, 389], [324, 391.5], [312, 394], [300, 396.5], [288, 399], [272, 401.5], [256, 402.5], [240, 401.5], [232, 400.5], [224, 399], [216, 399], [208, 399.5], [192, 400], [176, 399.5], [162, 398], [154, 394]];
const HIP: Point[] = [[148, 388.5], [144.5, 382], [143.5, 376], [143.5, 344], [145, 340], [145, 330], [145.5, 326], [145.5, 280]];
// The sleeve is cut where the picture already draws a line: the hood's rim, then the fold under the arm.
const SHOULDER: Point[] = [[331, 262], [325, 284], [317, 292], [310, 300], [308, 304], [312, 311], [322.5, 320], [330.5, 332], [336.5, 342]];

const WAVING: Cut = {
  set: "waving",
  pose: "standing/01-waving.webp",
  lift: [
    { part: "legs", off: "shadow", ink: WAVING_INK, ground: [232, 223, 226] },
    // The ground painted between the legs goes with them when they leave it: as a thin shade, not a pale patch.
    { part: "legs", within: rect(236, 428, 268, 456), when: (r, g, b) => luma(r, g, b) >= 190, ink: WAVING_INK, ground: [255, 255, 255] },
  ],
  refine: [
    { from: "head", to: "body", within: rect(140, 270, 331, 300), when: purple },
    { from: "head", to: "sleeve", within: rect(325, 255, 352, 275), when: purple },
    { from: "paw", to: "sleeve", within: rect(348, 255, 396, 300), when: purple },
    { from: "sleeve", to: "paw", within: rect(352, 240, 400, 296), when: (r, g, b) => luma(r, g, b) > 215 },
  ],
  parts: [
    {
      name: "shadow", z: 0, save: false,
      flood: { seeds: [[130, 468], [250, 466], [380, 466], [250, 478], [200, 482]], within: oval(248, 467, 142, 19), pass: light },
      // The ground goes on under the feet: flat inside the shadow, and a few pixels in from every edge they stand on.
      under: [{ fill: { region: rect(140, 430, 360, 490), reach: 7 } }, { paint: `<ellipse cx="248" cy="466" rx="118" ry="13" fill="rgb(232,223,226)"/>` }],
    },
    { name: "sparks", z: 9, claim: [[406, 150], [470, 150], [470, 221], [426, 221], [406, 206]] },
    {
      name: "paw", z: 8,
      claim: [[350, 252], [351, 243], [355, 235], [361, 229], [368, 225], [376, 222.5], [384, 220], [390, 216], [424, 216], [432, 262], [424, 282], [402, 292], ...WRIST],
    },
    { name: "ear-left", z: 6, claim: [...EAR_LEFT, [60, 170], [60, 56], [168, 56]] },
    { name: "ear-right", z: 7, claim: [...EAR_RIGHT, [360, 100], [340, 20], [300, 20], [255, 55]] },
    {
      name: "head", z: 5,
      claim: [[60, 20], [398, 20], ...JAW],
      under: [
        // Its fur goes on behind the foot of each ear, and its own outline behind the ears' ends and the paw.
        { fill: { region: band(EAR_RIGHT, [0.4, -0.92], 14), pass: helmet } },
        { fill: { region: band(EAR_LEFT, [-0.75, -0.66], 14), pass: helmet } },
        { paint: strokes("rgb(62,50,68)", 7, ["M348 252 Q356 237 370 228 T388 213", "M256 63 L274 62", "M357 111 L349 96", "M168 92 L156 97", "M83 172 L86 158"]) },
      ],
    },
    {
      name: "sleeve", z: 4,
      claim: [...SHOULDER, [404, 342], [404, 236], [331, 236]],
      under: [{ fill: { region: oval(340, 270, 22, 20), pass: purple } }, { fill: { region: oval(372, 276, 22, 22), pass: purple } }],
    },
    {
      name: "body", z: 3,
      claim: [[360, 270], [360, 388], ...HEM, ...HIP, [145.5, 270]],
      under: [{ fill: { region: oval(240, 304, 96, 40), reach: 44, pass: cloth } }, { fill: { region: oval(322, 302, 22, 44), pass: purple } }],
    },
    {
      name: "legs", z: 2,
      claim: [[163.5, 380], [360, 380], [360, 500], [150, 500], [150, 446.5], [163.5, 444.5]],
      under: [{ fill: { region: oval(254, 408, 94, 26), pass: fur } }],
    },
    {
      name: "tail", z: 1,
      claim: rect(30, 296, 172, 452),
      under: [
        { fill: { region: oval(146, 388, 30, 58), reach: 44, pass: (r, g, b, a) => fur(r, g, b, a) && luma(r, g, b) < 150 } },
        { paint: strokes("rgb(62,50,68)", 6, ["M139 331 Q152 338 164 352", "M152 439 Q164 443 172 436"]) },
      ],
    },
  ],
};

// ── Riding, at speed ────────────────────────────────────────────────────────────────────────────────────────────────

const RIDING_INK: Rgb = [54, 44, 61];
const tyre: Colour = (r, g, b) => luma(r, g, b) >= 68 && luma(r, g, b) < 112;
const tailFur: Colour = (r, g, b) => luma(r, g, b) >= 74 && luma(r, g, b) < 150;

// The head's lower edge, right to left: its outline is the head's, the hood and the handlebar under it the ride's.
const RIDING_JAW: Point[] = [[470, 236], [460, 238], [452, 247], [444, 255.5], [432, 262.5], [416, 267.5], [400, 271.5], [384, 272], [368, 272], [352, 270.5], [340, 266], [330, 266], [326, 273], [320, 271], [304, 264], [288, 259], [272, 254], [256, 249], [240, 243], [224, 239], [210, 235], [180, 235]];

const RIDING: Cut = {
  set: "riding",
  pose: "riding/04-speeding.webp",
  lift: [
    // Where a streak runs in behind the head, the head's soft edge holds the streak's colour.
    { part: "head", off: "lines-top", ink: RIDING_INK, ground: [152, 144, 176] },
    { part: "wheel-rear", off: "shadow", ink: RIDING_INK, ground: [232, 222, 222] },
    { part: "wheel-front", off: "shadow", ink: RIDING_INK, ground: [232, 222, 222] },
    { part: "ride", off: "shadow", ink: RIDING_INK, ground: [254, 254, 254] },
  ],
  refine: [
    { from: "head", to: "ride", within: rect(205, 228, 400, 292), when: purple },
    { from: "head", to: "ride", within: rect(322, 258, 356, 282), when: (r, g, b) => luma(r, g, b) > 150 && luma(r, g, b) < 232 && r > b },
    // A streak is pale and lavender; what is dark beside the head, or faint and grey, is the head's own soft edge.
    { from: "lines-top", to: "head", within: rect(180, 60, 216, 226), when: (r, g, b, a) => luma(r, g, b) < 135 || (a < 235 && b - r <= 12) },
    { from: "ride", to: "head", within: rect(438, 224, 476, 262), when: (r, g, b) => luma(r, g, b) < 110 },
    { from: "wheel-front", to: "ride", within: rect(380, 392, 492, 428), when: orange },
    { from: "wheel-rear", to: "ride", within: rect(140, 424, 258, 450), when: orange },
  ],
  parts: [
    {
      name: "shadow", z: 0, save: false,
      flood: { seeds: [[130, 470], [300, 470], [300, 452], [250, 480], [360, 478], [470, 474]], within: rect(100, 449, 494, 500), pass: light },
      under: [{ fill: { region: rect(140, 440, 492, 490), reach: 7 } }, { paint: `<ellipse cx="298" cy="470" rx="176" ry="13" fill="rgb(226,214,214)"/>` }],
    },
    { name: "lines-top", z: 1, claim: rect(20, 60, 214, 224), under: [{ fill: { region: rect(184, 60, 226, 226), reach: 9 } }] },
    { name: "lines-bottom", z: 1, claim: [[20, 337], [118, 337], [118, 352], [160, 352], [160, 370], [132, 372], [132, 410], [20, 410]] },
    { name: "head", z: 6, claim: [[180, 20], [500, 20], [500, 236], ...RIDING_JAW] },
    {
      name: "tail", z: 2,
      claim: [[60, 226], [150, 226], [180, 262], [180, 285], [188, 296], [193, 301], [193.5, 343], [176, 344], [160, 342], [150, 339], [60, 337]],
      under: [
        { fill: { region: oval(194, 321, 22, 24), reach: 30, pass: tailFur } },
        { paint: strokes("rgb(54,44,61)", 7, ["M186 301 Q198 308 208 320", "M186 338 Q200 340 210 334"]) },
      ],
    },
    {
      name: "wheel-rear", z: 3,
      claim: [[152, 438], [176, 439], [192, 440.5], [208, 442], [224, 444], [238, 446], [246, 447], [250, 452], [250, 486], [150, 486]],
      under: [{ fill: { region: oval(200, 438, 42, 40), reach: 44, pass: tyre } }],
    },
    {
      name: "wheel-front", z: 4,
      claim: [[389.5, 446], [389.5, 436], [391, 426], [396, 415], [404, 407.5], [414, 403.5], [424, 402.5], [436, 404.5], [446, 409.5], [456, 415.5], [466, 418.5], [476, 417.5], [484, 413], [494, 413], [494, 486], [384, 486], [384, 450]],
      under: [{ fill: { region: oval(436, 438, 44, 41), reach: 44, pass: tyre } }],
    },
    {
      // The scooter and the cat that sits on it: no pose shows one without the other.
      name: "ride", z: 5,
      claim: rect(120, 215, 500, 470),
      under: [
        { fill: { region: (x, y) => oval(300, 282, 110, 44)(x, y) || oval(420, 278, 48, 26)(x, y), reach: 44, pass: (r, g, b) => luma(r, g, b) > 100 } },
        // The hood's and the handlebar's own top line, which the head's outline lies on.
        { paint: strokes("rgb(54,44,61)", 8, ["M388 270 L416 264 L434 258 L446 251 L456 240", "M213 231 L240 239 L272 250 L304 260 L326 270"]) },
      ],
    },
  ],
};

// ── Standing, facing the reader: the second frame of the footer's strip ────────────────────────────────────────────

const IDLE_INK = "rgb(40,31,46)";
const idleFur: Colour = (r, g, b) => luma(r, g, b) >= 58 && luma(r, g, b) < 150;
const idleHelmet: Colour = (r, g, b) => luma(r, g, b) >= 58 && luma(r, g, b) < 100 && Math.abs(r - g) < 12;
const idlePurple: Colour = (r, g, b) => b - r > 20 && b - g > 30 && luma(r, g, b) > 90;
const idleCloth: Colour = (r, g, b, a) => idlePurple(r, g, b, a) || luma(r, g, b) > 170;

const IDLE_MARK: Point[] = rect(218, 62, 280, 109);
const IDLE_EAR_LEFT: Point[] = [[162, 50], [152, 57], [141, 66], [133, 74], [121, 85], [109, 96], [97, 107], [89, 115], [76, 120], [58, 118]];
const IDLE_EAR_RIGHT: Point[] = [[250, 44], [266, 54], [282, 61], [297, 69], [311, 79], [325, 91], [338, 99], [352, 100]];
const IDLE_JAW: Point[] = [[369, 216], [352, 216], [340, 228], [328, 238], [316, 248], [304, 255], [288, 263], [272, 269], [262, 272], [256, 268], [240, 267], [224, 267], [216, 268.5], [212, 274], [208, 273.5], [192, 269.5], [176, 265], [160, 260.5], [144, 257], [112, 258.5], [84, 258.5], [40, 250]];
// Down the sleeve the tail passes behind, round the paw, along the hoodie's hem and round the other paw.
const IDLE_SIDE: Point[] = [[104, 250], [104, 300], [100, 312], [97.5, 324], [96.5, 340], [97, 352], [99.5, 362], [99, 372], [100, 384], [105, 391], [112, 396.5], [128, 399], [140, 397], [146, 388]];
const IDLE_HEM: Point[] = [[150, 385.5], [160, 387], [176, 390], [192, 392], [208, 393.5], [240, 394], [256, 394], [272, 393], [288, 391], [296, 389], [302, 386.5], [304, 390], [306, 398.5], [318, 401], [330, 399], [338, 392], [344, 380]];

const IDLE: Cut = {
  set: "idle",
  pose: "motion/idle.webp",
  crop: [369, 0, 369, 480],
  refine: [
    { from: "head", to: "body", within: rect(100, 236, 345, 300), when: idlePurple },
    { from: "head", to: "body", within: rect(210, 258, 262, 296), when: (r, g, b) => luma(r, g, b) > 150 && luma(r, g, b) < 232 && r > b },
  ],
  parts: [
    // The letter on the helmet, with the flat of the helmet round it: a page that draws the cat mirrored turns this
    // one piece back, so the letter still reads.
    { name: "mark", z: 6, claim: IDLE_MARK },
    { name: "ear-left", z: 4, claim: [...IDLE_EAR_LEFT, [58, 8], [162, 8]] },
    { name: "ear-right", z: 5, claim: [...IDLE_EAR_RIGHT, [352, 4], [250, 4]] },
    {
      name: "head", z: 3,
      claim: [[40, 0], [369, 0], ...IDLE_JAW],
      under: [
        { fill: { region: IDLE_MARK, reach: 36, pass: idleHelmet } },
        { fill: { region: band(IDLE_EAR_LEFT, [-0.66, -0.75], 14), pass: idleHelmet } },
        { fill: { region: band(IDLE_EAR_RIGHT, [0.48, -0.88], 14), pass: idleHelmet } },
        { paint: strokes(IDLE_INK, 7, ["M164 49 L152 54", "M60 119 L62 106", "M249 42 L262 47", "M353 101 L347 88"]) },
      ],
    },
    {
      name: "body", z: 2,
      claim: [...IDLE_SIDE, ...IDLE_HEM, [369, 380], [369, 250]],
      under: [{ fill: { region: oval(232, 272, 112, 30), reach: 40, pass: idleCloth } }],
    },
    {
      name: "legs", z: 1,
      claim: [[133, 380], [345, 380], [345, 480], [133, 480]],
      under: [{ fill: { region: oval(222, 400, 96, 20), pass: idleFur } }],
    },
    {
      name: "tail", z: 0,
      claim: rect(0, 250, 140, 420),
      under: [
        { fill: { region: oval(122, 386, 28, 32), reach: 40, pass: idleFur } },
        { paint: strokes(IDLE_INK, 7, ["M94 322 Q104 336 108 352", "M112 405 L138 408"]) },
      ],
    },
  ],
};

export const CUTS: readonly Cut[] = [WAVING, RIDING, IDLE];
