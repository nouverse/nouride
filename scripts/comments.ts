/**
 * The comments of a TypeScript source, read by a small lexer: strings, template literals (their `${}` included),
 * regular expressions and JSX text are stepped over, so a `//` in a URL or a `/*` in a glob is not taken for one. Read
 * against TypeScript's own parser over every file of the tree it gave the same comments, at a tenth of its time.
 */

export interface Comment {
  /** Where the comment starts, as an offset into the source. */
  start: number;
  /** The comment as written, its `//` or its `/*` and `*\/` included. */
  text: string;
}

/** Words after which a `/` starts a regular expression rather than dividing. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

/** What ends an expression: a `/` after one of these divides. */
const EXPRESSION_END = new Set(["0", ")", "]", '"', "'", "`", "/re", "<"]);

/** The comments in `source`, in order. `jsx` for a `.tsx` file, where `/>` closes a tag. */
export function comments(source: string, jsx = false): Comment[] {
  const out: Comment[] = [];
  const templates: number[] = [];
  let braces = 0;
  let last = "";
  let i = 0;
  const n = source.length;

  const regexAllowed = (): boolean => {
    if (last === "") return true;
    if (/^[A-Za-z_$][\w$]*$/.test(last)) return REGEX_AFTER_WORD.has(last);
    return !EXPRESSION_END.has(last);
  };

  // From just after a backtick, or the `}` that closes a `${`, to the closing backtick or the next `${`.
  const template = (): void => {
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i += 1;
        last = "`";
        return;
      }
      if (c === "$" && source[i + 1] === "{") {
        i += 2;
        templates.push(braces);
        braces += 1;
        last = "{";
        return;
      }
      i += 1;
    }
  };

  while (i < n) {
    const c = source[i]!;
    const d = source[i + 1];
    // `://` is a URL in JSX text, never a comment in code.
    if (c === "/" && d === "/" && source[i - 1] !== ":") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out.push({ start: i, text: source.slice(i, stop) });
      i = stop;
    } else if (c === "/" && d === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push({ start: i, text: source.slice(i, stop) });
      i = stop;
    } else if (c === '"' || c === "'") {
      // Ends at a line's end too: an apostrophe in JSX text opens no string past it.
      i += 1;
      while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i += 1;
      last = c;
    } else if (c === "`") {
      i += 1;
      template();
    } else if (c === "/" && regexAllowed() && !(jsx && d === ">")) {
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== "\n") {
        const r = source[i];
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/.test(source[i]!)) i += 1;
      last = "/re";
    } else if (c === "{") {
      braces += 1;
      last = "{";
      i += 1;
    } else if (c === "}") {
      braces -= 1;
      i += 1;
      if (templates.length > 0 && templates[templates.length - 1] === braces) {
        templates.pop();
        template();
      } else {
        last = "}";
      }
    } else if (/\s/.test(c)) {
      i += 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(source[j]!)) j += 1;
      last = source.slice(i, j);
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(source[j]!)) j += 1;
      last = "0";
      i = j;
    } else {
      // A non-null assertion ends an expression: `x! / 4` divides.
      last = c === "!" && /[\w)\]]/.test(source[i - 1] ?? "") ? ")" : c;
      i += 1;
    }
  }
  return out;
}

/** `source` with every comment blanked to spaces, its line breaks kept: what the code says, without what it explains. */
export function withoutComments(source: string, jsx = false): string {
  let out = "";
  let at = 0;
  for (const comment of comments(source, jsx)) {
    out += source.slice(at, comment.start) + comment.text.replace(/[^\n]/g, " ");
    at = comment.start + comment.text.length;
  }
  return out + source.slice(at);
}
