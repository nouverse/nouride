/**
 * The carousel skill: what it tells an agent, and the rules its checker decides by.
 *
 * A carousel is a set of pictures swiped through on a phone, and what goes wrong with one is what its HTML does not
 * show: text that is fine at the size it is drawn and unreadable at a third of it, a line that runs off the slide, an
 * emoji a server has no font for, eight slides that are not one set. The skill makes one path of it (the form asked
 * once, the words agreed before anything is drawn, every slide in one file, one command a round, the set sent as one
 * album) and measures what can be measured.
 *
 * Two things are held here that no reading of the skill would catch. Its words must not bring a look of their own: a
 * colour or a font named in a skill is copied into everything made with it, and a carousel's look is the person's.
 * And the rules are decided in `judge.mjs` from plain facts, so each is tried here with no browser.
 *
 * The drawing itself needs a browser, which the suite does not install. With `NOURIDE_TEST_BROWSER_DIR` naming a
 * folder set up as the browser-automation skill sets one up, the last block draws three carousels and reads what the
 * script finds; without it that block is skipped, by name.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichBinary } from "@nouride/runtime";

const ROOT = join(import.meta.dir, "../../../..");
const SKILL_DIR = join(ROOT, "content/skills/carousel");
const PAGES = join(import.meta.dir, "carousel");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const flat = skill.replace(/\s+/g, " ");

type Box = { x: number; y: number; w: number; h: number };
type Colour = { r: number; g: number; b: number; a?: number };
type Finding = { kind: string; what: string; box: Box; find: string[]; rule: string };
type Size = { width: number; height: number; name?: string };
interface Text { id: number; path?: number[]; text: string; whole?: string; el?: string; handle?: string; px: number; weight?: number; color?: Colour | null; bg?: Colour | null; box: Box; lines?: Box[]; cut?: { how: string; by?: string; handle?: string; holds?: number; room?: number } | null; glyphless?: string[] }
interface Facts { size: Size; slide: Box; texts?: Text[]; pictures?: { src: string; handle?: string; loaded: boolean; box: Box }[]; drawn?: number }
const { judge, sizeOf, minText, fullScreen, wordsOn, whereInFile, SIZES, EDGE, COVERED } = (await import(join(SKILL_DIR, "scripts/judge.mjs"))) as {
  judge: (facts: Facts) => Finding[];
  sizeOf: (said: unknown) => (Size & { name: string }) | null;
  minText: (size: Size) => number;
  fullScreen: (size: Size) => boolean;
  wordsOn: (texts: { text: string; whole?: string }[]) => number;
  whereInFile: (source: string, file: string, finding: { find?: string[]; rule?: string }) => string;
  SIZES: Record<string, Size>;
  EDGE: number;
  COVERED: { top: number; bottom: number; side: number };
};

const BLACK = { r: 17, g: 17, b: 17, a: 1 }, WHITE = { r: 255, g: 255, b: 255, a: 1 };
const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const FEED = sizeOf("4:5")!, STORY = sizeOf("9:16")!;
const line = (more: Partial<Text> = {}): Text => ({ id: 1, text: "Giling sebelum seduh", px: 84, color: BLACK, bg: WHITE, box: box(96, 400, 700, 100), ...more });
const slide = (texts: Text[], more: Partial<Facts> = {}): Facts => ({ size: FEED, slide: box(0, 0, FEED.width, FEED.height), texts, ...more });
const kinds = (facts: Facts) => judge(facts).map((finding) => finding.kind);

describe("what the skill tells an agent", () => {
  test("one HTML file holds every slide, and a browser draws each: never a picture made another way", () => {
    expect(flat).toContain("It is **written as one HTML file, every slide in it**, and a real browser draws each slide at the exact size the platform shows.");
    expect(flat).toContain("Never a picture made any other way.");
    expect(flat).toContain("- **A slide is an element with the class `slide`**, one after another in the order they are posted");
    expect(flat).toContain("- **One stylesheet for all of them**");
  });

  test("the form is asked once: where it is posted, as four shapes, and what it is made from", () => {
    expect(flat).toContain("in **one** message, in the person's language, as a list they can answer with a number");
    for (const shape of ["**4:5** (1080 by 1350)", "**1:1** (1080 by 1080)", "**3:4** (1080 by 1440)", "**9:16** (1080 by 1920)"]) expect(flat).toContain(shape);
    expect(flat).toContain("You write from what they give you or what you can open, not from memory.");
    expect(flat).toContain("With nothing said and nobody to ask, it is 4:5, and the caption comes with it.");
    // And each shape is one the script knows by that name.
    expect(Object.keys(SIZES)).toEqual(["4:5", "1:1", "3:4", "9:16"]);
  });

  test("the words are agreed before anything is drawn: an outline, each fact with its source", () => {
    const outline = skill.indexOf("## 2. The outline, for a yes"), write = skill.indexOf("## 3. Write the slides"), render = skill.indexOf("## 4. Render, measure and look");
    expect(outline > 0 && outline < write && write < render).toBe(true);
    expect(flat).toContain("every line that states a fact with its `source:`, where you read it");
    expect(flat).toContain("A line with none is one you made up: a number, a quote, a claim about their product.");
    expect(flat).toContain("A statistic nobody measured does not go on a slide.");
    // The outline ends a turn of its own: a real agent, told only to wait for a yes, drew in the turn that had the words.
    expect(flat).toContain("So there are **two turns, not one**: the first ends with the outline, the words of every slide, sent for a yes. Nothing is written to a file or drawn before that yes.");
    expect(flat).toContain("**Send the outline and end your turn there.** In the turn that sends it you write no file and run no command");
    expect(flat).toContain('Only two things skip the wait: they said to just make it ("langsung aja", "no need to ask"), or you are in a mission');
    expect(flat).toContain("This step starts once the outline has its yes.");
    // And what the agent adds to their material is a line of it, marked as its own: it added three such on a first run.
    expect(flat).toContain("- **What you add to their material is in the outline too**: a tip, a reason, a number of seconds they did not give you. Marked `source: mine, not from your notes`, so they can strike it.");
    expect(flat).toContain("Nothing reaches a slide that was not a line of the outline.");
    expect(skill).toContain("   <a reason or a tip you added to it>                         source: mine, not from your notes");
    for (const rule of ["**The first slide is the only one everybody sees.**", "**One idea a slide.**", "**The last slide says what to do**"]) expect(flat).toContain(rule);
  });

  test("one command a round; the sheet is what is read, and four rounds at most", () => {
    expect(skill).toContain("node CR/scripts/slides.mjs <work>/carousel/slides.html --browser-dir <private>/browser --size 4:5");
    expect(flat).toContain("One command a round. This is all of it: there is nothing to look up in its `--help`.");
    expect(flat).toContain("`sheet.png` and the check pictures, all in **one** `read` call");
    expect(flat).toContain("Read a single `slide-NN.png` only when the sheet leaves a question about that slide: each picture you read is carried by every step after it.");
    expect(flat).toContain("**Four rounds is the limit**");
    expect(flat).toContain("**A fix is an edit**: every fix of a round in ONE `multi_edit`");
    expect(flat).toContain("- they are one set: the same margin, the same heading, the same place for the page mark");
    expect(flat).toContain("- a slide is used: nothing crowded into its top with the rest of it empty");
    expect(flat).toContain("**The rounds are the plan.** Drawing a carousel is one turn's work");
  });

  test("the set is sent in ONE call, in order, and the caption as text to copy", () => {
    expect(flat).toContain("- **The slides, as one set**: ONE `send_file` call with every slide in `paths`, in order");
    expect(flat).toContain("Never a call a slide: that is eight messages, and no album.");
    expect(flat).toContain("- **The caption**, when they wanted it: in your message, as text they can copy, not on a picture and not as the album's caption.");
    expect(flat).toContain("the round's command with `--pdf`, then `send_file` `carousel.pdf`");
    expect(flat).toContain("You do not post it: where it goes is theirs to do");
  });

  test("a change is made in the file they saw, and what they saw is kept", () => {
    expect(flat).toContain("- **The change is made in the file they saw**, never in a new carousel from nothing");
    expect(skill).toContain("cp -r <work>/carousel <work>/carousel-v1");
  });

  test("the numbers it gives are the checker's own", () => {
    expect(minText(FEED)).toBe(33);
    expect(flat).toContain("`slides.mjs` holds every piece of text to 33 px (12 px on the phone)");
    expect(flat).toContain("| `small` | text under 33 px: under 12 px once a phone shows the slide |");
    expect(EDGE).toBe(0.05);
    expect(flat).toContain("nothing closer to an edge than 5% of the slide");
    expect(COVERED).toEqual({ top: 0.14, bottom: 0.35, side: 0.06 });
    expect(flat).toContain("stays out of the top 14%, the bottom 35% and the outer 6% of each side");
  });

  test("it says what it asks of the machine, and where to draw when this one is too small", () => {
    expect(flat).toMatch(/## This machine[\s\S]*?512 MB board/);
    expect(flat).toContain("a carousel of five slides peaked at 93 MB of memory and took 2.3 seconds (measured on a Linux box, three runs");
    expect(flat).toContain("| `browser: set up`, and 1 GB available or more | go on. Do **not** read the `browser-automation` skill");
  });
});

describe("it has no look of its own", () => {
  /** Fonts a writer reaches for without thinking: named in a skill, each becomes every carousel's font. */
  const FONTS = /\b(Inter|Roboto|Arial|Helvetica|Poppins|Montserrat|Open Sans|Lato|Nunito|Manrope|Geist|SF Pro|Segoe UI|Georgia|Times New Roman|Space Grotesk|Plus Jakarta Sans|DM Sans|Playfair)\b/;
  const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/;

  test("says so, and says where a look comes from, in order", () => {
    expect(flat).toContain("Nothing in this skill names a colour, a font, a corner, a layout or a style, and no template comes with it.");
    const order = ["1. **What the person said**", "2. **What is theirs already**", "3. **With neither, yours, chosen for this request**"].map((step) => skill.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(flat).toContain("Not the look of the last carousel you made: each request gets its own.");
  });

  test("its words name no colour and no font", () => {
    expect({ colour: skill.match(COLOUR)?.[0] ?? null, font: skill.match(FONTS)?.[0] ?? null }).toEqual({ colour: null, font: null });
  });

  test("it ships no slide, no stylesheet and no template: a starting slide would be every carousel's look", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path.slice(SKILL_DIR.length + 1));
      }
    };
    walk(SKILL_DIR);
    expect(files.sort()).toEqual(["SKILL.md", "scripts/judge.mjs", "scripts/slides.mjs"]);
  });

  test("the rules are numbers, with no colour in them; what the script draws of its own is the sheet's backdrop, its labels and the red outline", () => {
    expect(readFileSync(join(SKILL_DIR, "scripts/judge.mjs"), "utf8").match(COLOUR)).toBeNull();
    const script = readFileSync(join(SKILL_DIR, "scripts/slides.mjs"), "utf8");
    expect([...new Set(script.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])].sort()).toEqual(["#000", "#111", "#6b6b6b", "#FF1744", "#fff"]);
    // And none of it is in what the script says to the agent: no colour to copy as an example.
    const said = [...script.matchAll(/(?:usage|console\.(?:log|error))\((?:`[^`]*`|"[^"]*")/g)].map((m) => m[0]).join("\n");
    expect(said.match(COLOUR)).toBeNull();
  });
});

describe("the sizes a slide is drawn at", () => {
  test("by the shape a platform shows, each 1080 wide, or a size of the person's own", () => {
    expect(sizeOf("4:5")).toEqual({ width: 1080, height: 1350, name: "4:5" });
    expect(sizeOf("1:1")).toMatchObject({ width: 1080, height: 1080 });
    expect(sizeOf("3:4")).toMatchObject({ width: 1080, height: 1440 });
    expect(sizeOf("9:16")).toMatchObject({ width: 1080, height: 1920 });
    expect(sizeOf("1200x1500")).toEqual({ width: 1200, height: 1500, name: "1200x1500" });
    for (const not of ["16:10", "big", "", undefined, "12x12", "1080x"]) expect(sizeOf(not)).toBeNull();
  });

  test("the smallest text follows the slide's width: 12 px on a phone that shows it 390 wide", () => {
    expect(minText({ width: 1080, height: 1350 })).toBe(33);
    expect(minText({ width: 2160, height: 2700 })).toBe(66);
    expect(fullScreen(STORY)).toBe(true);
    expect(fullScreen(FEED)).toBe(false);
    expect(fullScreen({ width: 720, height: 1280 })).toBe(true);
  });
});

describe("the checker's rules, from plain facts", () => {
  test("a slide that fits and reads has no finding", () => {
    expect(judge(slide([line(), line({ id: 2, text: "Kopi yang baru digiling lebih wangi.", px: 44, box: box(96, 540, 800, 120) }), line({ id: 3, text: "2 / 7", px: 36, box: box(96, 1200, 80, 44) })]))).toEqual([]);
  });

  test("small text, at the boundary: 33 px passes and 32 does not, and the floor is said with what it is on a phone", () => {
    expect(kinds(slide([line({ px: 33 })]))).toEqual([]);
    const found = judge(slide([line({ px: 32, el: "<p.note>", handle: "note" })]));
    expect(found.map((one) => one.kind)).toEqual(["small"]);
    expect(found[0]!.what).toBe('32px text (under 33, which is 12px on a phone): <p.note> "Giling sebelum seduh"');
    expect(found[0]!.rule).toBe("note");
    // On a slide twice as wide the floor is twice as high.
    expect(kinds({ ...slide([line({ px: 60, box: box(200, 800, 700, 100) })]), size: { width: 2160, height: 2700 }, slide: box(0, 0, 2160, 2700) })).toEqual(["small"]);
  });

  test("text past the slide's edge is outside, by how far and on which side; inside the margin it is too near the edge", () => {
    expect(judge(slide([line({ box: box(96, 400, 1100, 100) })]))[0]).toMatchObject({ kind: "outside", what: expect.stringContaining("runs 116px past the slide's right edge") });
    expect(judge(slide([line({ box: box(96, 1300, 400, 100) })]))[0]!.what).toContain("runs 50px past the slide's bottom edge");
    // 5% of 1080 is 54: at 54 it is fine, at 53 it is not; and of the height, 5% of 1350 is 67.5.
    expect(kinds(slide([line({ box: box(54, 400, 700, 100) })]))).toEqual([]);
    expect(judge(slide([line({ box: box(53, 400, 700, 100) })]))[0]).toMatchObject({ kind: "edge", what: expect.stringContaining("53px from the left edge (under 54px, 5% of the slide)") });
    expect(kinds(slide([line({ box: box(96, 60, 700, 100) })]))).toEqual(["edge"]);
    // What is outside is not also said to be near the edge.
    expect(kinds(slide([line({ box: box(-10, 400, 700, 100) })]))).toEqual(["outside"]);
  });

  test("on a full-screen slide, text where the app draws over it is covered: the top, the bottom and the sides; on a feed slide it is not", () => {
    const story = (y: number, x = 120): Facts => ({ size: STORY, slide: box(0, 0, 1080, 1920), texts: [line({ box: box(x, y, 600, 80) })] });
    // 14% of 1920 is 268.8; 35% from the bottom starts at 1248; 6% of 1080 is 64.8.
    expect(judge(story(200))[0]).toMatchObject({ kind: "covered", what: expect.stringContaining("in the top 14% of a full-screen slide") });
    expect(kinds(story(269))).toEqual([]);
    expect(kinds(story(1168))).toEqual([]);
    expect(judge(story(1200))[0]!.what).toContain("in the bottom 35% of a full-screen slide");
    expect(judge(story(800, 40))[0]!.what).toContain("in the outer 6% of a side of a full-screen slide");
    expect(kinds(story(800, 65))).toEqual([]);
    // The same places on a feed slide are only as near an edge as they are.
    expect(kinds(slide([line({ box: box(120, 1000, 600, 80) })]))).toEqual([]);
  });

  test("contrast: grey on white fails, large text needs less, and large is large for a phone", () => {
    const grey = { r: 150, g: 150, b: 150, a: 1 };
    expect(kinds(slide([line({ px: 44, color: grey })]))).toEqual(["contrast"]);
    // Large is 24 px on a phone, 66.5 px on a slide 1080 wide: a grey of 3.4:1 passes at 67 and fails at 66.
    const mid = { r: 140, g: 140, b: 140, a: 1 };
    expect(kinds(slide([line({ px: 67, color: mid })]))).toEqual([]);
    expect(kinds(slide([line({ px: 66, color: mid })]))).toEqual(["contrast"]);
    // Bold text is large from 18.66 px on a phone, 51.7 on the slide.
    expect(kinds(slide([line({ px: 52, weight: 700, color: mid })]))).toEqual([]);
    expect(kinds(slide([line({ px: 52, weight: 400, color: mid })]))).toEqual(["contrast"]);
    expect(judge(slide([line({ px: 44, color: grey, el: "<p.pale>" })]))[0]!.what).toContain("#969696 on #ffffff: <p.pale>");
    // Over a picture or a gradient there is no colour to measure against: judged by eye.
    expect(kinds(slide([line({ px: 44, color: grey, bg: null })]))).toEqual([]);
  });

  test("cut text, text over text, a picture that did not load, a missing glyph, filler, a wrong size and an empty slide each have their finding", () => {
    expect(judge(slide([line({ cut: { how: "height", by: "<div.clipped>", handle: "clipped", holds: 185, room: 60 } })]))[0]).toMatchObject({ kind: "cut", rule: "clipped", what: expect.stringContaining("by <div.clipped>, which hides what runs past it and holds 185px in 60px") });
    expect(kinds(slide([line(), line({ id: 2, text: "Menimpa", box: box(120, 410, 300, 90) })]))).toEqual(["overlap"]);
    // A child inside its parent is one piece of text, not two over each other.
    expect(kinds(slide([line({ id: 1 }), line({ id: 2, path: [1], text: "seduh", box: box(500, 400, 200, 100) })]))).toEqual([]);
    expect(judge(slide([line()], { pictures: [{ src: "assets/logo.png", handle: "assets/logo.png", loaded: false, box: box(96, 96, 200, 80) }] }))[0]).toMatchObject({ kind: "picture", what: "a picture did not load: assets/logo.png" });
    expect(judge(slide([line({ text: "Promo hari ini 🔥", glyphless: ["🔥"] })]))[0]).toMatchObject({ kind: "glyph", what: expect.stringContaining("no glyph on this machine for 🔥: drawn as an empty box") });
    expect(kinds(slide([line({ text: "Lorem ipsum dolor sit amet" })]))).toEqual(["filler"]);
    expect(judge({ ...slide([line()]), slide: box(0, 0, 1080, 1500) })[0]).toMatchObject({ kind: "size", what: "the slide is 1080px by 1500px, not 1080 by 1350", rule: "slide" });
    expect(kinds(slide([]))).toEqual(["empty"]);
    // A slide that is one drawing and no words is not empty.
    expect(kinds(slide([], { drawn: 1 }))).toEqual([]);
  });

  test("the same finding is said once, and the words a slide says are counted, not judged", () => {
    const twice = [line({ px: 20 }), line({ id: 2, px: 20, box: box(96, 700, 700, 100) })];
    expect(kinds(slide(twice))).toEqual(["small"]);
    expect(wordsOn([{ text: "Giling sebelum", whole: "Giling sebelum seduh, selalu" }, { text: "2 / 7" }])).toBe(7);
  });
});

describe("where in the carousel's own file a finding is", () => {
  const source = ["<style>", ".slide { width: 1080px; }", ".note { font-size: 20px; }", "</style>", '<section class="slide">', '  <p class="note">Berlaku sampai akhir bulan</p>', "</section>"].join("\n");

  test("the line its words stand on, and the line of its element's CSS rule", () => {
    expect(whereInFile(source, "slides.html", { find: ["Berlaku sampai akhir bulan"], rule: "note" })).toBe(" (slides.html:6, its rule at :3)");
    expect(whereInFile(source, "slides.html", { find: [], rule: "slide" })).toBe(" (its rule at :2)");
    expect(whereInFile(source, "slides.html", { find: ["nowhere in it"], rule: "" })).toBe("");
  });
});

describe("the script, run as an agent runs it", () => {
  const runner = whichBinary("node") ?? process.execPath;
  const run = (args: string[]) => {
    const done = spawnSync(runner, [join(SKILL_DIR, "scripts/slides.mjs"), ...args], { encoding: "utf8", env: { ...process.env } });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };

  test("bad arguments are one line and exit 1; a file that is not there is exit 2; no browser to borrow is exit 3 with what to do", () => {
    expect(run([])).toMatchObject({ code: 1 });
    expect(run([join(PAGES, "good.html"), join(PAGES, "faults.html")]).err).toContain("one file: every slide of a carousel is in it");
    expect(run([join(PAGES, "good.html"), "--size", "16:10"]).err).toContain("no size called 16:10 (one of 4:5, 1:1, 3:4, 9:16, or WIDTHxHEIGHT)");
    expect(run([join(PAGES, "not-there.html")])).toMatchObject({ code: 2 });
    const none = run([join(PAGES, "good.html"), "--browser-dir", join(tmpdir(), "no-browser-here"), "--out", join(tmpdir(), "nouride-carousel-none")]);
    if (none.code === 3) expect(none.err).toContain("Set up the browser-automation skill (its steps 1 and 2) and pass its folder: --browser-dir <private>/browser");
  });

  const BROWSER = process.env.NOURIDE_TEST_BROWSER_DIR;
  const drawn = describe.skipIf(!BROWSER);
  drawn("in a real browser (NOURIDE_TEST_BROWSER_DIR)", () => {
    const out = mkdtempSync(join(tmpdir(), "nouride-carousel-"));
    const chromium = process.env.NOURIDE_TEST_CHROMIUM ? ["--chromium", process.env.NOURIDE_TEST_CHROMIUM] : [];
    const found = (dir: string) => (JSON.parse(readFileSync(join(dir, "check.json"), "utf8")) as { slide: number; findings: { kind: string }[] }[]).map((one) => one.findings.map((finding) => finding.kind));
    /** A PNG's width and height, from its header. */
    const sizeOfPng = (file: string) => {
      const head = readFileSync(file).subarray(16, 24);
      return [head.readUInt32BE(0), head.readUInt32BE(4)];
    };

    test("a clean carousel has no finding, each slide a picture of the exact size, with the sheet and the document", () => {
      const dir = join(out, "good");
      const clean = run([join(PAGES, "good.html"), "--browser-dir", BROWSER!, "--out", dir, "--pdf", ...chromium]);
      expect({ code: clean.code, err: clean.err }).toEqual({ code: 0, err: "" });
      expect(clean.out.split("\n")[0]).toBe("3 slide(s) at 1080x1350 (4:5), from good.html");
      expect(found(dir)).toEqual([[], [], []]);
      for (const name of ["slide-01.png", "slide-02.png", "slide-03.png"]) expect(sizeOfPng(join(dir, name))).toEqual([1080, 1350]);
      expect(existsSync(join(dir, "sheet.png")) && existsSync(join(dir, "carousel.pdf"))).toBe(true);
      // The sheet holds the slides themselves, each 432 wide in a row: 540 tall, and the gaps. With none drawn in it, it is a strip of labels.
      expect(sizeOfPng(join(dir, "sheet.png"))).toEqual([3 * (432 + 16) + 16, 540 + 32]);
      // The document is a page a slide.
      expect((readFileSync(join(dir, "carousel.pdf"), "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(3);
      // What is read next is the sheet alone: there is no check picture to read.
      expect(clean.out.split("\n").find((l) => l.startsWith("next:"))).toEndWith(join(dir, "sheet.png"));
      expect(clean.out).toContain("slide 1: 13 word(s), largest text 112px: nothing measured wrong");
    }, 60_000);

    test("the planted faults are each found on their slide, with where the fix is; a full-screen slide is held to its covered bands", () => {
      const dir = join(out, "faults");
      const faulty = run([join(PAGES, "faults.html"), "--browser-dir", BROWSER!, "--out", dir, ...chromium]);
      expect(faulty.code).toBe(4);
      expect(found(dir)).toEqual([["small"], ["outside"], ["edge"], ["contrast"], ["cut"], ["overlap"], ["picture"], ["filler"], ["size"], ["empty"]]);
      const said = faulty.out.split("\n");
      expect(said.find((l) => l.includes("small:"))).toContain('<p.fine-print> "Syarat dan ketentuan berlaku untuk semua" (faults.html:21, its rule at :11)');
      expect(said.find((l) => l.includes("cut:"))).toContain("by <div.clipped>, which hides what runs past it and holds");
      expect(said.find((l) => l.includes("contrast:"))).toContain("#c8c8c8 on #ffffff: <p.pale>");
      const next = said.find((l) => l.startsWith("next:"))!;
      for (const name of ["sheet.png", "check-01.png", "check-10.png"]) expect(next).toContain(name);
      // A slide that is the wrong size is still drawn, at the size it came out, to be seen.
      expect(sizeOfPng(join(dir, "slide-09.png"))).toEqual([1080, 1500]);

      const story = run([join(PAGES, "story.html"), "--browser-dir", BROWSER!, "--out", join(out, "story"), "--size", "9:16", ...chromium]);
      expect(story.code).toBe(4);
      expect(found(join(out, "story"))).toEqual([["covered", "covered", "covered"]]);
      expect(sizeOfPng(join(out, "story", "slide-01.png"))).toEqual([1080, 1920]);
    }, 90_000);

    test("the next round, shorter and with the faults gone, leaves no slide and no check picture of the round before", () => {
      const dir = join(out, "faults");
      const fixed = join(out, "faults.html");
      copyFileSync(join(PAGES, "good.html"), fixed);
      const again = run([fixed, "--browser-dir", BROWSER!, "--out", dir, ...chromium]);
      expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: "" });
      expect(readdirSync(dir).filter((name) => /^(slide|check)-\d+\.png$/.test(name)).sort()).toEqual(["slide-01.png", "slide-02.png", "slide-03.png"]);
    }, 60_000);

    test("a file with no slide in it says how a slide is marked, and exits 2", () => {
      const none = run([join(import.meta.dir, "mockup-design/good.html"), "--browser-dir", BROWSER!, "--out", join(out, "none"), ...chromium]);
      expect(none.code).toBe(2);
      expect(none.err).toContain('holds no slide. Each slide is an element with class="slide"');
    }, 60_000);
  });
});
