/**
 * The markdown a model writes, turned into something each platform can render.
 *
 * Models emit markdown whether or not anything asked them to. Telegram sends plain text unless a
 * `parse_mode` is set, so `**bold**` and backticks arrive literally — in model replies *and* in the
 * approval prompts the daemon writes. It looks broken, and it is the first thing anyone notices.
 *
 * **The parser is shared; the renderers are not.** How a platform draws bold is that platform's
 * business and belongs in its adapter (invariant 2). What is common is deciding *what is* bold, and
 * doing that twice is how two adapters end up disagreeing about the same message.
 *
 * Two rendering decisions live here anyway, and deliberately: `flattenTable` and `safeHref`. Neither
 * is about how a platform draws a mark — they are about what a table *becomes* when nothing can draw
 * one, and which link targets are worth emitting at all. Both answers must be identical on every
 * platform that cannot render the thing, and two adapters quietly disagreeing about them is the
 * failure this file's split exists to prevent.
 *
 * Still a subset, and still on purpose: fenced and inline code, bold, italic, strikethrough, links,
 * headings, blockquotes and tables. Images, footnotes and nested lists are left as text — a plain
 * `- item` already reads correctly everywhere, and an image has nowhere to go.
 *
 * Tables used to be on that leave-as-text list, with the reasoning that they "have no representation
 * on these platforms anyway, so parsing them would only produce something to throw away". That was
 * wrong in a way worth naming: not parsing a table does not throw it away, it *sends* it — a wall of
 * `| … |` that wraps every two words on a phone. Whether a table is rendered is a choice; whether it
 * is in the message is not.
 */

export type Node =
  | { type: "text"; value: string }
  | { type: "bold"; children: Node[] }
  | { type: "italic"; children: Node[] }
  | { type: "strike"; children: Node[] }
  | { type: "code"; value: string }
  | { type: "pre"; value: string; lang?: string }
  | { type: "link"; href: string; children: Node[] }
  | { type: "heading"; level: number; children: Node[] }
  | { type: "quote"; children: Node[] }
  | { type: "table"; header: TableRow; rows: TableRow[] };

/** One row of a table. A cell is parsed inline, so `| **a** |` keeps its bold. */
export type TableRow = Node[][];

export type TableNode = Extract<Node, { type: "table" }>;

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/**
 * Split into fenced blocks and everything else, by line.
 *
 * Line-based rather than a regex over the whole string: an unterminated fence — which a truncated
 * model response produces routinely — has to run to the end of the message rather than swallowing the
 * rest of the parse or failing to match at all.
 */
function splitFences(source: string): Node[] {
  const lines = source.split("\n");
  const out: Node[] = [];
  let plain: string[] = [];

  const flushPlain = (): void => {
    if (plain.length === 0) return;
    out.push(...parseBlocks(plain));
    plain = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const match = FENCE.exec(lines[i] as string);
    if (!match) {
      plain.push(lines[i] as string);
      continue;
    }

    flushPlain();
    const marker = match[1] as string;
    const lang = (match[2] ?? "").trim();
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !(lines[i] as string).trimStart().startsWith(marker)) {
      body.push(lines[i] as string);
      i += 1;
    }
    out.push({ type: "pre", value: body.join("\n"), ...(lang ? { lang } : {}) });
  }

  flushPlain();
  return out;
}

/**
 * Line-level constructs, inside one run of un-fenced text.
 *
 * Everything here is decided by what a line *starts with*, which is why it cannot live in the inline
 * pass: `#` is a heading at column zero and a hash anywhere else, and a table is three lines agreeing
 * with each other rather than a mark inside one.
 *
 * The output is grouped and rejoined with a single newline between groups, because every group came
 * from consecutive source lines. Getting this wrong is silent and ugly — an early version lifted the
 * heading out and dropped the line breaks around it, so a heading welded itself to the sentence
 * before and the sentence after.
 */
function parseBlocks(lines: string[]): Node[] {
  const groups: Node[][] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    // Joined and parsed as one string so the inline pass sees the newlines it needs: a construct
    // never spans lines, but the text between them has to survive.
    groups.push(parseInline(paragraph.join("\n")));
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      groups.push([
        { type: "heading", level: (heading[1] as string).length, children: parseInline(heading[2] as string) },
      ]);
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        body.push((lines[i] as string).replace(QUOTE, ""));
        i += 1;
      }
      i -= 1;
      // Recursive, so a quoted table or a quoted heading is still one — and so a `>>` nests.
      groups.push([{ type: "quote", children: parseBlocks(body) }]);
      continue;
    }

    const table = readTable(lines, i);
    if (table) {
      flushParagraph();
      groups.push([table.node]);
      i = table.end;
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();

  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ type: "text" as const, value: "\n" }, ...group],
  );
}

