/**
 * The mockup-design skill: what it tells an agent, the rules its checker decides by, and the frame it draws.
 *
 * An agent already made mockups this way with no skill: it wrote HTML, drew it in a headless browser at a desktop's and
 * a phone's width and sent the pictures, with the drawing script written again in nearly every turn and nothing
 * measured. The skill makes that one path, and adds what was missing: the form asked for first, findings measured, a
 * limit on the rounds, a phone and a laptop to put a screen in.
 *
 * Two things are held here that no reading of the skill would catch. Its words must not bring a look of their own: a
 * colour or a font named in a skill is copied into everything made with it, and a mockup's look is the person's. And
 * the rules are decided in `judge.mjs` from plain facts, so each one is tried here with no browser: a rule that fires
 * on a desktop for a finger's size, or stays quiet for grey on grey, is found before an agent meets it.
 *
 * The drawing itself needs a browser, which the suite does not install. With `NOURIDE_TEST_BROWSER_DIR` naming a folder
 * set up as the browser-automation skill sets one up, the last block draws three pages with planted faults and reads
 * what the scripts find; without it that block is skipped, by name.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { whichBinary } from "@nouride/runtime";

const ROOT = join(import.meta.dir, "../../../..");
const SKILL_DIR = join(ROOT, "content/skills/mockup-design");
const PAGES = join(import.meta.dir, "mockup-design");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const craft = readFileSync(join(SKILL_DIR, "references/craft.md"), "utf8");
const flat = skill.replace(/\s+/g, " ");

type Box = { x: number; y: number; w: number; h: number };
type Colour = { r: number; g: number; b: number; a?: number };
type Finding = { kind: string; what: string; box: Box };
interface Facts {
  viewport: { name: string; width: number; height: number; mobile: boolean };
  page: { scrollWidth: number; scrollHeight: number; hasViewportMeta: boolean };
  texts?: { id: number; path?: number[]; text: string; px: number; weight?: number; color?: Colour | null; bg?: Colour | null; box: Box; lines?: Box[]; cut?: string | null; pinned?: boolean }[];
  controls?: { what: string; box: Box; inline?: boolean }[];
  fields?: { what: string; px: number; box: Box }[];
  pictures?: { src: string; loaded: boolean; box: Box }[];
  wide?: { what: string; box: Box }[];
}
const { judge, ratio, over, MIN_TEXT, MIN_FIELD_ON_A_PHONE, MIN_TAP, VIEWPORTS } = (await import(join(SKILL_DIR, "scripts/judge.mjs"))) as {
  judge: (facts: Facts) => Finding[];
  ratio: (a: Colour, b: Colour) => number;
  over: (front: Colour, back: Colour) => Colour;
  MIN_TEXT: number;
  MIN_FIELD_ON_A_PHONE: number;
  MIN_TAP: number;
  VIEWPORTS: Record<string, { width: number; height: number; scale: number; mobile: boolean }>;
};
const { frameHtml } = (await import(join(SKILL_DIR, "scripts/frame.mjs"))) as { frameHtml: (opts: { phone?: string | null; laptop?: string | null; bg?: string }) => string };

const BLACK = { r: 17, g: 17, b: 17, a: 1 }, WHITE = { r: 255, g: 255, b: 255, a: 1 };
const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const phone = { name: "mobile", ...VIEWPORTS.mobile! }, desk = { name: "desktop", ...VIEWPORTS.desktop! };
const fits = (viewport: Facts["viewport"]) => ({ scrollWidth: viewport.width, scrollHeight: 2000, hasViewportMeta: true });
const line = (id: number, text: string, more: Partial<NonNullable<Facts["texts"]>[number]> = {}) => ({ id, text, px: 16, color: BLACK, bg: WHITE, box: box(20, 40 * id, 200, 20), ...more });
const kinds = (found: Finding[]) => found.map((one) => one.kind);

describe("what the skill tells an agent", () => {
  test("HTML first, always, and never a picture made another way", () => {
    expect(flat).toContain("A mockup is **written as HTML first, always**: one file per screen, drawn by a real browser at a desktop's width and at a phone's.");
    expect(flat).toContain("Never a picture made any other way: not an image generator, not a drawing in SVG, not boxes in text.");
  });

  test("the person says what form they want before anything is drawn: four of them, asked once", () => {
    expect(flat).toContain("Ask only what the request and the conversation do not already say, in **one** message, in the person's language, as a list they can answer with a number");
    for (const form of ["1. a **link** to open and press things in", "2. **pictures**: each screen at a desktop's width and at a phone's", "3. pictures **inside a phone and a laptop**", "4. the **HTML file** itself"]) expect(flat).toContain(form);
    // Not asked where their words already said it, and what is taken as the answer is said.
    expect(flat).toContain("do not ask: say in one line what you took as the answer. With nothing said and nobody to ask, it is pictures (2).");
    // Asked before the screens are written.
    expect(skill.indexOf("## 1. Ask what form, once")).toBeLessThan(skill.indexOf("## 2. Write the screens, HTML first"));
  });

  test("both widths, every round: drawn, measured, then looked at one window at a time, and four rounds at most", () => {
    expect(flat).toContain("**every screen is drawn at both widths, measured and looked at, round after round, before anything is sent**");
    expect(flat).toContain("read them all in **one** `read` call, each window of each screen at each width");
    expect(flat).toContain("A line that is not `none` is fixed, then **render again and read again**: a fix at one width can break the other.");
    expect(flat).toContain("**Four rounds is the limit**: then send what you have with your list and ask what to change.");
    expect(flat).toContain("Exit `4` means findings; `0` means nothing measured wrong, **not** that the mockup is good.");
    expect(flat).toContain("Both widths, always: the desktop and the phone.");
    // Seen with a real model: its message was a tour of the screen, and said nothing of what its rounds found.
    expect(flat).toContain("a short message, not a tour of the screen, which they can see");
    expect(flat).toContain("what the rounds found and fixed, in two or three lines");
  });

  test("each form is sent its own way, and a link by the skill that exists for it", () => {
    expect(flat).toContain("load the `share-preview` skill and follow it");
    expect(existsSync(join(ROOT, "content/skills/share-preview/SKILL.md"))).toBe(true);
    expect(flat).toContain("anyone with the link can open it, and it lasts while this machine keeps it up");
    expect(flat).toContain("The last round's `read` held `home-devices.png`: `send_file` it");
    expect(flat).toContain("`send_file` the screen's `.html`, with one line that it opens in any browser");
  });

  /**
   * A mockup on a small model took sixteen requests and a million tokens in, each request carrying everything before
   * it: a skill read whole for one command, two scripts read as code, the page written twice, the frames in a command
   * of their own. Each of these lines is one of those steps not taken.
   */
  test("it is followed in few steps: what is read, what is run and what is written again are each said", () => {
    expect(flat).toContain("**Every step you take is paid for again by every step after it**");
    // The browser skill is read only where the browser is not set up, and one command says which.
    expect(skill).toContain('ls <private>/browser/node_modules/playwright-core >/dev/null 2>&1 && echo "browser: set up" || echo "browser: not set up"');
    expect(flat).toContain("| `browser: set up`, and 1 GB available or more | go on. Do **not** read the `browser-automation` skill: nothing below needs it |");
    expect(flat).toContain("| `browser: not set up` | load the `browser-automation` skill, do its steps 1 and 2 once, and come back |");
    // The scripts are run, not read; the reference is read with the first pictures, not in a step of its own.
    expect(flat).toContain("its code and its `--help` are not for reading");
    expect(flat).toContain("One command a round. This is all of it: there is nothing to look up in its `--help`.");
    expect(flat).toContain("and in your first round `MK/references/craft.md` in that same call");
    // The frames come from the round's own command.
    expect(flat).toContain('the same command draws those too, so no round needs a second one: add `--frame --bg "<a colour of the mockup\'s own>"`');
    // A fix, and a change they asked for, is an edit: the page is not written a second time.
    expect(flat).toContain("**A fix is an edit**: change what the finding names with `edit` or `multi_edit`, and never write the whole file a second time.");
    expect(flat).toContain("The change itself is an `edit` or a `multi_edit` of the file, as a fix is.");
    // And no folder is made in a step of its own.
    expect(skill).not.toContain("mkdir");
  });

  test("a change is made in the file they saw, and what they saw is kept", () => {
    expect(flat).toContain("**The change is made in the file they saw**, never in a new mockup from nothing");
    expect(flat).toContain("**Keep what they saw first**: `cp -r <work>/mockup <work>/mockup-v1`");
    // Seen with a real model: after a change it read the framed picture alone, where only a screen's first window is.
    expect(flat).toContain("Then step 3 again, every round, the windows read again at both widths: a change in one place moves another.");
  });

  test("the numbers in its table are the checker's own", () => {
    expect(flat).toContain(`| \`small\` | text under ${MIN_TEXT} px |`);
    expect(flat).toContain(`a field with text under ${MIN_FIELD_ON_A_PHONE} px`);
    expect(flat).toContain(`something to press under ${MIN_TAP} by ${MIN_TAP} px`);
    expect([VIEWPORTS.desktop!.width, VIEWPORTS.mobile!.width]).toEqual([1440, 390]);
  });
});

