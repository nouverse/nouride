/**
 * An agent's text, drawn: Markdown as GitHub and the chat apps a person knows read it, with what an agent adds to it.
 *
 * Read by `commons/lib/markdown/lex.ts` (CommonMark with GitHub's additions, formulas, footnotes, `<details>`, an
 * `<svg>` or a page of HTML written with no fence) and drawn here from its tokens, as elements: headings of both
 * kinds, lists inside lists, tasks, quotes inside quotes and GitHub's notes, a table with its columns set to a side,
 * fenced and indented code (`CodeBlock`: coloured, with a copy button, a viewer for what has one), rules, links of
 * every kind, pictures, terms with their definitions. A link to a page of this dashboard opens it in place (`inline`).
 *
 * Formulas (KaTeX, a chunk of its own: `viewers/math.tsx`): inline `$..$` and `\(..\)`, `$$..$$` within a line, and
 * as a block a line that is `$$..$$`, or `$$` or `\[` alone on a line up to the line that ends in `$$` or `\]`. A
 * dollar opens a formula only as a writer of TeX uses it, so "$5 and $10" stays text. Code wins: a formula inside a
 * code span or a fence is code.
 *
 * Nothing an agent wrote is markup of the page: HTML with no fence is an `html` block, its code or a page held apart
 * in a frame (`commons/lib/html-run.ts`), and a tag in a line is one of a short list that only says how words look,
 * or the characters written (`markdown/inline.tsx`).
 */

import { useId, useMemo, type ReactNode } from "react";
import { blocks, footnotes } from "@/commons/components/ui/markdown/blocks";
import { Footnotes, inline, PlainWords } from "@/commons/components/ui/markdown/inline";
import { lex } from "@/commons/lib/markdown/lex";

export { PlainWords };

function Drawn({ source, compact }: { source: string; compact: boolean }) {
  // What makes this text's footnotes its own on a page that holds many texts.
  const scope = useId().replace(/[^a-z0-9]/gi, "");
  const tokens = useMemo(() => lex(source), [source]);
  const notes = useMemo(() => footnotes(tokens), [tokens]);
  const numbers = useMemo(() => new Map(notes.map((note, index) => [note.id, index + 1] as const)), [notes]);
  const said = useMemo(() => ({ numbers, scope }), [numbers, scope]);
  return (
    <Footnotes.Provider value={said}>
      {/* A word longer than its line is broken: a hash, an address or a path would run out of the box it is in. */}
      <div className={`[overflow-wrap:anywhere] ${compact ? "space-y-1.5 text-xs" : "space-y-3 text-sm"}`}>
        {blocks(tokens, "b")}
        {notes.length > 0 && (
          <ol aria-label="Footnotes" className="list-decimal space-y-1 border-t border-base-content/10 pt-2 pl-6 text-xs text-base-content/75">
            {notes.map((note, index) => (
              <li key={index} id={`${scope}-note-${index + 1}`}>
                {inline(note.tokens, `n${index}`)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Footnotes.Provider>
  );
}

/** `compact`: smaller and closer, for markdown inside something else: a notice in a chat, not a message of its own. */
export function Markdown({ source, compact = false }: { source: string; compact?: boolean }): ReactNode {
  return <Drawn source={source} compact={compact} />;
}