/** Trailing hashes are a closing marker, not content: `## Title ##` is titled "Title". */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** The space after `>` is optional in CommonMark, and models write it both ways. */
const QUOTE = /^ {0,3}> ?/;

/**
 * A table starting at `start`, or null.
 *
 * Two lines have to agree before anything is a table — a header and a delimiter — which is what keeps
 * an ordinary sentence containing a pipe from becoming one. Body rows then run until a line with no
 * pipe in it, rather than to the end of the run: a model routinely writes a table and then keeps
 * talking, with no blank line in between.
 */
function readTable(lines: string[], start: number): { node: TableNode; end: number } | null {
  const header = lines[start] as string;
  const delimiter = lines[start + 1];
  if (delimiter === undefined || !header.includes("|") || !isDelimiterRow(delimiter)) return null;

  const headerCells = splitRow(header);
  // A one-column table is legal markdown and never intentional; requiring two is what stops
  // `note | see below` over a `| --- |` from being read as tabular data.
  if (headerCells.length < 2) return null;

  const rows: TableRow[] = [];
  let end = start + 1;
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!line.includes("|")) break;
    rows.push(splitRow(line).map(parseInline));
    end = i;
  }

  return { node: { type: "table", header: headerCells.map(parseInline), rows }, end };
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * One line into cells.
 *
 * The outer pipes are optional in GFM and models omit them about half the time. An escaped `\|` is a
 * literal pipe inside a cell and must not split it — the case that produces this is a table of shell
 * commands, which is a table a model writes often.
 */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/**
 * The characters a backslash makes literal (0.8.7) — what `escapeMarkdown` escapes. Without it, free text from outside
 * the daemon put into a prompt — a CLI's title, an approval's reason — was read as markup: an underscore in a path
 * opened an italic that swallowed the rest of the line, a backtick opened code.
 */
