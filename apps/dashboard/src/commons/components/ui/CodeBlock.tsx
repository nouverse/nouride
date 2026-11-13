/**
 * A block of code in a reply: its language, a button that copies it, and its words coloured by what they are.
 *
 * It was a grey box. A command to run had to be selected by hand, on a phone by dragging two handles, and forty lines
 * of TypeScript read as forty lines of the same grey. The button copies the code as it was written, nothing of the
 * colouring in it. The colours are the theme's own, so they follow light and dark, and each was measured against the
 * box behind it on both.
 *
 * The highlighter is asked for only when a block names a language it could know (`commons/lib/highlight.ts`, a chunk
 * of its own). Until it arrives, and whenever it does not, the block is the plain text it always was: the same words
 * in the same place, so nothing moves when the colours come.
 */

import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/commons/components/ui/CopyButton";
import type { CodePiece } from "@/commons/lib/highlight";

type Highlighter = typeof import("@/commons/lib/highlight");

/**
 * Past this many characters a block is drawn plain. Measured on a laptop: 50,000 characters of TypeScript are 10 ms
 * for the highlighter and 3,300 elements for the page, and four times that are 37 ms and 12,800; a phone is slower.
 * A block this long is a log or a dump, read by searching it and not by its colours.
 */
const COLOURED_UP_TO = 50_000;

/**
 * What each kind of piece is drawn in: the theme's own colours, each read against the block's box at 4.5 to 1 or
 * better on both themes. A kind not here is plain code.
 */
const TONE: Record<string, string> = {
  keyword: "text-secondary",
  built_in: "text-secondary",
  literal: "text-secondary",
  type: "text-secondary",
  "selector-tag": "text-secondary",
  doctag: "text-secondary",
  string: "text-success",
  regexp: "text-success",
  addition: "text-success",
  number: "text-warning",
  symbol: "text-warning",
  bullet: "text-warning",
  title: "text-primary",
  section: "text-primary font-semibold",
  name: "text-primary",
  "selector-id": "text-primary",
  "selector-class": "text-primary",
  attr: "text-accent",
  attribute: "text-accent",
  property: "text-accent",
  variable: "text-accent",
  "template-variable": "text-accent",
  deletion: "text-error",
  comment: "text-base-content/65 italic",
  quote: "text-base-content/65 italic",
  meta: "text-base-content/65",
};

let arriving: Promise<Highlighter> | null = null;
let arrived: Highlighter | null = null;

/** The highlighter, once it is here; null until then, and for a block that does not want it. */
function useHighlighter(wanted: boolean): Highlighter | null {
  const [here, setHere] = useState(arrived);
  useEffect(() => {
    if (!wanted || here) return;
    let drawn = true;
    arriving ??= import("@/commons/lib/highlight");
    arriving.then(
      (module) => {
        arrived = module;
        if (drawn) setHere(module);
      },
      // It did not load (an old tab after an update, a dropped connection): the block stays plain, and the next one asks again.
      () => {
        arriving = null;
      },
    );
    return () => {
      drawn = false;
    };
  }, [wanted, here]);
  return here;
}

export function CodeBlock({ lang, text, growing = false }: { lang?: string | undefined; text: string; /** Still being written: coloured once it is whole. */ growing?: boolean }) {
  const colourable = Boolean(lang) && !growing && text.length <= COLOURED_UP_TO;
  const highlighter = useHighlighter(colourable);
  const coloured = useMemo<CodePiece[] | null>(() => (colourable && highlighter ? highlighter.pieces(lang ?? "", text) : null), [colourable, highlighter, lang, text]);
  return (
    <div className="rounded-xl border border-base-content/10 bg-base-200/60 overflow-hidden shadow-xs">
      <div className="flex min-h-7 items-center justify-between gap-2 border-b border-base-content/10 bg-base-300/40 py-0.5 pl-3 pr-1">
        <span className="text-[11px] font-mono font-medium text-base-content/65 uppercase tracking-wider">{lang}</span>
        <CopyButton text={text} className="btn btn-ghost btn-xs max-sm:btn-sm shrink-0 gap-1 rounded-lg" />
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-base-content/90">
        <code>
          {coloured
            ? coloured.map((piece, index) => {
                const tone = piece.scope ? TONE[piece.scope] : undefined;
                return tone ? (
                  <span key={index} className={tone}>
                    {piece.text}
                  </span>
                ) : (
                  piece.text
                );
              })
            : text}
        </code>
      </pre>
    </div>
  );
}
