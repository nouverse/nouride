// judge.mjs - what is wrong with a slide, decided from what slides.mjs measured in it. Part of the carousel skill.
//
// slides.mjs opens the carousel's one HTML file in a browser and writes down facts about each slide: how large it
// came out, where each piece of text is and how large, its colour and what is behind it, each picture, each character
// this machine has no glyph for. This file turns the facts into findings. It holds no browser and no file, so each
// rule can be read and tried alone.
//
// Every rule is a floor for being read on a phone, never a taste: a carousel can pass all of them and be dull, and no
// rule here says what a slide should look like. The numbers and where they come from:
//   size      the slide did not come out at the size asked for: a platform crops or pads what is not its shape
//   small     text that is under 12 px once a phone shows the slide. A slide is drawn 1080 px wide and a phone shows it
//             about 390 wide, so the floor on the slide is 12 x 1080 / 390 = 33 px. The same 12 px the mockup-design
//             skill holds a page to: under it, letters stop being read
//   outside   text that runs past the slide's edge: it is cut off in the picture
//   edge      text closer to an edge than 5% of the slide: the margin a screen's title is kept inside (the motion-
//             graphics skill's check uses the same), and where an app's rounded corners and its own marks sit
//   covered   on a 9:16 slide only, text in the top 14%, the bottom 35% or the outer 6% of each side: where the apps
//             draw their own bars over a full-screen picture. Meta's guidance for a 9:16 placement, as guides to it
//             quote it in 2026 (some give a story's bottom as 20%); the apps change it, so a finding kept on purpose
//             is said, not hidden
//   contrast  text against what is behind it under 4.5:1, or 3:1 for large text: the WCAG AA ratios, "large" scaled
//             to the slide as `small` is. Text over a picture or a gradient is not measured: that is judged by eye
//   cut       text cut off by a box inside the slide
//   overlap   one piece of text drawn over another
//   picture   a picture that did not load
//   glyph     a character this machine has no glyph for: it is drawn as an empty box. Emoji, mostly, on a machine
//             with no emoji font
//   filler    lorem ipsum left in
//   empty     nothing on the slide

/** The sizes a carousel is drawn at, by the shape a platform shows. Each is 1080 px wide, the width the apps keep. */
export const SIZES = {
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "9:16": { width: 1080, height: 1920 },
};

/** How wide a phone shows a slide, in its own px: the window the mockup-design skill draws a phone at. */
export const PHONE_SHOWS = 390;
/** The smallest text a phone's reader reads, in the phone's px. */
export const MIN_TEXT_ON_A_PHONE = 12;
export const EDGE = 0.05;
export const COVERED = { top: 0.14, bottom: 0.35, side: 0.06 };
export const CONTRAST = 4.5;
export const CONTRAST_LARGE = 3;

/** A size by its name ("4:5") or as WIDTHxHEIGHT ("1200x1500"), or null. */
export function sizeOf(said) {
  if (SIZES[said]) return { ...SIZES[said], name: said };
  const given = /^(\d{3,4})x(\d{3,4})$/i.exec(String(said ?? ""));
  return given ? { width: Number(given[1]), height: Number(given[2]), name: `${given[1]}x${given[2]}` } : null;
}

