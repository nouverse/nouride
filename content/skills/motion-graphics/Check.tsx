// What a frame gets wrong that can be measured rather than judged — copied into a project's src/ by the
// motion-graphics skill (step 5). It renders the video at one frame with each finding outlined in red and listed at the
// top — `remotion still` does not pass a page's console on, so the picture is the report:
//   small    text under 1/30 of the frame's shorter side
//   margin   text inside the 5% margin
//   covered  in a 9:16 frame, in place of the margin: text in the top 14%, the bottom 35% or the outer 6% of a side,
//            where the apps draw their own bars and buttons over a full-screen video (Meta's guidance for a 9:16
//            placement, as guides to it quote it; the apps change it, so one kept on purpose is said, not hidden)
//   contrast text that has fully arrived, against the plain colour behind it, under 4.5:1, or 3:1 for large text
//            (the WCAG AA ratios; large is twice the smallest text, as 24 px is twice 12, or 1.55 times it in bold).
//            Text over a picture or a gradient, and text still fading, is not measured: that is judged by eye
//   alone    a word alone on the last line of a block of text
//   overlap  text over a picture, or over text of another element
// Register it beside Main with the same size, fps and length:
//   <Composition id="Check" component={makeCheck(Main)} {...MAIN} />
// A full-frame picture (a background) is not counted as one text can sit over.
import { useEffect, useRef, useState, type ComponentType } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";

type Box = { x: number; y: number; w: number; h: number };
type Finding = { kind: "small" | "margin" | "covered" | "contrast" | "alone" | "overlap"; what: string; box: Box };
type Colour = { r: number; g: number; b: number; a: number };

/** How much of an element shows through everything above it: 0 when it is hidden. */
const opacityOf = (el: Element): number => {
  let opacity = 1;
  for (let a: Element | null = el; a; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.display === "none" || s.visibility === "hidden") return 0;
    opacity *= parseFloat(s.opacity || "1");
  }
  return opacity;
};
const shown = (el: Element): boolean => opacityOf(el) > 0.2;

