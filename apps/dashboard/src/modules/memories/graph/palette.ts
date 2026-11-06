/**
 * The graph's colours, read from the theme. A canvas cannot draw with `var(--…)`, so the values are read off
 * `<html>`, where daisyUI's theme sets them, and read again when `data-theme` changes — which is where
 * `theme.ts` switches it. Nothing here repeats a colour: one changed in `styles/main.css` changes the graph.
 *
 * Each kind wears a theme colour: conversations the teal (`info`), people the peach (`accent`), tags the mist
 * (`secondary`), and agents the brand blue (`primary`) — the few that act. The knowledge layer (0.8.20) is the page's
 * own ink for its documents, paper rather than talk, and green (`success`) for the collections holding them: the one hue
 * no other kind is near. Amber, a folder's colour, was tried first and read as the people's peach in both themes.
 */

import { useEffect, useState } from "react";
import type { GraphNodeKind } from "@/commons/lib/api.memory";

export interface Palette {
  kinds: Record<GraphNodeKind, string>;
  link: string;
  linkFaint: string;
  related: string;
  text: string;
  muted: string;
  /** Behind a label, so it stays legible over links. */
  backdrop: string;
  /** The page's typeface (`--font-sans`, Manrope), for the labels: a canvas does not inherit one. */
  font: string;
}

const KIND_COLOUR: Record<GraphNodeKind, string> = {
  episode: "--color-info",
  person: "--color-accent",
  tag: "--color-secondary",
  agent: "--color-primary",
  collection: "--color-success",
  document: "--color-base-content",
};

/**
 * What a colour the theme could not be read as becomes: a mid grey, legible enough on either theme. Only seen if
 * `main.css` writes a colour in another form, which `tests/theme.test.ts` refuses.
 */
const UNREADABLE = "#888888";

/**
 * `#rrggbb` from a value the theme declares, or null. `#rgb` too, which a minifier may shorten one to. Six digits
 * because the graph adds an alpha by appending two more (`ui-graph`'s `GraphNodeInput.color`).
 */
function toHex(value: string): string | null {
  const colour = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(colour)) return colour;
  if (/^#[0-9a-f]{3}$/.test(colour)) return `#${[...colour.slice(1)].map((digit) => digit + digit).join("")}`;
  return null;
}

/** The palette from a computed style that carries the theme's variables. */
function readPalette(style: Pick<CSSStyleDeclaration, "getPropertyValue">): Palette {
  const read = (name: string) => toHex(style.getPropertyValue(name)) ?? UNREADABLE;
  const ink = read("--color-base-content");
  const kinds = Object.fromEntries(Object.entries(KIND_COLOUR).map(([kind, name]) => [kind, read(name)])) as Record<GraphNodeKind, string>;
  return {
    kinds,
    link: `${ink}17`,
    linkFaint: `${ink}07`,
    related: `${kinds.episode}40`,
    text: ink,
    // The ink at 70%, over the label's backdrop: 6:1 and more on either theme.
    muted: `${ink}b3`,
    backdrop: read("--color-base-200"),
    font: style.getPropertyValue("font-family").trim(),
  };
}

const fromDocument = () => readPalette(getComputedStyle(document.documentElement));

export function usePalette(): Palette {
  const [palette, setPalette] = useState(fromDocument);
  useEffect(() => {
    const watch = new MutationObserver(() => setPalette(fromDocument()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  return palette;
}

export const KIND_LABEL: Record<GraphNodeKind, string> = { episode: "Conversations", person: "People", tag: "Tags", agent: "Agents", collection: "Collections", document: "Documents" };
