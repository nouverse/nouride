/**
 * The Office's furniture, as pixel maps in the cat's manner (0.8.1): symbols, one palette. What a cat sits behind or
 * lies under is split into a back, drawn before the cat, and a front, drawn after it — a laptop's lid over the chest of
 * a cat at work, a sofa's seat over its legs, a blanket up to its chin.
 *
 * Symbols: `.` nothing · `o` outline · `D` `d` `x` wood, its front, its shadow · `L` `l` a laptop's lid and its edge ·
 * `N` the Nouride mark on it · `C` `c` a cushion, in shade · `R` the sofa's frame · `G` `g` leaves · `P` `p` a pot ·
 * `I` `i` a pillow · `Q` `q` a blanket · `H` a headboard · `Y` `y` books · `K` `k` a machine's body · `S` its
 * screen · `W` a cup.
 */

const row = (n: number, edge: string, fill: string) => edge + fill.repeat(n - 2) + edge;

/** A desk, 40×12: its top, its front with a drawer, its legs. */
export const DESK = [
  row(40, "o", "o"),
  row(40, "o", "D"),
  row(40, "o", "D"),
  row(40, "o", "x"),
  "od" + "d".repeat(4) + "oooooooo" + "d".repeat(24) + "do",
  "od" + "d".repeat(4) + "oddddddo" + "d".repeat(24) + "do",
  "od" + "d".repeat(4) + "odxxddo" + "d" + "d".repeat(24) + "do",
  "od" + "d".repeat(4) + "oooooooo" + "d".repeat(24) + "do",
  row(40, "o", "x"),
  "oxo" + ".".repeat(34) + "oxo",
  "oxo" + ".".repeat(34) + "oxo",
  "ooo" + ".".repeat(34) + "ooo",
];

/** An open laptop seen from behind its lid, 16×11, set on the desk in front of the cat. */
export const LAPTOP = [
  "oooooooooooooooo",
  "oLLLLLLLLLLLLLLo",
  "oLLLLLLLLLLLLLLo",
  "oLLLLLLNNLLLLLLo",
  "oLLLLLNNNNLLLLLo",
  "oLLLLLLNNLLLLLLo",
  "oLLLLLLLLLLLLLLo",
  "oLLLLLLLLLLLLLLo",
  "ollllllllllllllo",
  "oooooooooooooooo",
  ".oxxxxxxxxxxxxo.",
];

/** A sofa for three, 76 wide: the back behind the cats on it, the seat and base in front of them. A cushion for each. */
const cushions = (fill: string, gap: string, widths: [number, number, number]) => widths.map((width) => fill.repeat(width)).join(gap);
export const SOFA_BACK = [
  "...." + "o".repeat(68) + "....",
  "...o" + "R".repeat(68) + "o...",
  ...[0, 1, 2].map(() => "..oR" + cushions("C", "o", [21, 24, 21]) + "Ro.."),
  "..oR" + cushions("c", "o", [21, 24, 21]) + "Ro..",
];
export const SOFA_FRONT = [
  "oooo" + ".".repeat(68) + "oooo",
  "oRRo" + ".".repeat(68) + "oRRo",
  "oRRo" + "o".repeat(68) + "oRRo",
  "oRR" + cushions("C", "o", [22, 24, 22]) + "RRo",
  "oRR" + cushions("c", "o", [22, 24, 22]) + "RRo",
  "o" + "R".repeat(74) + "o",
  "o" + "R".repeat(74) + "o",
  "o".repeat(76),
  ".oxo" + ".".repeat(68) + "oxo.",
  ".ooo" + ".".repeat(68) + "ooo.",
];

/**
 * The orchestrator's desk, at the front of the workroom: the desk's drawing in dark wood, with a brass plate on its
 * front — the same shape, so whoever sits at it sits as at any desk.
 */
export const LEAD_DESK_PALETTE: Record<string, string> = { D: "#7a4b2e", d: "#5e3820", x: "#3f2414", b: "#e9c46a" };
export const LEAD_DESK_PLATE = { x: 16, y: 5, rows: ["oooooooo", "obbbbbbo", "oooooooo"] };

/** A desk chair's back, 18×12, behind whoever sits at the desk — and what an empty desk shows it is a desk to work at. */
export const CHAIR = [
  "..oooooooooooooo..",
  ".oKKKKKKKKKKKKKKo.",
  "oKKkKKKKKKKKKKkKKo",
  "oKKKKKKKKKKKKKKKKo",
  "oKKKKKKKKKKKKKKKKo",
  "oKKKKKKKKKKKKKKKKo",
  "oKKKKKKKKKKKKKKKKo",
  "oKKkKKKKKKKKKKkKKo",
  ".oKKKKKKKKKKKKKKo.",
  "..oooooooooooooo..",
  ".......okko.......",
  ".......okko.......",
];

/** A coffee machine on its stand, 12×18: a screen, a cup under the spout. */
export const COFFEE = [
  "oooooooooooo",
  "oKKKKKKKKKKo",
  "oKkkkkkkkkKo",
  "oKkSSSSSSkKo",
  "oKkSSSSSSkKo",
  "oKkkkkkkkkKo",
  "oKKKKKKKKKKo",
  "oKKooooooKKo",
  "oKKo....oKKo",
  "oKKo.WW.oKKo",
  "oKKo.WW.oKKo",
  "oKKooooooKKo",
  "oKKKKKKKKKKo",
  "oooooooooooo",
  ".oDDDDDDDDo.",
  ".oddddddddo.",
  ".oxo....oxo.",
  ".ooo....ooo.",
];