/** The smallest text on a slide of this width that is still 12 px on a phone. 33 px on a slide 1080 wide. */
export const minText = (size) => Math.round((MIN_TEXT_ON_A_PHONE * size.width) / PHONE_SHOWS);
/** A slide whose shape is a full phone screen, where the apps draw over it. */
export const fullScreen = (size) => Math.abs(size.width / size.height - 9 / 16) < 0.01;

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const over = (front, back) => {
  const a = front.a ?? 1;
  return { r: front.r * a + back.r * (1 - a), g: front.g * a + back.g * (1 - a), b: front.b * a + back.b * (1 - a) };
};
/** The contrast of two colours, 1 (the same) to 21 (black on white). */
export function ratio(one, other) {
  const x = luminance(one), y = luminance(other);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
/** The middle half of a line's height: two lines that touch at their edges are neighbours, not an overlap. */
const band = (box) => ({ x: box.x, y: box.y + box.h / 4, w: box.w, h: box.h / 2 });
const quote = (text, n = 40) => `"${String(text).slice(0, n)}"`;
const px = (n) => `${Math.round(n)}px`;

/** How many words a slide says: a fact printed beside it, never a finding. One idea a slide is the eye's to judge. */
export const wordsOn = (texts) => texts.reduce((sum, text) => sum + String(text.whole ?? text.text).split(/\s+/).filter(Boolean).length, 0);

/**
 * The findings of one slide, each `{ kind, what, box }`, from the facts slides.mjs collected on it. Boxes are in the
 * slide's own coordinates, its top left corner at 0, 0. One finding per kind and wording.
 */
export function judge(facts) {
  const { size } = facts;
  const texts = facts.texts ?? [], pictures = facts.pictures ?? [];
  const found = [];
  const whole = { x: 0, y: 0, w: size.width, h: size.height };
  // `find` is what to look for in the file to stand where the finding is; `rule` the id or class its CSS rule is under.
  const add = (kind, what, box, find = [], rule = "") => found.push({ kind, what, box: box ?? whole, find: find.filter(Boolean), rule: rule || "" });
  const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const where = (text) => (text.el ? `${text.el} ` : "");
  const floor = minText(size);
  const scale = size.width / PHONE_SHOWS;

  if (Math.abs(facts.slide.w - size.width) > 1 || Math.abs(facts.slide.h - size.height) > 1) {
    add("size", `the slide is ${px(facts.slide.w)} by ${px(facts.slide.h)}, not ${size.width} by ${size.height}`, { x: 0, y: 0, w: facts.slide.w, h: facts.slide.h }, [], "slide");
  }
  if (texts.length === 0 && pictures.length === 0 && !facts.drawn) add("empty", "nothing on the slide");

  const full = fullScreen(size);
  for (const text of texts) {
    const find = [text.text.slice(0, 40), text.handle && `"${text.handle}`];
    const { box } = text;
    if (text.px < floor - 0.5) add("small", `${px(text.px)} text (under ${floor}, which is ${MIN_TEXT_ON_A_PHONE}px on a phone): ${where(text)}${quote(text.text)}`, box, find, text.handle);

    const past = { left: -box.x, top: -box.y, right: box.x + box.w - size.width, bottom: box.y + box.h - size.height };
    const worst = Object.entries(past).sort((a, b) => b[1] - a[1])[0];
    if (worst[1] > 1) {
      add("outside", `runs ${px(worst[1])} past the slide's ${worst[0]} edge, where the picture ends: ${where(text)}${quote(text.text)}`, box, find, text.handle);
    } else if (full) {
      const bands = [
        ["top", box.y < size.height * COVERED.top, COVERED.top],
        ["bottom", box.y + box.h > size.height * (1 - COVERED.bottom), COVERED.bottom],
        ["side", box.x < size.width * COVERED.side || box.x + box.w > size.width * (1 - COVERED.side), COVERED.side],
      ].filter(([, inside]) => inside);
      if (bands.length) add("covered", `in the ${bands.map(([name, , share]) => `${name === "side" ? "outer" : name} ${Math.round(share * 100)}%${name === "side" ? " of a side" : ""}`).join(" and the ")} of a full-screen slide, where the app draws over it: ${where(text)}${quote(text.text)}`, box, find, text.handle);
    } else {
      const margin = { left: box.x, top: box.y, right: size.width - (box.x + box.w), bottom: size.height - (box.y + box.h) };
      const nearest = Object.entries(margin).sort((a, b) => a[1] - b[1])[0];
      const need = EDGE * (nearest[0] === "left" || nearest[0] === "right" ? size.width : size.height);
      if (nearest[1] < need - 0.5) add("edge", `${px(nearest[1])} from the ${nearest[0]} edge (under ${px(need)}, 5% of the slide): ${where(text)}${quote(text.text)}`, box, find, text.handle);
    }

    if (text.cut) {
      const { how, by, holds, room } = text.cut;
      const cutter = by ? ` by ${by}, which hides what runs past it and holds ${px(holds)} in ${px(room)}` : "";
      add("cut", how === "height" ? `text cut off in height${cutter}: ${quote(text.text)}` : `text cut off in width, with no "..." to say so${cutter}: ${quote(text.text)}`, box, [text.cut.handle && `"${text.cut.handle}`, ...find], text.cut.handle);
    }
    if (text.color && text.bg) {
      const front = over(text.color, text.bg);
      const seen = ratio(front, text.bg);
      const large = text.px >= 24 * scale || (text.px >= 18.66 * scale && (text.weight ?? 400) >= 700);
      const needs = large ? CONTRAST_LARGE : CONTRAST;
      if (seen < needs) add("contrast", `contrast ${seen.toFixed(1)}:1 (needs ${needs}), ${hex(front)} on ${hex(text.bg)}: ${where(text)}${quote(text.text)}`, box, find, text.handle);
    }
    if (text.glyphless?.length) add("glyph", `no glyph on this machine for ${text.glyphless.slice(0, 6).join(" ")}: drawn as an empty box in ${where(text)}${quote(text.text)}`, box, find, text.handle);
    if (/lorem ipsum|dolor sit amet/i.test(text.text)) add("filler", `filler text, not the slide's own words: ${quote(text.text)}`, box, find);
  }

  const lines = texts.flatMap((text) => (text.lines ?? [text.box]).map((box) => ({ box, text })));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i].text, b = lines[j].text;
      if (a.id === b.id || (a.path ?? []).includes(b.id) || (b.path ?? []).includes(a.id)) continue;
      if (area(band(lines[i].box), band(lines[j].box)) > 4) add("overlap", `${where(a)}${quote(a.text, 30)} over ${where(b)}${quote(b.text, 30)}`, lines[i].box, [a.text.slice(0, 40), a.handle && `"${a.handle}`], a.handle);
    }
  }

  for (const picture of pictures) if (!picture.loaded) add("picture", `a picture did not load: ${picture.src}`, picture.box, [picture.handle]);

  const seen = new Set();
  return found.filter((one) => {
    const key = one.kind + one.what;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where in the carousel's file a finding is, as ` (slides.html:212, its rule at :48)`: the line its words stand on, or
 * the word of its element, and the line of that element's CSS rule, where most fixes are made. The first is said only
 * where it is one place or a few: a word on forty lines says nothing. With it a fix is an edit at a line, with no file
 * read whole to find the place.
 */
export function whereInFile(source, file, finding) {
  if (!source) return "";
  const lineAt = (at) => source.slice(0, at).split("\n").length;
  const escaped = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let where = "";
  for (const needle of finding.find ?? []) {
    if (!needle || needle.length < 3) continue;
    const lines = [];
    for (const form of new Set([needle, escaped(needle)])) {
      for (let at = source.indexOf(form); at >= 0 && lines.length < 6; at = source.indexOf(form, at + form.length)) lines.push(lineAt(at));
    }
    const found = [...new Set(lines)].sort((a, b) => a - b);
    if (found.length >= 1 && found.length <= 3) { where = `${file}:${found.join(", ")}`; break; }
  }
  let rule = "";
  if (finding.rule && /^[\w-]+$/.test(finding.rule)) {
    const at = source.search(new RegExp(`[.#]${finding.rule}(?![\\w-])[^{};]*\\{`));
    if (at >= 0) rule = `its rule at :${lineAt(at)}`;
  }
  return where || rule ? ` (${[where, rule].filter(Boolean).join(", ")})` : "";
}

/** What to do about each kind, as slides.mjs prints it once under the findings. */
export const FIXES = {
  size: "give every slide the size in one rule (.slide { width: …px; height: …px; overflow: hidden }) and nothing that stretches it",
  small: "larger, and fewer words to make room: a slide is read on a phone, at about a third of the size it is drawn",
  outside: "bring it inside the slide: a shorter line, a smaller box, or less of it",
  edge: "move it in from the edge: the same margin on every slide",
  covered: "move it toward the middle of the slide, or keep it and say so when it is only decoration",
  contrast: "darker text or a lighter background (or the reverse), keeping the carousel's own colours",
  cut: "the box it names is the one to change: take its fixed height or width away, or its overflow, or say less in it",
  overlap: "one thing per place: remove the absolute position or the negative margin that put them together",
  picture: "the path is relative to the carousel's file, and the file is there",
  glyph: "draw it as an inline SVG or say it in a word; or install a font that has it and render again",
  filler: "write what the slide would really say, in the person's language",
  empty: "the slide did not draw: read the page: lines below",
};
