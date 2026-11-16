/**
 * A formula drawn as it is typeset, with KaTeX: a fence named `math` or `latex`, a block in `$$..$$` or `\[..\]`, and
 * inline `$..$` or `\(..\)` (`Markdown.tsx` finds them, `InlineMath.tsx` draws the inline ones).
 *
 * KaTeX and its stylesheet are this module's, so a chunk of their own, loaded when the first formula is drawn. Its
 * fonts are files of the dashboard's own, sent with the rest of it: the policy has no `font-src`, so a font falls to
 * `default-src 'self'`, and the build keeps the woff2 of each face only (`apps/dashboard/scripts/woff2-only.ts`).
 *
 * KaTeX builds the formula as elements of its own (`render`, never markup parsed from a string), and with `trust` off
 * nothing a formula says can make a link, a class, a style or an attribute: `\href`, `\url`, `\htmlClass` and the like
 * are refused. `maxExpand` and `maxSize` keep a formula from growing without end. A formula KaTeX cannot read is shown
 * as it was written (`onFail`).
 */

import { useLayoutEffect, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { ViewerProps } from "@/commons/components/ui/viewers";

const OPTIONS: katex.KatexOptions = { throwOnError: true, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20, output: "htmlAndMathml" };

/** One formula, set in display (a block of its own) or in the line. */
export function Formula({ tex, display, onFail }: { tex: string; display: boolean; onFail: () => void }) {
  const into = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!into.current) return;
    try {
      katex.render(tex, into.current, { ...OPTIONS, displayMode: display });
    } catch {
      onFail();
    }
    // `onFail` is a new function each render: a formula is drawn again only when it or its setting changes.
  }, [tex, display]);
  return <span ref={into} data-formula={display ? "block" : "inline"} className={display ? "block text-base" : undefined} />;
}

export default function MathBlock({ text, onFail }: ViewerProps) {
  return <Formula tex={text.trim()} display onFail={onFail} />;
}