/** A potted plant, 14×22. */
export const PLANT = [
  ".....oo.......",
  "....oGGo..oo..",
  "..ooGgGo.oGGo.",
  ".oGGgGGGoGgGo.",
  "oGgGGoGGGGGo..",
  "oGGGGGoGgGGoo.",
  ".oGgGGGGGGGgGo",
  "..oGGGgGGGGGGo",
  ".oGGGGGGgGGoo.",
  "oGgGGGGGGGGGo.",
  "oGGGGgGGGGgGo.",
  ".ooGGGGGGGGo..",
  "...ooooooooo..",
  "..oPPPPPPPPPo.",
  "..oPPPPPPPPPo.",
  "..opPPPPPPPpo.",
  "...oPPPPPPPo..",
  "...opPPPPPpo..",
  "...oPPPPPPPo..",
  "....oppppo....",
  "....oooooo....",
  "..............",
];

/** A bed, 34 wide: headboard and pillow behind the cat's head, the blanket over the rest. */
export const BED_BACK = [
  "..oooooooooooooooooooooooooooooo..",
  ".oHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHo.",
  "oHHxHHHHHHHHHHHHHHHHHHHHHHHHHHxHHo",
  "oHHxHHHHHHHHHHHHHHHHHHHHHHHHHHxHHo",
  "oHHxoooooooooooooooooooooooooxHHo",
  "oHHoIIIIIIIIIIIIIIIIIIIIIIIIIIoHHo",
  "oHHoIIIIIIIIIIIIIIIIIIIIIIIIIIoHHo",
  "oHHoIIIIIIIIIIIIIIIIIIIIIIIIIIoHHo",
  "oHHoiiiiiiiiiiiiiiiiiiiiiiiiiioHHo",
  "oHHoIIIIIIIIIIIIIIIIIIIIIIIIIIoHHo",
].map((line) => line.padEnd(34, ".").slice(0, 34));
export const BED_FRONT = [
  "oHHooooooooooooooooooooooooooooHHo",
  "oHHoQQQQQQQQQQQQQQQQQQQQQQQQQQoHHo",
  "oHHoQqQQQQQQQQQQQQQQQQQQQQQQqQoHHo",
  "oHHoQQQQQQQQQQQQQQQQQQQQQQQQQQoHHo",
  "oHHoQQQqQQQQQQQQQQQQQQQQQQqQQQoHHo",
  "oHHoQQQQQQQQQQQQQQQQQQQQQQQQQQoHHo",
  "oHHoQQQQQqQQQQQQQQQQQQQQqQQQQQoHHo",
  "oHHoQQQQQQQQQQQQQQQQQQQQQQQQQQoHHo",
  "oHHoqqqqqqqqqqqqqqqqqqqqqqqqqqoHHo",
  "oHHooooooooooooooooooooooooooooHHo",
  "oxxo..........................oxxo",
  "oooo..........................oooo",
];

/** A bookshelf against a wall, 24×30. */
export const SHELF = [
  "oooooooooooooooooooooooo",
  "oDDDDDDDDDDDDDDDDDDDDDDo",
  "oDooooooooooooooooooooDo",
  "oDoYyoYYoyYoYoYYyoxxxoDo",
  "oDoYyoYYoyYoYoYYyoxxxoDo",
  "oDoYyoYYoyYoYoYYyoxxxoDo",
  "oDoYyoYYoyYoYoYYyoxxxoDo",
  "oDooooooooooooooooooooDo",
  "oDDDDDDDDDDDDDDDDDDDDDDo",
  "oDooooooooooooooooooooDo",
  "oDoxxxoyYoYYoYyoYoyYYoDo",
  "oDoxxxoyYoYYoYyoYoyYYoDo",
  "oDoxxxoyYoYYoYyoYoyYYoDo",
  "oDoxxxoyYoYYoYyoYoyYYoDo",
  "oDooooooooooooooooooooDo",
  "oDDDDDDDDDDDDDDDDDDDDDDo",
  "oxxxxxxxxxxxxxxxxxxxxxxo",
  "oooooooooooooooooooooooo",
];

export const FURNITURE_PALETTE: Record<string, string> = {
  o: "#1e1b24",
  D: "#c79a6b",
  d: "#a87b50",
  x: "#7c5634",
  L: "#d7dbe2",
  l: "#a9b0bb",
  N: "#2f8cf5",
  C: "#8fb59a",
  c: "#6a8e75",
  R: "#5f7f69",
  G: "#6fbf62",
  g: "#47924a",
  P: "#d9875f",
  p: "#b2643f",
  I: "#ffffff",
  i: "#dfe3ea",
  Q: "#79b6ff",
  q: "#4f8fe0",
  H: "#a87b50",
  Y: "#f6b48f",
  y: "#b7a3e0",
  K: "#4a505e",
  k: "#343843",
  S: "#79b6ff",
  W: "#ffffff",
};
