/**
 * A `mermaid` block drawn as its diagram, with Mermaid, a chunk of its own loaded when the first such block is drawn.
 *
 * Mermaid writes the diagram as SVG, and the SVG is shown as a picture (`<img>` with a `data:` address), never put in
 * the page as markup: the same rule as an `svg` block (`viewers/svg.tsx`). On top of that Mermaid runs in its strict
 * mode: no click handlers, no script, its labels sanitized, and labels drawn as SVG text, never as HTML. So a label
 * holding markup is its text.
 *
 * In the theme's colours, read off `<html>` where daisyUI sets them, and drawn again when the theme changes. The
 * labels are set in the system's sans-serif: a picture cannot use the page's own font, and the text is measured in
 * the font it is drawn in. A diagram Mermaid cannot read is the code it was (`onFail`), and Mermaid draws no error box
 * of its own into the page.
 */

import { useEffect, useMemo, useState } from "react";
import mermaid, { type MermaidConfig } from "mermaid";
import { Leaving } from "@/commons/components/ui/OverPage";
import { Lightbox } from "@/commons/components/ui/Lightbox";
import { useOfficeTheme } from "@/commons/office/lib/hooks";
import type { ViewerProps } from "@/commons/components/ui/viewers";

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** A theme colour as `#rrggbb`, or a grey when the theme writes it in another form. */
function colour(style: CSSStyleDeclaration, name: string): string {
  const value = style.getPropertyValue(name).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{3}$/.test(value)) return `#${[...value.slice(1)].map((digit) => digit + digit).join("")}`;
  return "#888888";
}

export function configFor(dark: boolean): MermaidConfig {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => colour(style, name);
  const ink = read("--color-base-content");
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    maxEdges: 500,
    theme: "base",
    darkMode: dark,
    fontFamily: FONT,
    themeVariables: {
      darkMode: dark,
      fontFamily: FONT,
      background: read("--color-base-100"),
      mainBkg: read("--color-base-200"),
      primaryColor: read("--color-base-200"),
      primaryTextColor: ink,
      primaryBorderColor: read("--color-primary"),
      secondaryColor: read("--color-base-300"),
      tertiaryColor: read("--color-base-100"),
      lineColor: ink,
      textColor: ink,
      noteBkgColor: read("--color-base-300"),
      noteTextColor: ink,
    },
  };
}

let drawn = 0;

/** The diagram's SVG, or null while it is drawn; `onFail` when Mermaid cannot read it. */
async function draw(text: string, dark: boolean): Promise<string> {
  mermaid.initialize(configFor(dark));
  await mermaid.parse(text);
  const { svg } = await mermaid.render(`nr-mermaid-${++drawn}`, text);
  return svg;
}

export default function MermaidDiagram({ text, onFail }: ViewerProps) {
  const theme = useOfficeTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let mounted = true;
    draw(text, theme === "dark").then(
      (made) => mounted && setSvg(made),
      () => mounted && onFail(),
    );
    return () => {
      mounted = false;
    };
    // `onFail` is a new function each render: a diagram is drawn again when it or the theme changes.
  }, [text, theme]);
  const src = useMemo(() => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null), [svg]);
  if (!src) return <div className="h-24 animate-pulse rounded-lg bg-base-300/40" aria-label="Drawing the diagram" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block max-w-full cursor-zoom-in rounded-lg" aria-label="Open the diagram large">
        <img src={src} alt="A diagram drawn from Mermaid" onError={onFail} className="block h-auto max-w-full" />
      </button>
      <Leaving value={open && src}>{(picture) => <Lightbox pictures={[{ src: picture, name: "diagram.svg" }]} onClose={() => setOpen(false)} />}</Leaving>
    </>
  );
}
