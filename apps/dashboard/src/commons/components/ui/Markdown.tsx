/**
 * A secure, full-featured markdown renderer.
 * Supports: Headings, Lists, Blockquotes, Fenced Code, Tables, Horizontal Rules,
 * Bold, Italic, Code, Markdown Links [label](url), and Auto-linked Bare URLs (https://...).
 */

import { createContext, useContext, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";

/**
 * How a block's plain words are drawn: as written, or as the page around it says (an agent's answer draws its agents'
 * tags in their colours, `TagsInMarkdown`). Code is never plain words, so a code span or block stays as it was written.
 */
export const PlainWords = createContext<((text: string) => ReactNode) | null>(null);

function Plain({ text }: { text: string }) {
  const draw = useContext(PlainWords);
  return draw ? draw(text) : text;
}

/** Inline spans. Ordered so that code wins — backticks inside code are literal. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Matches: inline code, bold, italic, markdown link [label](url), and bare URLs https://...
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>'")\]]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(<Plain key={`${keyPrefix}-t${n}`} text={text.slice(last, match.index)} />);
    const token = match[0];
    const key = `${keyPrefix}-i${n++}`;

    if (token.startsWith("`")) {
      const codeContent = token.slice(1, -1).trim();
      if (/^https?:\/\//i.test(codeContent)) {
        out.push(
          <a
            key={key}
            href={codeContent}
            target="_blank"
            rel="noreferrer noopener"
            className="bg-base-200/90 text-primary hover:underline border border-base-content/10 rounded-md px-1.5 py-0.5 font-mono text-[0.85em] inline-flex items-center gap-1 break-all"
          >
            <span>{codeContent}</span>
            <ExternalLink size={10} className="shrink-0 opacity-70" />
          </a>,
        );
      } else {
        out.push(
          // Ink, not the brand blue: code is what was said, and the blue is for signals and actions (the Nouverse design rules).
          <code key={key} className="bg-base-200/90 text-base-content border border-base-content/10 rounded-md px-1.5 py-0.5 font-mono text-[0.85em]">
            {codeContent}
          </code>,
        );
      }
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-base-content">
          {inline(token.slice(2, -2), `${key}-b`)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      out.push(
        <em key={key} className="italic text-base-content/90">
          {inline(token.slice(1, -1), `${key}-em`)}
        </em>,
      );
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      const safe = /^https?:\/\//i.test(href);
      out.push(
        safe ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary hover:underline font-medium inline-flex items-center gap-0.5 break-all"
          >
            <span>{label}</span>
            <ExternalLink size={11} className="shrink-0 opacity-70" />
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else if (token.startsWith("http://") || token.startsWith("https://")) {
      // Auto-linked bare URL — strip trailing punctuation like comma, dot, quotes, or closing parenthesis
      const cleanUrl = token.replace(/[.,;:!?`"')\]]+$/, "");
      const trailing = token.slice(cleanUrl.length);

      out.push(
        <a
          key={key}
          href={cleanUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary hover:underline font-medium inline-flex items-center gap-0.5 break-all"
        >
          <span>{cleanUrl}</span>
          <ExternalLink size={11} className="shrink-0 opacity-70" />
        </a>,
      );
      if (trailing) {
        out.push(trailing);
      }
    }
    last = match.index + token.length;
  }

  if (last < text.length) out.push(<Plain key={`${keyPrefix}-tail`} text={text.slice(last)} />);
  return out;
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const cleaned = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return cleaned.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

/** `compact`: smaller and closer, for markdown inside something else — a notice in a chat, not a message of its own. */
export function Markdown({ source, compact = false }: { source: string; compact?: boolean }): ReactNode {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let list: { text: string; num?: number }[] = [];
  let ordered = false;
  let listStart: number | undefined = undefined;
  let quote: string[] = [];
  let tableRows: string[][] = [];
  let inTable = false;
  let code: string[] | null = null;
  let codeLang = "";

  const flushList = () => {
    if (list.length === 0) return;
    const items = list.map((item, i) => (
      <li
        key={i}
        {...(ordered && item.num !== undefined && (list.length === 1 || item.num > (listStart ?? 1) + i)
          ? { value: item.num }
          : {})}
      >
        {inline(item.text, `l${blocks.length}-${i}`)}
      </li>
    ));
    blocks.push(
      ordered ? (
        <ol
          key={blocks.length}
          {...(listStart !== undefined && listStart !== 1 ? { start: listStart } : {})}
          className="list-decimal space-y-1.5 pl-6 text-base-content/85"
        >
          {items}
        </ol>
      ) : (
        <ul key={blocks.length} className="list-disc space-y-1.5 pl-6 text-base-content/85">
          {items}
        </ul>
      ),
    );
    list = [];
    listStart = undefined;
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push(
      <blockquote
        key={blocks.length}
        className="border-primary/40 bg-base-content/[0.03] text-base-content/75 border-l-3 rounded-r-xl p-3 pl-4 italic text-sm"
      >
        {inline(quote.join(" "), `q${blocks.length}`)}
      </blockquote>,
    );
    quote = [];
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const headers = tableRows[0] ?? [];
    const bodyRows = tableRows.slice(1);

    blocks.push(
      <div key={blocks.length} className="overflow-x-auto my-3 rounded-2xl border border-base-content/10 shadow-2xs">
        <table className="table table-sm w-full">
          {headers.length > 0 && (
            <thead>
              <tr className="border-b border-base-content/10 bg-base-200/50 text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
                {headers.map((h, i) => (
                  <th key={i} className="py-2.5 px-3">
                    {inline(h, `th${blocks.length}-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-base-content/[0.06]">
            {bodyRows.map((row, rIdx) => (
              <tr key={rIdx} className="hover:bg-base-200/30 transition-colors">
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="py-2 px-3 text-xs text-base-content/85">
                    {inline(cell, `td${blocks.length}-${rIdx}-${cIdx}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    tableRows = [];
    inTable = false;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const line = raw.trimEnd();

    if (code !== null) {
      if (line.trim().startsWith("```")) {
        blocks.push(
          <div key={blocks.length} className="rounded-xl border border-base-content/10 bg-base-200/60 overflow-hidden shadow-xs">
            {codeLang && (
              <div className="bg-base-300/40 px-3 py-1 text-[11px] font-mono font-medium text-base-content/65 uppercase tracking-wider border-b border-base-content/10">
                {codeLang}
              </div>
            )}
            <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-base-content/90">
              <code>{code.join("\n")}</code>
            </pre>
          </div>,
        );
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }

    if (line.trim().startsWith("```")) {
      flushList();
      flushQuote();
      flushTable();
      code = [];
      codeLang = line.trim().slice(3);
      continue;
    }

    // Markdown Table Detection
    if (line.trim().startsWith("|") || (line.includes("|") && lines[idx + 1] && isTableSeparator(lines[idx + 1]!))) {
      flushList();
      flushQuote();

      if (isTableSeparator(line)) {
        inTable = true;
        continue;
      }

      const cells = parseTableRow(line);
      if (cells.length > 0) {
        tableRows.push(cells);
        inTable = true;
        continue;
      }
    } else if (inTable) {
      flushTable();
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      flushQuote();
      flushTable();
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      const size =
        level === 1
          ? "text-xl font-bold tracking-tight text-base-content pt-2"
          : level === 2
            ? "text-lg font-bold tracking-tight text-base-content pt-1.5"
            : "text-base font-semibold tracking-tight text-base-content pt-1";
      const Tag = `h${Math.min(level, 6)}` as "h1";
      blocks.push(
        <Tag key={blocks.length} className={size}>
          {inline(text, `h${blocks.length}`)}
        </Tag>,
      );
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      flushList();
      flushQuote();
      flushTable();
      blocks.push(<hr key={blocks.length} className="border-base-content/10 my-3" />);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet ?? numbered) {
      flushQuote();
      flushTable();
      const nextOrdered = Boolean(numbered);
      if (list.length > 0 && nextOrdered !== ordered) flushList();
      ordered = nextOrdered;
      if (numbered) {
        const num = Number.parseInt(numbered[1] ?? "1", 10);
        if (listStart === undefined) {
          listStart = num;
        }
        list.push({ text: numbered[2] ?? "", num });
      } else {
        list.push({ text: bullet?.[1] ?? "" });
      }
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushList();
      flushTable();
      quote.push(quoted[1] ?? "");
      continue;
    }

    if (line.trim() === "") {
      flushQuote();
      flushTable();
      if (list.length > 0) {
        let nextItemType: "ordered" | "unordered" | null = null;
        for (let j = idx + 1; j < lines.length; j++) {
          const trimmed = lines[j]!.trim();
          if (trimmed === "") continue;
          if (/^\d+[.)]\s+/.test(trimmed)) {
            nextItemType = "ordered";
          } else if (/^[-*+]\s+/.test(trimmed)) {
            nextItemType = "unordered";
          }
          break;
        }

        const continues =
          (ordered && nextItemType === "ordered") ||
          (!ordered && nextItemType === "unordered");

        if (continues) {
          continue;
        }
        flushList();
      }
      continue;
    }

    flushList();
    flushQuote();
    flushTable();
    blocks.push(
      <p key={blocks.length} className="leading-relaxed text-base-content/85">
        {inline(line, `p${blocks.length}`)}
      </p>,
    );
  }

  flushList();
  flushQuote();
  flushTable();

  if (code !== null) {
    blocks.push(
      <pre key={blocks.length} className="bg-base-200/60 border border-base-content/10 overflow-x-auto rounded-xl p-3.5 font-mono text-xs text-base-content/90">
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }

  return <div className={compact ? "space-y-1.5 text-xs" : "space-y-3 text-sm"}>{blocks}</div>;
}
