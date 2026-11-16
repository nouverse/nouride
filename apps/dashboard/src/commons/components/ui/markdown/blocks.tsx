/**
 * The blocks of a text, drawn from their tokens (`commons/lib/markdown/lex.ts`): a heading, a paragraph, a list and
 * the lists inside it, a task with its box, a quote and the quotes inside it, a note in a box (`> [!NOTE]`), a table,
 * code, a rule, a term with its definition, what folds (`<details>`), and the footnotes at a text's end.
 */

import type { ReactNode } from "react";
import { CircleAlert, Info, Lightbulb, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { CodeBlock } from "@/commons/components/ui/CodeBlock";
import { MarkdownTable } from "@/commons/components/ui/MarkdownTable";
import { inline } from "@/commons/components/ui/markdown/inline";
import { fenceClosed, type DefList, type Details, type FootnoteDef, type MathBlock, type RawBlock, type Token, type Tokens } from "@/commons/lib/markdown/lex";

const PARAGRAPH = "leading-relaxed text-base-content/85";

const HEADING: Record<number, string> = {
  1: "text-xl font-bold tracking-tight text-base-content pt-2",
  2: "text-lg font-bold tracking-tight text-base-content pt-1.5",
  3: "text-base font-semibold tracking-tight text-base-content pt-1",
};
const SMALL_HEADING = "text-sm font-semibold tracking-tight text-base-content pt-1";

/** The notes GitHub writes in a quote, by the word in their first line. */
const NOTES: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  NOTE: { label: "Note", icon: Info, tone: "border-info/60 bg-info/[0.07] [&>p:first-child]:text-info" },
  TIP: { label: "Tip", icon: Lightbulb, tone: "border-success/60 bg-success/[0.07] [&>p:first-child]:text-success" },
  IMPORTANT: { label: "Important", icon: CircleAlert, tone: "border-primary/60 bg-primary/[0.07] [&>p:first-child]:text-primary" },
  WARNING: { label: "Warning", icon: TriangleAlert, tone: "border-warning/70 bg-warning/[0.08] [&>p:first-child]:text-warning" },
  CAUTION: { label: "Caution", icon: OctagonAlert, tone: "border-error/60 bg-error/[0.07] [&>p:first-child]:text-error" },
};

/** A quote that is a note: which, and its tokens without the line that named it. */
function noteOf(quote: Tokens.Blockquote): { kind: string; tokens: Token[] } | null {
  const first = quote.tokens.find((token) => token.type !== "space");
  if (first?.type !== "paragraph") return null;
  const words = (first as Tokens.Paragraph).tokens;
  const named = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(words[0]?.type === "text" ? words[0].raw : "");
  if (!named) return null;
  // The name's own line, and the break after it.
  const rest = words.slice(words[1]?.type === "br" ? 2 : 1);
  const tokens = quote.tokens.flatMap((token) => (token === first ? (rest.length > 0 ? [{ ...first, tokens: rest } as Token] : []) : [token]));
  return { kind: named[1]!.toUpperCase(), tokens };
}

/** An item's number as it was written, or null. */
const written = (item: Tokens.ListItem) => {
  const number = /^\s*(\d{1,9})[.)]/.exec(item.raw);
  return number ? Number.parseInt(number[1]!, 10) : null;
};

function item(entry: Tokens.ListItem, key: string): ReactNode {
  const parts = entry.tokens.filter((token) => token.type !== "space" && token.type !== "checkbox");
  // What it says first is drawn in the item's own line; what follows (a list inside it, code, more words) under it.
  const first = parts[0];
  const lead = first && (first.type === "text" || first.type === "paragraph") ? inline((first as Tokens.Paragraph).tokens ?? [], `${key}-w`) : null;
  const under = lead === null ? parts : parts.slice(1);
  return (
    <>
      {lead}
      {under.length > 0 && <div className={lead === null ? "space-y-1.5" : "mt-1.5 space-y-1.5"}>{blocks(under, `${key}-u`)}</div>}
    </>
  );
}

function list(token: Tokens.List, key: string): ReactNode {
  const start = typeof token.start === "number" ? token.start : 1;
  const tasks = token.items.length > 0 && token.items.every((entry) => entry.task);
  const items = token.items.map((entry, index) => {
    const at = `${key}-${index}`;
    const number = token.ordered ? written(entry) : null;
    // Said only where it is not what counting gives: a list of one item taken up again after a paragraph, or a number skipped.
    const value = number !== null && (token.items.length === 1 || number > start + index) ? { value: number } : {};
    if (!entry.task) return <li key={at} {...value}>{item(entry, at)}</li>;
    return (
      <li key={at} className={`flex items-start gap-2 ${tasks ? "" : "-ml-5 list-none"}`}>
        {/* What the agent wrote, not something to press: read only, and as clear as a box that can be ticked. */}
        <input type="checkbox" className="checkbox checkbox-xs pointer-events-none mt-0.5 shrink-0 rounded-sm" checked={entry.checked === true} readOnly tabIndex={-1} aria-label={entry.checked ? "Done" : "Not done"} />
        <div className="min-w-0 flex-1">{item(entry, at)}</div>
      </li>
    );
  });
  if (token.ordered) {
    return (
      <ol key={key} {...(start !== 1 ? { start } : {})} className="list-decimal space-y-1.5 pl-6 text-base-content/85">
        {items}
      </ol>
    );
  }
  return (
    <ul key={key} className={tasks ? "space-y-1.5 pl-1 text-base-content/85" : "list-disc space-y-1.5 pl-6 text-base-content/85"}>
      {items}
    </ul>
  );
}

