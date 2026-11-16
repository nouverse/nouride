/**
 * HTML an agent wrote straight into its reply, with no code block around it: whether a part of a reply is one run of
 * it. The preview serves such a run as it serves an `html` block (`routes/preview.ts`).
 *
 * A run begins as a block of HTML does in Markdown: at a line that starts with an opening tag of a block's kind or
 * with `<!doctype`, or that is one opening tag and nothing else. A sentence that starts with `<b>`, a link written
 * `<https://..>`, a placeholder like `<your-name>` and a closing tag alone begin none. It goes on to the first blank
 * line, and past one where the next line is markup again or a `<script>`, `<style>`, `<pre>` or `<textarea>` is still
 * open. A fence ends it.
 *
 * The dashboard draws a run by the same rule, written there again since it shares no code with the daemon
 * (`commons/lib/html-run.ts`). A test holds the two to the same answers, and this one decides what is served.
 */

/** The tags that begin a block of HTML whatever follows them on the line: CommonMark's, with the four of raw text. */
const BLOCK_TAGS =
  "address|article|aside|base|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul";
/** The tags that begin one only alone on their line: named, so that a placeholder in angle brackets is not markup. */
const ALONE_TAGS = "a|abbr|audio|b|br|button|canvas|cite|code|em|font|i|img|input|kbd|label|mark|picture|q|s|select|small|span|strong|sub|sup|svg|time|u|video";

const OPENS_BLOCK = new RegExp(`^ {0,3}<(?:(?:${BLOCK_TAGS})(?=[\\s/>]|$)|!doctype\\b)`, "i");
const OPENS_ALONE = new RegExp(`^ {0,3}<(?:${ALONE_TAGS})(?:\\s[^<>]*)?/?>\\s*$`, "i");
/** A line that is markup again, after a blank one: any tag, a closing one and a comment too. */
const MARKUP = /^\s*<(?:\/?[a-z]|!doctype\b|!--)/i;
/** A fence, as the dashboard reads one. */
const FENCE = /^\s*```/;
/** What holds text as it is written, blank lines too, until it is closed. */
const RAW_TEXT = ["script", "style", "pre", "textarea"] as const;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** How many raw-text elements and comments a line leaves open, or closes (negative). */
function leftOpen(line: string): number {
  let open = count(line, /<!--/g) - count(line, /-->/g);
  for (const tag of RAW_TEXT) open += count(line, new RegExp(`<${tag}(?=[\\s>])`, "gi")) - count(line, new RegExp(`</${tag}\\s*>`, "gi"));
  return open;
}

/** Whether a line begins a run of HTML. */
function opensHtmlRun(line: string): boolean {
  return OPENS_BLOCK.test(line) || OPENS_ALONE.test(line);
}

/** The last line of the run that begins at `start`. */
function htmlRunEnd(lines: readonly string[], start: number): number {
  let end = start;
  let open = leftOpen(lines[start] ?? "");
  for (let at = start + 1; at < lines.length; at++) {
    const line = lines[at]!;
    if (FENCE.test(line)) break;
    if (line.trim() === "") {
      if (open > 0) continue;
      let next = at + 1;
      while (next < lines.length && lines[next]!.trim() === "") next++;
      if (next >= lines.length || FENCE.test(lines[next]!) || !MARKUP.test(lines[next]!)) break;
      continue;
    }
    open += leftOpen(line);
    end = at;
  }
  return end;
}

/**
 * Whether `length` characters of `source` from `at` are one run of HTML, whole lines of it, outside any code block.
 */
export function isHtmlRun(source: string, at: number, length: number): boolean {
  if (!Number.isInteger(at) || !Number.isInteger(length) || at < 0 || length <= 0 || at + length > source.length) return false;
  if ((at > 0 && source[at - 1] !== "\n") || (at + length < source.length && source[at + length] !== "\n")) return false;
  // Not inside a code block: every fence before it is closed by the next.
  if (source.slice(0, at).split("\n").filter((line) => FENCE.test(line)).length % 2 === 1) return false;
  const lines = source.slice(at, at + length).split("\n");
  return opensHtmlRun(lines[0]!) && htmlRunEnd(lines, 0) === lines.length - 1;
}