const colourOf = (css: string): Colour | null => {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
  return p.length >= 3 && p.every((v) => Number.isFinite(v)) ? { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 } : null;
};
// What is behind a piece of text: the nearest background that is a plain colour. A picture or a gradient is null.
const behind = (el: Element): Colour | null => {
  for (let a: Element | null = el; a; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.backgroundImage && s.backgroundImage !== "none") return null;
    const c = colourOf(s.backgroundColor);
    if (c && c.a > 0.5) return c;
  }
  return null;
};
const luminance = (c: Colour): number => {
  const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const ratio = (a: Colour, b: Colour): number => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const hex = (c: Colour): string => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** A full phone screen, where the apps draw over the video: the top, the bottom and each side they keep for themselves. */
const COVERED = { top: 0.14, bottom: 0.35, side: 0.06 };

const area = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// The middle half of a line of text: a glyph's box runs past the line's height, so the boxes of two lines set one under
// the other touch at their ascenders and descenders, and only text that really lies over something reaches this band.
const band = (b: Box): Box => ({ x: b.x, y: b.y + b.h / 4, w: b.w, h: b.h / 2 });

const around = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

function measure(root: HTMLElement, width: number, height: number): Finding[] {
  const found: Finding[] = [];
  const min = Math.min(width, height) / 30;
  const mx = width * 0.05;
  const my = height * 0.05;
  const fullScreen = Math.abs(width / height - 9 / 16) < 0.01;
  const origin = root.getBoundingClientRect();
  const scaleOf = origin.width / width;
  const rel = (r: DOMRect): Box => ({ x: (r.left - origin.left) / scaleOf, y: (r.top - origin.top) / scaleOf, w: r.width / scaleOf, h: r.height / scaleOf });
  const lines: { el: Element; box: Box; text: string }[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.textContent ?? "";
    const text = raw.replace(/\s+/g, " ").trim();
    const el = node.parentElement;
    if (!text || !el || !shown(el)) continue;
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).map(rel);
    if (rects.length === 0) continue;
    for (const box of rects) lines.push({ el, box, text });
    const own = el instanceof HTMLElement && el.offsetWidth > 0 ? el.getBoundingClientRect().width / scaleOf / el.offsetWidth : 1;
    const px = parseFloat(getComputedStyle(el).fontSize) * own;
    if (px < min - 0.5) found.push({ kind: "small", what: `${Math.round(px)} px, under ${Math.round(min)}: "${text.slice(0, 40)}"`, box: around(rects) });
    if (fullScreen) {
      const where = [
        rects.some((b) => b.y < height * COVERED.top) && "the top 14%",
        rects.some((b) => b.y + b.h > height * (1 - COVERED.bottom)) && "the bottom 35%",
        rects.some((b) => b.x < width * COVERED.side || b.x + b.w > width * (1 - COVERED.side)) && "the outer 6% of a side",
      ].filter(Boolean);
      if (where.length) found.push({ kind: "covered", what: `in ${where.join(" and ")}, where the app draws over a full-screen video: "${text.slice(0, 40)}"`, box: around(rects) });
    } else if (rects.some((b) => b.x < mx || b.y < my || b.x + b.w > width - mx || b.y + b.h > height - my)) {
      found.push({ kind: "margin", what: `inside the 5% margin: "${text.slice(0, 40)}"`, box: around(rects) });
    }
    // Only text that has arrived: one still fading in is paler than it will be, and is no finding.
    const front = colourOf(getComputedStyle(el).color);
    const back = behind(el);
    if (front && back && front.a > 0.95 && opacityOf(el) > 0.95) {
      const seen = ratio(front, back);
      const weight = parseInt(getComputedStyle(el).fontWeight, 10) || 400;
      const needs = px >= min * 2 || (px >= min * 1.555 && weight >= 700) ? 3 : 4.5;
      if (seen < needs) found.push({ kind: "contrast", what: `${seen.toFixed(1)}:1 (needs ${needs}), ${hex(front)} on ${hex(back)}: "${text.slice(0, 40)}"`, box: around(rects) });
    }
    // Each word's line, by where it sits: the last line holding one word, of two lines or more, is a word alone.
    const words = [...raw.matchAll(/\S+/g)].map((m) => {
      range.setStart(node!, m.index!);
      range.setEnd(node!, m.index! + m[0].length);
      return { word: m[0], top: rel(range.getBoundingClientRect()).y };
    });
    const tops: number[] = [];
    for (const w of words) if (!tops.some((t) => Math.abs(t - w.top) < px / 2)) tops.push(w.top);
    if (tops.length > 1) {
      const last = Math.max(...tops);
      const onLast = words.filter((w) => Math.abs(w.top - last) < px / 2);
      if (onLast.length === 1) found.push({ kind: "alone", what: `"${onLast[0]!.word}" alone on the last line of "${text.slice(0, 40)}"`, box: around(rects) });
    }
  }
  const pictures = [...root.querySelectorAll("img, svg, canvas, video")]
    .filter((p) => shown(p))
    .map((p) => rel(p.getBoundingClientRect()))
    .filter((b) => b.w * b.h > 1 && b.w * b.h < width * height * 0.6);
  for (const line of lines) {
    const mid = band(line.box);
    const hit = pictures.find((p) => area(mid, p) > mid.w * mid.h * 0.15);
    if (hit) found.push({ kind: "overlap", what: `over a picture: "${line.text.slice(0, 40)}"`, box: line.box });
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const [ma, mb] = [band(a.box), band(b.box)];
      if (area(ma, mb) > Math.min(ma.w * ma.h, mb.w * mb.h) * 0.15) {
        found.push({ kind: "overlap", what: `over other text: "${a.text.slice(0, 30)}" / "${b.text.slice(0, 30)}"`, box: around([a.box, b.box]) });
      }
    }
  }
  // One finding per kind and text: a heading over three lines is one problem.
  return found.filter((f, i) => found.findIndex((g) => g.kind === f.kind && g.what === f.what) === i);
}

export const makeCheck = (Video: ComponentType) => () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ref = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<Finding[] | null>(null);
  const [handle] = useState(() => delayRender("measuring the frame"));
  useEffect(() => {
    let stale = false;
    const root = ref.current;
    if (!root) return;
    const pictures = [...root.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined));
    Promise.all([document.fonts.ready, ...pictures]).then(() => {
      if (stale) return;
      setFound(measure(root, width, height));
    });
    return () => {
      stale = true;
    };
  }, [frame, width, height]);
  useEffect(() => {
    if (found) continueRender(handle);
  }, [found, handle]);
  const size = Math.round(Math.min(width, height) / 22);
  return (
    <AbsoluteFill>
      <AbsoluteFill ref={ref}>
        <Video />
      </AbsoluteFill>
      {found?.map((f, i) => (
        <div key={i} style={{ position: "absolute", left: f.box.x - 6, top: f.box.y - 6, width: f.box.w + 12, height: f.box.h + 12, border: "6px solid #ff2d2d" }} />
      ))}
      {/* A clean frame gets a small mark in a corner, not a bar across the top: the bar hid the top of every frame, and a
          label set there could not be judged on the check stills (live, 0.8.12). */}
      {found && found.length === 0 && (
        <div style={{ position: "absolute", right: 0, bottom: 0, padding: size / 4, background: "rgba(0,0,0,0.7)", color: "#4ade80", fontSize: size / 2, fontFamily: "sans-serif" }}>
          {`frame ${frame}: nothing measured wrong`}
        </div>
      )}
      {found && found.length > 0 && (
        <div style={{ position: "absolute", left: 0, top: 0, right: 0, padding: size / 2, background: "rgba(0,0,0,0.82)", color: "#ff6b6b", fontSize: size, fontFamily: "sans-serif", lineHeight: 1.25 }}>
          {found.map((f, i) => <div key={i}>{`${f.kind}: ${f.what}`}</div>)}
        </div>
      )}
    </AbsoluteFill>
  );
};
