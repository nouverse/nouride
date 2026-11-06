/**
 * The programs a shell script runs, read conservatively enough to base an **allow** decision on.
 *
 * `exec` now runs a command string through `bash -lc`, so `git add -A && git commit -m "x"` arrives
 * as `["bash", "-lc", "..."]`. Matching the allowlist on `argv[0]` alone would make every chain ask
 * — which is the incentive that pushed models into one git command per turn. So when every segment
 * of the script runs an allowlisted program, the script counts as allowlisted.
 *
 * That is only safe if this reader never sees fewer programs than bash does. `hardline.ts` has a
 * looser splitter, and that is fine there because it only ever adds reasons to ask. Here a miss
 * would auto-run something, so anything this does not fully understand returns `null` and the
 * caller falls back to the ordinary path: command substitution, backticks, parameter expansion,
 * subshells and groups, redirects other than to a descriptor or `/dev/null`, backgrounding,
 * comments, heredocs, and programs that run other programs.
 */

/** Programs that run their arguments as another command, so the segment's real program is hidden. */
const INDIRECT = new Set([
  "eval",
  "exec",
  "source",
  ".",
  "command",
  "builtin",
  "env",
  "xargs",
  "nohup",
  "time",
  "timeout",
  "nice",
  "sudo",
  "doas",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
]);

const SAFE_REDIRECT = /^(?:[0-2]?>>?|&>)(?:&[0-2]|\s*\/dev\/null)(?![^\s;&|])/;
const PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9_.+-]+)*$|^\/[A-Za-z0-9_.+/-]+$/;

/** `$NAME` or `${NAME}` at `at`, and nothing more elaborate: its length, or 0. */
function plainExpansion(script: string, at: number): number {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(script.slice(at))?.[0].length ?? 0;
}

/**
 * Each segment's words, or `null` if the script uses anything this reader does not model.
 *
 * Quotes are honoured, so `git commit -m "a && b"` is one segment. Only a segment's first word is
 * used by the caller; the rest are kept because a test reads better with them.
 *
 * `expansions` lets a plain `$NAME` or `${NAME}` through as a word's text — never in a program's place, which
 * stays a literal name. For deciding which secrets a command receives (`exec-secrets.ts`), where the command that
 * needs one names it: `twine upload -p "$PYPI_TOKEN"`. Never for an allow decision, which reads only literals.
 * A substitution, `$(…)` or a backtick, still ends the reading: it runs a command of its own.
 */
export function scriptSegments(script: string, options: { expansions?: boolean } = {}): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  // Set after `&&`, `||` or `|`: a script that ends there is not one bash would run.
  let pendingOperator = false;

  const endWord = () => {
    if (inWord) {
      words.push(word);
      pendingOperator = false;
    }
    word = "";
    inWord = false;
  };
  const endSegment = (): boolean => {
    endWord();
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;

    if (ch === "'") {
      const close = script.indexOf("'", i + 1);
      if (close === -1) return null;
      word += script.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j++) {
        const c = script[j]!;
        const expansion = c === "$" && options.expansions ? plainExpansion(script, j) : 0;
        if (expansion > 0) {
          word += script.slice(j, j + expansion);
          j += expansion - 1;
          continue;
        }
        if (c === "$" || c === "`") return null;
        if (c === "\\") {
          j++;
          if (j >= script.length) return null;
          word += script[j];
          continue;
        }
        word += c;
      }
      if (j >= script.length) return null;
      inWord = true;
      i = j;
      continue;
    }
    if (ch === "\\") {
      const next = script[i + 1];
      if (next === undefined) return null;
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      // An empty statement between separators is harmless; an empty one *after* `&&` is not
      // valid bash, but bash refuses it, so nothing runs either way.
      endSegment();
      continue;
    }
    if (ch === "&" || ch === "|") {
      const doubled = script[i + 1] === ch;
      if (ch === "&" && !doubled) {
        // `&>` is a redirect, handled below; a lone `&` backgrounds, which this does not model.
        if (script[i + 1] !== ">") return null;
      } else {
        if (!endSegment()) return null;
        pendingOperator = true;
        if (doubled) i++;
        continue;
      }
    }
    if (ch === ">" || ch === "<" || (ch === "&" && script[i + 1] === ">")) {
      // A descriptor prefix (`2>`) was read as the start of a word; take it back.
      const prefix = inWord && /^[0-2]$/.test(word) ? word : "";
      if (inWord && !prefix) return null;
      const match = SAFE_REDIRECT.exec(prefix + script.slice(i));
      if (!match) return null;
      word = "";
      inWord = false;
      i += match[0].length - prefix.length - 1;
      continue;
    }
    const expansion = ch === "$" && options.expansions ? plainExpansion(script, i) : 0;
    if (expansion > 0) {
      word += script.slice(i, i + expansion);
      inWord = true;
      pendingOperator = false;
      i += expansion - 1;
      continue;
    }
    if ("$`(){}#".includes(ch)) return null;
    word += ch;
    inWord = true;
    pendingOperator = false;
  }
  endSegment();
  if (pendingOperator) return null;

  if (segments.length === 0) return null;
  for (const segment of segments) {
    const program = segment[0]!;
    // An assignment prefix (`FOO=1 git ...`) or a glob in the program name: not a literal program.
    if (!PROGRAM.test(program)) return null;
    if (INDIRECT.has(programName(program))) return null;
  }
  return segments;
}

const LAUNCHERS = new Set(["sh", "bash", "zsh", "dash"]);
const SCRIPT_FLAGS = new Set(["-c", "-lc", "-cl"]);

/**
 * A program as every rule here names it: the last part of its path, whichever separator wrote it.
 *
 * One function, because there were three — the hardline classes and the allowlist read `C:\tools\rm` as `rm` and
 * a secret's binding did not — and a security package that names a program one way for one rule and another way for
 * the next is a package whose rules can be walked around by spelling a path differently.
 */
export function programName(program: string): string {
  const cleaned = program.replace(/\\/g, "/");
  return cleaned.slice(cleaned.lastIndexOf("/") + 1);
}

/** The script in `["bash", "-lc", script]`, or `null` for any other shape. */
export function launchedScript(argv: readonly string[]): string | null {
  if (argv.length !== 3) return null;
  if (!LAUNCHERS.has(programName(argv[0] ?? ""))) return null;
  if (!SCRIPT_FLAGS.has(argv[1] ?? "")) return null;
  return argv[2] ?? null;
}
