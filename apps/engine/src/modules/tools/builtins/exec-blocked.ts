/**
 * The operator's veto list for `exec`: `blocked = ["rm -rf", "curl"]`.
 *
 * Its own file because it is its own question — "does this argv match a pattern somebody refused" —
 * and it has nothing to do with running anything. `exec.ts` decides and runs; this only matches.
 */

/**
 * Match `argv` against the operator's veto list.
 *
 * Two independent tests, and a pattern that trips either one blocks the command:
 *
 * 1. **Structural** — the pattern is read the way a shell reads a command: a program, then flags and
 *    operands. `"rm -rf"` blocks `["/usr/bin/rm", "-r", "-f"]` and `["rm", "-fr", "x"]`, because the
 *    program is matched by basename and short flags are compared as a *set of letters* rather than as
 *    the string the caller happened to spell them with. That family of rewrites — absolute path,
 *    split cluster, reordered flags, an extra argument in between — was the documented hole: every one
 *    of them produced a different `argv.join(" ")` and walked straight past the substring check.
 *
 * 2. **Substring on the joined argv** — the old rule, kept. It is the only thing that catches a
 *    blocked command smuggled inside another program's argument (`["bash", "-c", "rm -rf /"]`),
 *    where the structure says `bash` and the danger is in a string the shell will re-parse. Dropping
 *    it in the name of precision would have traded one bypass for a worse one.
 *
 * So the check only ever got stricter. A pattern that blocked something before still blocks it.
 */
export function findBlocked(argv: string[], blocked: string[]): string | null {
  if (blocked.length === 0) return null;
  const joined = argv.join(" ");
  const shape = commandShape(argv);
  return blocked.find((pattern) => joined.includes(pattern) || matchesShape(shape, pattern)) ?? null;
}

interface CommandShape {
  /** `argv[0]` and its basename, so `/usr/bin/rm` answers to `rm`. */
  program: string[];
  /** Every short flag letter, clusters expanded: `-fr` contributes `f` and `r`. */
  shortFlags: Set<string>;
  /** Long flag names without their value: `--force=yes` contributes `--force`. */
  longFlags: Set<string>;
  /** Everything after `argv[0]`, verbatim — operands and flags alike. */
  rest: Set<string>;
}

function commandShape(argv: string[]): CommandShape {
  const first = argv[0] ?? "";
  const shape: CommandShape = {
    program: [first, first.split("/").pop() ?? ""],
    shortFlags: new Set(),
    longFlags: new Set(),
    rest: new Set(argv.slice(1)),
  };

  for (const token of argv.slice(1)) {
    if (token.startsWith("--")) {
      shape.longFlags.add(token.split("=")[0] ?? token);
    } else if (/^-[A-Za-z0-9]+$/.test(token)) {
      for (const letter of token.slice(1)) shape.shortFlags.add(letter);
    }
  }
  return shape;
}

function matchesShape(shape: CommandShape, pattern: string): boolean {
  const tokens = pattern.trim().split(/\s+/).filter(Boolean);
  const [head, ...tail] = tokens;
  if (!head) return false;
  if (!shape.program.includes(head)) return false;
  // A bare program name blocks the program outright — `blocked = ["curl"]` means no curl, whatever
  // the arguments are.
  return tail.every((token) => satisfies(shape, token));
}

function satisfies(shape: CommandShape, token: string): boolean {
  if (token.startsWith("--")) {
    // A pattern that names a value (`--force=yes`) means that exact pairing; one that does not
    // (`--force`) means the flag however it was written.
    return token.includes("=") ? shape.rest.has(token) : shape.longFlags.has(token);
  }
  if (/^-[A-Za-z0-9]+$/.test(token)) {
    return [...token.slice(1)].every((letter) => shape.shortFlags.has(letter));
  }
  // An operand — a subcommand (`git push`) or a path. Exact, because the substring pass above
  // already covers the fuzzy reading and doing it twice would make `blocked = ["rm /"]` refuse
  // every absolute path anyone ever passes to anything.
  return shape.rest.has(token);
}