const ESCAPABLE = /[\\`*_~[\]()|#>]/g;

/** Free text made literal for this parser — and for Discord's, which reads the same backslashes. */
export function escapeMarkdown(text: string): string {
  return text.replace(ESCAPABLE, "\\$&");
}

/**
 * An escaped character first, so `\*` is a star and not the start of an italic; then inline code — nothing inside
 * backticks is markup, so it has to win before anything else runs (a backslash inside code is leftmost-beaten by it).
 */
const INLINE = [
  { type: "escape" as const, re: /\\([\\`*_~[\]()|#>])/ },
  { type: "code" as const, re: /`([^`\n]+)`/ },
  { type: "bold" as const, re: /\*\*([^\n]+?)\*\*/ },
  { type: "bold" as const, re: /__([^\n]+?)__/ },
  { type: "strike" as const, re: /~~([^\n]+?)~~/ },
  // One level of balanced parentheses in the target, because real URLs contain them —
  // `…/Foo_(disambiguation)` and `javascript:alert(1)` alike, and getting the second one wrong left a
  // stray `)` in the output next to a link that had been correctly refused.
  { type: "link" as const, re: /\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/ },
  // Single-character emphasis last, and requiring a non-space after the marker, so `a * b * c` and a
  // stray asterisk in prose stay literal.
  { type: "italic" as const, re: /\*([^\s*][^\n*]*?)\*/ },
  // Underscores additionally may not sit inside a word: `my_file_name.txt` is a filename, not two
  // emphasis markers, and it is far more common in this traffic than `_emphasis_` is.
  { type: "italic" as const, re: /(?<![A-Za-z0-9_])_([^\s_][^\n_]*?)_(?![A-Za-z0-9_])/ },
];

function parseInline(source: string): Node[] {
  if (source === "") return [];

  let best: { at: number; length: number; node: Node } | null = null;

  for (const rule of INLINE) {
    const match = rule.re.exec(source);
    if (!match || match.index === undefined) continue;
    // Leftmost wins, so the constructs nest in the order they were written rather than in the order
    // this list happens to be in.
    if (best && match.index >= best.at) continue;

    const inner = match[1] ?? "";
    const node: Node =
      rule.type === "escape"
        ? { type: "text", value: inner }
        : rule.type === "code"
        ? { type: "code", value: inner }
        : rule.type === "link"
          ? { type: "link", href: match[2] ?? "", children: parseInline(inner) }
          : { type: rule.type, children: parseInline(inner) };

    best = { at: match.index, length: match[0].length, node };
  }

  if (!best) return [{ type: "text", value: source }];

  return [
    ...(best.at > 0 ? parseInline(source.slice(0, best.at)) : []),
    best.node,
    ...parseInline(source.slice(best.at + best.length)),
  ];
}

export function parseMarkdown(source: string): Node[] {
  return splitFences(source);
}

/**
 * Strip formatting, keeping the words.
 *
 * The fallback when a platform rejects a formatted send. Losing the bold is a much smaller failure
 * than losing the message, and a send that fails on one unescaped character does lose the message.
 */
export function toPlainText(nodes: Node[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.value;
        case "code":
          return node.value;
        case "pre":
          return node.value;
        case "table":
          return toPlainText(flattenTable(node));
        default:
          return toPlainText(node.children);
      }
    })
    .join("");
}

/**
 * A table, as records a phone can read.
 *
 * No chat platform this daemon speaks to draws a table, and the fallback everyone reaches for — send
 * the pipes and let it wrap — is the worst available outcome: on a phone a five-column table becomes
 * a column of fragments with no way to tell which row a number came from. So the table stops being a
 * grid and becomes what a person types into WhatsApp instead, one record at a time.
 *
 * Returned as `Node[]` rather than a string, so this decision is made once and every renderer draws
 * the result with the marks it already knows. The alternative — a `case "table"` in each adapter that
 * builds its own text — is three places that have to keep agreeing about a layout.
 *
 * **The caption exists to explain values that would otherwise carry no label at all**, which is why
 * only a two-column table gets one. Two columns collapse to `**Jakarta**: 31` and nothing in that
 * line says what 31 is, so the header goes above it as `**Kota · Suhu**` — one line for the whole
 * table however many rows arrive, rather than a label repeated on each of them.
 *
 * Three or more columns need no caption, and this was got wrong in both directions before settling.
 * First the header was dropped outright, which lost `Suhu` in the two-column case. Then a caption was
 * added everywhere, and the first live reply carrying a comparison table opened with a bare
 * **Dimensi** floating above the records — the operator's first question was whether the message had
 * been truncated. That is the answer: in a wide table every value is already labelled inline, and the
 * first column has become a bold heading that names itself. Its header labels the *heading*, not a
 * value, and the header of a wide table's first column is boilerplate almost by construction —
 * "Dimensi", "Parameter", "Aspek". A caption that makes a reader think the message is broken costs
 * more than the word it saves.
 */
export function flattenTable(table: TableNode): Node[] {
  const labels = table.header.map((cell) => toPlainText(cell).trim());
  const text = (value: string): Node => ({ type: "text", value });
  const caption = (of: string[]): Node[] => {
    const named = of.filter(Boolean);
    // An unlabelled header — `| | Suhu |`, which a model writes when the first column is the row's
    // name — gets no caption rather than a stray separator.
    return named.length > 0 ? [{ type: "bold", children: [text(named.join(" · "))] }] : [];
  };

  // A header and a delimiter and nothing else. Rare, but it is what a truncated reply produces, and
  // the header is the only content there is — so all of it goes in the caption, since no row is
  // coming to render any of it inline.
  if (table.rows.length === 0) return caption(labels);

  const twoColumn = labels.length <= 2;
  const out = twoColumn ? caption(labels) : [];
  if (out.length > 0) out.push(text("\n\n"));

  for (const [index, row] of table.rows.entries()) {
    // A blank line between records once they are more than one line tall, so the eye can find the
    // boundary. One line each needs no separator beyond the line itself.
    if (index > 0) out.push(text(twoColumn ? "\n" : "\n\n"));

    const [first, ...rest] = row;
    out.push(asHeading(first ?? []));

    if (twoColumn) {
      const value = rest[0];
      if (value && toPlainText(value).trim() !== "") out.push(text(": "), ...value);
      continue;
    }

    for (const [column, cell] of rest.entries()) {
      // An empty cell is skipped rather than rendered as `Label:` with nothing after it. A model
      // filling a grid writes plenty of them, and each one is a line that says nothing.
      if (toPlainText(cell).trim() === "") continue;
      const label = labels[column + 1] ?? "";
      out.push(text(`\n${label ? `${label}: ` : ""}`), ...cell);
    }
  }

  return out;
}

/**
 * A cell as a record heading — bold, but only once.
 *
 * Models bold the first column of a table constantly, and wrapping a cell that is already a single
 * bold node produced `**Nama**` on WhatsApp: the marks doubled, so the phone drew the asterisks
 * instead of the emphasis. Telegram survived it as a harmless nested `<b>`, which is why it had to be
 * caught on the platform where it shows.
 */
function asHeading(cell: Node[]): Node {
  const only = cell.length === 1 ? cell[0] : undefined;
  return only?.type === "bold" ? only : { type: "bold", children: cell };
}

/**
 * A link target worth emitting, or null.
 *
 * Shared because the reasoning is not Telegram's. This text comes from a model that has been reading
 * web pages, and a `javascript:` href it copied out of one is inert in the client we happen to know
 * about — which is not the same as safe, because the renderer on the other end is not ours. A caller
 * that has a scheme of its own adds it; `tg:` is Telegram's.
 */
export function safeHref(raw: string, allow: string[] = ["http:", "https:"]): string | null {
  try {
    return allow.includes(new URL(raw).protocol) ? raw : null;
  } catch {
    return null;
  }
}
