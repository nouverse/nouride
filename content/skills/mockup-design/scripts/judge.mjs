// judge.mjs - what is wrong with a page, decided from what render.mjs measured in it. Part of the mockup-design skill.
//
// render.mjs opens a page in a browser and writes down facts: where each piece of text is and how large, its colour
// and what is behind it, each thing a person can press, each field, each picture, how wide the page came out. This
// file turns the facts into findings. It holds no browser and no file, so each rule can be read and tried alone.
//
// Every rule is a floor for use, never a taste: a page can pass all of them and be ugly, and no rule here says what a
// page should look like. The numbers and where they come from:
//   small     text under 12 px: under it, letters stop being read on a laptop and on a phone alike
//   zoom      on a phone, a field whose text is under 16 px: iOS zooms the whole page when it is tapped
//   tap       on a phone, something to press that is under 44 x 44 px: the size a fingertip covers (the platforms' own
//             guidance for a touch target); a link inside a sentence is left alone
//   contrast  text against what is behind it under 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold): the WCAG AA
//             ratios. Text over a picture or a gradient is not measured: that is judged by eye
//   sideways  the page is wider than the window, so it scrolls sideways; what sticks out is named
//   viewport  on a phone, no <meta name="viewport">: a phone then draws the page 980 px wide and shrinks it
//   cut       text cut off by its own box, in height, or in width with no "..." to say so
//   overlap   one piece of text drawn over another
//   picture   a picture that did not load
//   filler    lorem ipsum left in: a mockup is judged by its real words
//   empty     nothing on the page

export const MIN_TEXT = 12;
export const MIN_FIELD_ON_A_PHONE = 16;
export const MIN_TAP = 44;
export const CONTRAST = 4.5;
export const CONTRAST_LARGE = 3;

/** The windows a mockup is drawn in. A phone's is drawn at twice the pixels, as its screen is. */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, scale: 1, mobile: false },
  mobile: { width: 390, height: 844, scale: 2, mobile: true },
  tablet: { width: 820, height: 1180, scale: 2, mobile: true },
};

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** A colour that lets some of what is behind it through, as it is seen there. */
export function over(front, back) {
  const a = front.a ?? 1;
  return { r: front.r * a + back.r * (1 - a), g: front.g * a + back.g * (1 - a), b: front.b * a + back.b * (1 - a) };
}

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

/**
 * The findings of one page in one window, each `{ kind, what, box }`, from the facts render.mjs collected there.
 * One finding per kind and wording: the same sentence can trip a rule on each of its lines.
 */
export function judge(facts) {
  const { viewport, page } = facts;
  const texts = facts.texts ?? [], controls = facts.controls ?? [], fields = facts.fields ?? [], pictures = facts.pictures ?? [], wide = facts.wide ?? [];
  const found = [];
  const add = (kind, what, box) => found.push({ kind, what, box: box ?? { x: 0, y: 0, w: viewport.width, h: viewport.height } });

  if (texts.length === 0 && pictures.length === 0) add("empty", "nothing on the page");

  const extra = page.scrollWidth - viewport.width;
  if (extra > 1) {
    add("sideways", `the page is ${px(extra)} wider than the window (${viewport.width}px) and scrolls sideways`, { x: viewport.width, y: 0, w: extra, h: Math.min(page.scrollHeight, viewport.height) });
    for (const one of wide.slice(0, 3)) add("sideways", `sticks out ${px(one.box.x + one.box.w - viewport.width)} past the window: ${one.what}`, one.box);
  }
  if (viewport.mobile && !page.hasViewportMeta) add("viewport", 'no <meta name="viewport" content="width=device-width, initial-scale=1">: a phone draws this page 980px wide and shrinks it');

  for (const text of texts) {
    if (text.px < MIN_TEXT - 0.5) add("small", `${px(text.px)} text (under ${MIN_TEXT}): ${quote(text.text)}`, text.box);
    if (text.cut === "height") add("cut", `text cut off by its box, in height: ${quote(text.text)}`, text.box);
    if (text.cut === "width") add("cut", `text cut off by its box, with no "..." to say so: ${quote(text.text)}`, text.box);
    if (text.color && text.bg) {
      const seen = ratio(over(text.color, text.bg), text.bg);
      const large = text.px >= 24 || (text.px >= 18.66 && (text.weight ?? 400) >= 700);
      const needs = large ? CONTRAST_LARGE : CONTRAST;
      if (seen < needs) add("contrast", `contrast ${seen.toFixed(1)}:1 (needs ${needs}): ${quote(text.text)}`, text.box);
    }
    if (/lorem ipsum|dolor sit amet/i.test(text.text)) add("filler", `filler text, not the page's own words: ${quote(text.text)}`, text.box);
  }

  // Text over text: two lines of different elements, neither inside the other, neither pinned to the window (a bar
  // that stays at the foot of a phone's screen lies over the page by design).
  const lines = texts.filter((text) => !text.pinned).flatMap((text) => (text.lines ?? [text.box]).map((box) => ({ box, text })));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i].text, b = lines[j].text;
      if (a.id === b.id || (a.path ?? []).includes(b.id) || (b.path ?? []).includes(a.id)) continue;
      if (area(band(lines[i].box), band(lines[j].box)) > 4) add("overlap", `${quote(a.text, 30)} over ${quote(b.text, 30)}`, lines[i].box);
    }
  }

  if (viewport.mobile) {
    for (const control of controls) {
      if (control.inline) continue;
      if (control.box.w < MIN_TAP - 0.5 || control.box.h < MIN_TAP - 0.5) {
        add("tap", `${Math.round(control.box.w)}x${Math.round(control.box.h)} to press (under ${MIN_TAP}x${MIN_TAP}): ${control.what}`, control.box);
      }
    }
    for (const field of fields) {
      if (field.px < MIN_FIELD_ON_A_PHONE - 0.5) add("zoom", `a field with ${px(field.px)} text (under ${MIN_FIELD_ON_A_PHONE}): a phone zooms the page when it is tapped: ${field.what}`, field.box);
    }
  }

  for (const picture of pictures) if (!picture.loaded) add("picture", `a picture did not load: ${picture.src}`, picture.box);

  const seen = new Set();
  return found.filter((one) => {
    const key = one.kind + one.what;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What to do about each kind, as render.mjs prints it once under the findings. */
export const FIXES = {
  sideways: "find what is wider than the window (a fixed width, a long word, a table, 100vw plus padding) and let it wrap, shrink or scroll inside its own box",
  viewport: "add the meta tag to <head>",
  small: `no text under ${MIN_TEXT}px: make it larger, and say less to make room`,
  zoom: `fields at ${MIN_FIELD_ON_A_PHONE}px or more at a phone's width`,
  tap: `give it ${MIN_TAP}px of height and width at a phone's width: padding counts`,
  contrast: "darker text or a lighter background (or the reverse), keeping the page's own colours",
  cut: "let the box grow, wrap the text, or shorten the words",
  overlap: "one thing per place: remove the absolute position or the negative margin that put them together",
  picture: "the path is relative to the page's own file, and the file is there",
  filler: "write what the screen would really say, in the person's language",
  empty: "the page did not draw: read the page: lines below",
};