describe("it has no look of its own", () => {
  /** Fonts a writer reaches for without thinking: named in a skill, each becomes every mockup's font. */
  const FONTS = /\b(Inter|Roboto|Arial|Helvetica|Poppins|Montserrat|Open Sans|Lato|Nunito|Manrope|Geist|SF Pro|Segoe UI|Georgia|Times New Roman|Space Grotesk|Plus Jakarta Sans|DM Sans|Playfair)\b/;
  const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/;

  test("says so, and says where a look comes from, in order", () => {
    expect(flat).toContain("Nothing in this skill names a colour, a font, a corner, a spacing or a style, and no template comes with it.");
    const order = ["1. **What the person said**", "2. **What is theirs already**", "3. **With neither, yours, chosen for this request**"].map((step) => skill.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(flat).toContain("Not the look of the last mockup you made: each request gets its own.");
    expect(flat).toContain("The rules below are floors for use (can it be read, can it be pressed, does it fit), never a taste.");
  });

  test("its words name no colour and no font", () => {
    for (const [name, text] of [["SKILL.md", skill], ["references/craft.md", craft]] as const) {
      expect({ name, colour: text.match(COLOUR)?.[0] ?? null, font: text.match(FONTS)?.[0] ?? null }).toEqual({ name, colour: null, font: null });
    }
  });

  test("it ships no page, no stylesheet and no template: a starting page would be every mockup's look", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path.slice(SKILL_DIR.length + 1));
      }
    };
    walk(SKILL_DIR);
    expect(files.sort()).toEqual(["SKILL.md", "references/craft.md", "scripts/frame.mjs", "scripts/judge.mjs", "scripts/render.mjs"]);
  });

  test("the rules are numbers, with no colour in them; the only colour the renderer draws is its own red outline", () => {
    expect(readFileSync(join(SKILL_DIR, "scripts/judge.mjs"), "utf8").match(COLOUR)).toBeNull();
    const drawn = new Set(readFileSync(join(SKILL_DIR, "scripts/render.mjs"), "utf8").match(/#[0-9a-fA-F]{3,8}\b/g) ?? []);
    expect([...drawn].sort()).toEqual(["#FF1744", "#fff"]);
    // What the frame draws is a device's body and the plain grey it stands on with nothing said: its words to the
    // agent, like the renderer's, give no colour as an example to copy.
    const frame = readFileSync(join(SKILL_DIR, "scripts/frame.mjs"), "utf8");
    const said = [...frame.matchAll(/(?:usage|console\.(?:log|error))\((?:`[^`]*`|"[^"]*")/g)].map((m) => m[0]).join("\n");
    expect(said.match(COLOUR)).toBeNull();
  });

  test("the motion-graphics skill's example names none either", () => {
    const motion = readFileSync(join(ROOT, "content/skills/motion-graphics/SKILL.md"), "utf8");
    expect(motion).toContain("1920×1080, 30 fps, 12 s. Font: <theirs, or the one you chose>. Colors: <background>, <text>, <accent>.");
    expect(motion.replace(/\s+/g, " ")).toContain("This skill names none: a look copied from an example is nobody's.");
    const example = motion.slice(motion.indexOf("```text\n1920×1080"), motion.indexOf("A line with no source you can write there"));
    expect({ colour: example.match(/#[0-9a-fA-F]{6}\b/)?.[0] ?? null, font: example.match(FONTS)?.[0] ?? null }).toEqual({ colour: null, font: null });
  });
});

describe("the checker's rules, from plain facts", () => {
  test("a page that fits, reads and can be pressed has no finding, at either width", () => {
    for (const viewport of [desk, phone]) {
      const found = judge({
        viewport,
        page: fits(viewport),
        texts: [line(1, "Today's orders", { px: 32 }), line(2, "2 iced coffee, waiting 6 minutes")],
        controls: [{ what: "<button> Find", box: box(20, 300, 120, 48) }],
        fields: [{ what: "<input> Find an order", px: 16, box: box(20, 240, 300, 48) }],
        pictures: [{ src: "logo.png", loaded: true, box: box(0, 0, 80, 40) }],
      });
      expect({ at: viewport.name, found }).toEqual({ at: viewport.name, found: [] });
    }
  });

  test("small text, at the boundary: 12 px passes and 11 does not", () => {
    const at = (px: number) => kinds(judge({ viewport: desk, page: fits(desk), texts: [line(1, "a caption", { px })] }));
    expect(at(12)).toEqual([]);
    expect(at(11)).toEqual(["small"]);
  });

  test("contrast: grey on white fails, large text needs less, and a see-through colour is judged as it is seen", () => {
    const grey = { r: 154, g: 154, b: 154, a: 1 };
    const found = judge({ viewport: desk, page: fits(desk), texts: [line(1, "too faint", { color: grey })] });
    expect(found.map((one) => one.what)).toEqual(['contrast 2.8:1 (needs 4.5): "too faint"']);
    // The same grey as a heading of 24 px still fails 3:1; a darker grey passes it there and fails as body text.
    const mid = { r: 138, g: 138, b: 138, a: 1 };
    expect(ratio(mid, WHITE)).toBeGreaterThan(3);
    expect(ratio(mid, WHITE)).toBeLessThan(4.5);
    expect(kinds(judge({ viewport: desk, page: fits(desk), texts: [line(1, "a heading", { color: mid, px: 24 })] }))).toEqual([]);
    expect(kinds(judge({ viewport: desk, page: fits(desk), texts: [line(1, "a bold lead", { color: mid, px: 19, weight: 700 })] }))).toEqual([]);
    expect(kinds(judge({ viewport: desk, page: fits(desk), texts: [line(1, "body text", { color: mid })] }))).toEqual(["contrast"]);
    // Black at 40% over white is a grey of 160: seen as that, not as black.
    expect(Math.round(over({ r: 0, g: 0, b: 0, a: 0.4 }, WHITE).r)).toBe(153);
    expect(kinds(judge({ viewport: desk, page: fits(desk), texts: [line(1, "see-through", { color: { r: 0, g: 0, b: 0, a: 0.4 } })] }))).toEqual(["contrast"]);
    // Over a picture or a gradient there is nothing to measure against: left to the eye.
    expect(kinds(judge({ viewport: desk, page: fits(desk), texts: [line(1, "on a photo", { color: grey, bg: null })] }))).toEqual([]);
  });

  test("a finger's size and a field's zoom are a phone's findings, never a desktop's; a link in a sentence is left alone", () => {
    const small = { viewport: phone, page: fits(phone), texts: [line(1, "See all")], controls: [{ what: "<a.more> See all", box: box(20, 40, 30, 26) }], fields: [{ what: "<input> Email", px: 13, box: box(20, 100, 300, 48) }] };
    expect(judge(small).map((one) => one.what)).toEqual(["30x26 to press (under 44x44): <a.more> See all", "a field with 13px text (under 16): a phone zooms the page when it is tapped: <input> Email"]);
    expect(judge({ ...small, viewport: desk, page: fits(desk) })).toEqual([]);
    expect(judge({ ...small, fields: [], controls: [{ what: "<a> kitchen note", box: box(20, 40, 90, 20), inline: true }] })).toEqual([]);
    // 44 in one direction is not enough: a wide, flat button is still hard to hit.
    expect(kinds(judge({ ...small, fields: [], controls: [{ what: "<button> Pay", box: box(20, 40, 300, 30) }] }))).toEqual(["tap"]);
    expect(judge({ ...small, fields: [], controls: [{ what: "<button> Pay", box: box(20, 40, 300, 44) }] })).toEqual([]);
  });

  test("a page wider than its window is named with what sticks out; a phone with no viewport tag is told why", () => {
    const wide = judge({ viewport: phone, page: { ...fits(phone), scrollWidth: 644 }, texts: [line(1, "a box")], wide: [{ what: '<p.wide> "A box with a fixed width"', box: box(24, 24, 620, 40) }] });
    expect(wide.map((one) => one.what)).toEqual(["the page is 254px wider than the window (390px) and scrolls sideways", 'sticks out 254px past the window: <p.wide> "A box with a fixed width"']);
    const bare = judge({ viewport: phone, page: { scrollWidth: 980, scrollHeight: 2000, hasViewportMeta: false }, texts: [line(1, "a page")] });
    expect(kinds(bare)).toEqual(["sideways", "viewport"]);
    // The tag is a phone's matter: a desktop draws the page the same without it.
    expect(judge({ viewport: desk, page: { ...fits(desk), hasViewportMeta: false }, texts: [line(1, "a page")] })).toEqual([]);
  });

  test("text over text is found; a child inside its parent, the same element's two lines and a bar pinned to the window are not", () => {
    const here = box(20, 100, 200, 20);
    const pair = (second: Partial<NonNullable<Facts["texts"]>[number]>) => kinds(judge({ viewport: desk, page: fits(desk), texts: [line(1, "First label", { box: here }), line(2, "Second label", { box: here, ...second })] }));
    expect(pair({})).toEqual(["overlap"]);
    expect(pair({ path: [1] })).toEqual([]);
    expect(pair({ id: 1 })).toEqual([]);
    expect(pair({ pinned: true })).toEqual([]);
    // Neighbours that touch at their edges are not over each other.
    expect(pair({ box: box(20, 119, 200, 20) })).toEqual([]);
  });

  test("cut text, a picture that did not load, filler and an empty page each have their finding, said once", () => {
    const found = judge({
      viewport: desk,
      page: fits(desk),
      texts: [line(1, "A paragraph in a box one line high", { cut: "height" }), line(2, "A name with no room", { cut: "width" }), line(3, "Lorem ipsum dolor sit amet"), line(4, "Lorem ipsum dolor sit amet", { box: box(20, 400, 200, 20) })],
      pictures: [{ src: "missing.png", loaded: false, box: box(0, 0, 80, 40) }],
    });
    expect(found.map((one) => `${one.kind}: ${one.what}`)).toEqual([
      'cut: text cut off by its box, in height: "A paragraph in a box one line high"',
      'cut: text cut off by its box, with no "..." to say so: "A name with no room"',
      'filler: filler text, not the page\'s own words: "Lorem ipsum dolor sit amet"',
      "picture: a picture did not load: missing.png",
    ]);
    expect(kinds(judge({ viewport: desk, page: fits(desk) }))).toEqual(["empty"]);
  });
});

describe("the frame", () => {
  const html = frameHtml({ phone: "file:///work/render/home-mobile-1.png", laptop: "file:///work/render/home-desktop-1.png", bg: "rgb(27 42 74)" });

  test("holds the mockup's pictures as they are, on what the caller says they stand on", () => {
    // The phone's picture twice: under the status band, and as that band's own colour.
    expect(html.split("file:///work/render/home-mobile-1.png").length - 1).toBe(4);
    expect(html.split("file:///work/render/home-desktop-1.png").length - 1).toBe(2);
    expect(html).toContain("background: rgb(27 42 74);");
    expect(html).toContain("object-fit: cover; object-position: top center;");
    // The phone's screen is the status band and then the whole window: a bar pinned to the window's foot was cut in
    // half when the band took its room from the window.
    expect(html).toContain(".phone .screen { display: flex; flex-direction: column; width: 390px; height: 898px;");
    expect(html).toContain(".phone .status { flex: 0 0 54px;");
    // Nothing is laid over the screen or changes its colours.
    expect(html).not.toMatch(/\.screen img \{[^}]*(filter|opacity|mix-blend)/);
    for (const id of ["phone", "laptop", "devices"]) expect(html).toContain(`id="${id}"`);
  });

  test("is drawn here: no picture of a real product, no logo, nothing fetched", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html.match(/<img /g)?.length).toBe(4);
    expect(html).not.toMatch(/<svg|logo|apple|iphone|macbook/i);
  });

  test("one device alone is one picture, and `transparent` stands on nothing", () => {
    const alone = frameHtml({ phone: "file:///p.png", bg: "transparent" });
    expect(alone).toContain('id="phone"');
    expect(alone).not.toContain('id="laptop"');
    expect(alone).not.toContain('id="devices"');
    expect(alone).toContain("background: transparent;");
    // A path with a quote in it stays inside its attribute.
    expect(frameHtml({ laptop: 'file:///a"b.png' })).toContain('src="file:///a&quot;b.png"');
  });
});

/**
 * The colour of a PNG's top-left pixel. Whatever filter its first row was written with, a row's first pixel has
 * nothing to its left and nothing above it, so its bytes are the colour itself.
 */
function cornerOf(file: string): number[] {
  const png = readFileSync(file);
  const data: Buffer[] = [];
  let colourType = 6;
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    if (kind === "IHDR") colourType = png[at + 8 + 9]!;
    if (kind === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(data)).subarray(1, colourType === 6 ? 5 : 4)].slice(0, 3);
}

describe("the scripts, run as an agent runs them", () => {
  const runner = whichBinary("node") ?? process.execPath;
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const done = spawnSync(runner, [join(SKILL_DIR, "scripts", script), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };

  test("bad arguments are one line and exit 1; a screen that is not there is exit 2; no browser to borrow is exit 3 with what to do", () => {
    expect(run("render.mjs", [])).toMatchObject({ code: 1 });
    expect(run("render.mjs", [join(PAGES, "good.html"), "--only", "watch"]).err).toContain("no width called watch (one of desktop, mobile, tablet)");
    expect(run("render.mjs", [join(PAGES, "not-there.html")])).toMatchObject({ code: 2 });
    const none = run("render.mjs", [join(PAGES, "good.html"), "--browser-dir", join(tmpdir(), "no-browser-here"), "--out", join(tmpdir(), "nouride-mockup-none")], {});
    if (none.code === 3) expect(none.err).toContain("Set up the browser-automation skill (its steps 1 and 2) and pass its folder: --browser-dir <private>/browser");
    expect(run("frame.mjs", ["--out", tmpdir()])).toMatchObject({ code: 1 });
    expect(run("frame.mjs", ["--out", tmpdir(), "--phone", join(PAGES, "good.html")]).err).toContain("is not a picture");
    expect(run("frame.mjs", ["--out", tmpdir(), "--phone", join(PAGES, "good.html"), "--bg", 'red;} body{display:none'])).toMatchObject({ code: 1 });
    // The renderer takes the same backdrop, with the frames it goes with.
    expect(run("render.mjs", [join(PAGES, "good.html"), "--frame", "--bg", "red;} body{display:none"])).toMatchObject({ code: 1 });
    expect(run("render.mjs", [join(PAGES, "good.html"), "--bg", "red"]).err).toContain("--bg is what the devices stand on: it goes with --frame");
  });

  const BROWSER = process.env.NOURIDE_TEST_BROWSER_DIR;
  const drawn = describe.skipIf(!BROWSER);
  drawn("in a real browser (NOURIDE_TEST_BROWSER_DIR)", () => {
    const out = mkdtempSync(join(tmpdir(), "nouride-mockup-"));
    const chromium = process.env.NOURIDE_TEST_CHROMIUM ? ["--chromium", process.env.NOURIDE_TEST_CHROMIUM] : [];
    const found = (screen: string, width: string) => (JSON.parse(readFileSync(join(out, "check.json"), "utf8")) as { screen: string; width: string; findings: { kind: string }[] }[]).find((one) => one.screen === screen && one.width === width)!.findings.map((one) => one.kind);

    test("a clean page has no finding at either width; the planted faults are each found where they belong", () => {
      const clean = run("render.mjs", [join(PAGES, "good.html"), "--browser-dir", BROWSER!, "--out", join(out, "clean"), ...chromium]);
      // A page that is right, with the things a careless reading reports: a tick box in its label, a name shortened
      // with "..." on purpose, a text held to two lines, a link in a sentence, a note that is not shown.
      expect({ code: clean.code, said: clean.out.split("\n").filter((l) => l.startsWith("good at")).map((l) => l.replace(/\(.*\)/, "")) }).toEqual({ code: 0, said: ["good at desktop : nothing measured wrong", "good at mobile : nothing measured wrong"] });

      const faulty = run("render.mjs", [join(PAGES, "faults.html"), join(PAGES, "no-viewport.html"), "--browser-dir", BROWSER!, "--out", out, ...chromium]);
      expect(faulty.code).toBe(4);
      expect(found("faults", "desktop")).toEqual(["small", "contrast", "cut", "filler", "overlap", "picture"]);
      expect(found("faults", "mobile")).toEqual(["sideways", "sideways", "small", "contrast", "cut", "filler", "overlap", "tap", "zoom", "picture"]);
      expect(found("no-viewport", "desktop")).toEqual([]);
      expect(found("no-viewport", "mobile")).toEqual(["sideways", "viewport"]);
      // What an agent reads next is named: each window of each screen at each width, and the check pictures.
      const next = faulty.out.split("\n").find((l) => l.startsWith("next:"))!;
      for (const name of ["faults-desktop-1.png", "faults-mobile-1.png", "faults-mobile-check.png", "no-viewport-mobile-1.png"]) expect(next).toContain(name);
      for (const name of ["faults-desktop.png", "faults-mobile.png", "faults-mobile-check.png"]) expect(existsSync(join(out, name))).toBe(true);

      // The next round, with the faults gone: the check picture of the round before does not stay beside it.
      const fixed = join(out, "faults.html");
      copyFileSync(join(PAGES, "good.html"), fixed);
      const again = run("render.mjs", [fixed, "--browser-dir", BROWSER!, "--out", out, ...chromium]);
      expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: "" });
      expect(["faults-mobile-check.png", "faults-desktop-check.png"].filter((name) => existsSync(join(out, name)))).toEqual([]);
      expect(existsSync(join(out, "faults-mobile-1.png"))).toBe(true);
      // And another screen's pictures are left alone.
      expect(existsSync(join(out, "no-viewport-mobile-check.png"))).toBe(true);
      // Three renders, each starting a browser: more than the five seconds a test is given.
    }, 90_000);

    test("one command draws a round and its frames: the devices are read with the windows, and not while there is something to fix", () => {
      const one = join(out, "one");
      const clean = run("render.mjs", [join(PAGES, "good.html"), "--browser-dir", BROWSER!, "--out", one, "--frame", "--bg", "rgb(27 42 74)", ...chromium]);
      expect({ code: clean.code, err: clean.err }).toEqual({ code: 0, err: "" });
      for (const name of ["good-phone.png", "good-laptop.png", "good-devices.png"]) expect(statSync(join(one, name)).size).toBeGreaterThan(20_000);
      // The devices stand on the colour the command gave: read from the picture's own corner.
      expect(cornerOf(join(one, "good-devices.png"))).toEqual([27, 42, 74]);
      const next = clean.out.split("\n").find((l) => l.startsWith("next:"))!;
      expect(next).toContain("good-devices.png");
      expect(next).not.toContain("good-phone.png");
      // One width alone: the one device that was drawn is the one to read.
      const phoneOnly = run("render.mjs", [join(PAGES, "good.html"), "--browser-dir", BROWSER!, "--out", join(out, "phone"), "--frame", "--only", "mobile", ...chromium]);
      expect(phoneOnly.out.split("\n").find((l) => l.startsWith("next:"))).toContain("good-phone.png");
      // With findings the frames will be drawn again: they are written, and not handed over to be read.
      const faulty = run("render.mjs", [join(PAGES, "faults.html"), "--browser-dir", BROWSER!, "--out", one, "--frame", ...chromium]);
      expect(faulty.code).toBe(4);
      expect(faulty.out.split("\n").find((l) => l.startsWith("next:"))).not.toContain("faults-devices.png");
    }, 90_000);

    test("a screen's two pictures come back inside a phone, a laptop and the two together", () => {
      const clean = join(out, "clean");
      const framed = run("frame.mjs", ["--browser-dir", BROWSER!, "--out", out, "--phone", join(clean, "good-mobile-1.png"), "--laptop", join(clean, "good-desktop-1.png"), ...chromium]);
      expect({ code: framed.code, err: framed.err }).toEqual({ code: 0, err: "" });
      for (const name of ["good-phone.png", "good-laptop.png", "good-devices.png"]) expect(statSync(join(out, name)).size).toBeGreaterThan(20_000);
      rmSync(out, { recursive: true, force: true });
    }, 60_000);
  });
});