function quote(token: Tokens.Blockquote, key: string): ReactNode {
  const note = noteOf(token);
  if (note) {
    const { label, icon: Icon, tone } = NOTES[note.kind]!;
    return (
      <div key={key} role="note" className={`space-y-1.5 rounded-r-xl border-l-3 p-3 pl-4 text-sm ${tone}`}>
        <p className="flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wider">
          <Icon size={14} aria-hidden="true" /> {label}
        </p>
        {blocks(note.tokens, `${key}-n`)}
      </div>
    );
  }
  return (
    <blockquote key={key} className="border-primary/40 bg-base-content/[0.03] text-base-content/75 border-l-3 rounded-r-xl p-3 pl-4 italic text-sm space-y-2 [&_[data-viewer]]:not-italic">
      {blocks(token.tokens, `${key}-q`)}
    </blockquote>
  );
}

function details(token: Details, key: string): ReactNode {
  return (
    // Open while it is still being written: what is written into it is seen as it comes.
    <details key={key} open={token.open || !token.closed || undefined} className="group rounded-xl border border-base-content/10 bg-base-200/40">
      <summary className="flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium text-base-content marker:content-none hover:bg-base-200/70 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-base-content/65 transition-transform group-open:rotate-90">
          ›
        </span>
        <span className="min-w-0 flex-1">{token.summary.length > 0 ? inline(token.summary, `${key}-s`) : "Details"}</span>
      </summary>
      <div className="space-y-3 border-t border-base-content/10 p-3">{blocks(token.tokens, `${key}-d`)}</div>
    </details>
  );
}

function table(token: Tokens.Table, key: string): ReactNode {
  return (
    <MarkdownTable
      key={key}
      align={token.align}
      head={token.header.map((cell, index) => inline(cell.tokens, `${key}-h${index}`))}
      rows={token.rows.map((row, r) => row.map((cell, c) => inline(cell.tokens, `${key}-${r}-${c}`)))}
    />
  );
}

/** A text's blocks as what is drawn. Footnotes are not drawn where they are written: `Markdown` draws them at its end. */
export function blocks(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (const [index, token] of tokens.entries()) {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "space":
      case "def":
      case "footnoteDef":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const Tag = `h${Math.min(Math.max(heading.depth, 1), 6)}` as "h1";
        out.push(
          <Tag key={key} className={HEADING[heading.depth] ?? SMALL_HEADING}>
            {inline(heading.tokens, key)}
          </Tag>,
        );
        break;
      }
      case "paragraph":
      case "text":
        out.push(
          <p key={key} className={PARAGRAPH}>
            {inline((token as Tokens.Paragraph).tokens ?? [], key)}
          </p>,
        );
        break;
      case "list":
        out.push(list(token as Tokens.List, key));
        break;
      case "blockquote":
        out.push(quote(token as Tokens.Blockquote, key));
        break;
      case "code": {
        const code = token as Tokens.Code;
        out.push(<CodeBlock key={key} lang={code.lang || undefined} text={code.text} growing={!fenceClosed(code)} />);
        break;
      }
      case "mathBlock":
        out.push(<CodeBlock key={key} lang="math" text={(token as MathBlock).text} growing={!(token as MathBlock).closed} />);
        break;
      case "svgBlock":
        out.push(<CodeBlock key={key} lang="svg" text={(token as RawBlock).text} />);
        break;
      case "htmlRun":
        out.push(<CodeBlock key={key} lang="html" text={(token as RawBlock).text} />);
        break;
      case "table":
        out.push(table(token as Tokens.Table, key));
        break;
      case "hr":
        out.push(<hr key={key} className="border-base-content/10 my-3" />);
        break;
      case "details":
        out.push(details(token as Details, key));
        break;
      case "defList": {
        const entry = token as DefList;
        out.push(
          <dl key={key} className="text-base-content/85">
            <dt className="font-semibold text-base-content">{inline(entry.term, `${key}-t`)}</dt>
            {entry.defs.map((words, at) => (
              <dd key={at} className="mt-0.5 border-l-2 border-base-content/10 pl-3 leading-relaxed">
                {inline(words, `${key}-d${at}`)}
              </dd>
            ))}
          </dl>,
        );
        break;
      }
      case "html": {
        // A tag alone on its line that is none of what is read above, or a comment: a comment is not drawn, and a tag
        // is the characters that were written.
        const text = (token as Tokens.HTML).text.trim();
        if (text === "" || /^<!--[\s\S]*-->$/.test(text)) break;
        out.push(
          <p key={key} className={PARAGRAPH}>
            {text}
          </p>,
        );
        break;
      }
      default:
        out.push(
          <p key={key} className={PARAGRAPH}>
            {token.raw}
          </p>,
        );
    }
  }
  return out;
}

/** Every footnote of a text, wherever it was written, in the order they were. */
export function footnotes(tokens: readonly Token[], into: FootnoteDef[] = []): FootnoteDef[] {
  for (const token of tokens) {
    if (token.type === "footnoteDef") into.push(token as FootnoteDef);
    const inside = (token as { tokens?: Token[]; items?: Token[] }).items ?? (token as { tokens?: Token[] }).tokens;
    if (inside) footnotes(inside, into);
  }
  return into;
}
