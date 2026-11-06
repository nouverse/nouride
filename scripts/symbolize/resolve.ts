/**
 * A mangled frame — `/$bunfs/root/nouride:41:6983` from a binary, `/app/nouride.bundle.js:41:6983` from an image —
 * back to the source it was built from.
 *
 * Pure: the map comes in as JSON and the answers go out as values, so the CLI (`scripts/symbolize.ts`) and the
 * tests share every step, and the same input gives the same output on any machine. Bun writes its maps with an
 * empty `names`, so a frame's function is not read from the map: it is the function whose body encloses the
 * mapped position in the original source, found with the TypeScript parser over the map's `sourcesContent`.
 */

import ts from "typescript";
import { decodeVlq, type RawSourceMap } from "../build/source-map.ts";

/** One frame as it appears in a stack trace from a release build. Line and column are Bun's: 1-based. */
export interface Frame {
  /** The name the minified code printed — `Rie`, or `null` for an anonymous frame. Means nothing on its own. */
  printed: string | null;
  line: number;
  column: number;
  /**
   * What ran: a compiled binary (`/$bunfs/root/nouride:…`) or a Docker image's bundle (`/app/nouride.bundle.js:…`).
   * The two are different code with different maps, so a frame is only read against a map of its own kind.
   */
  kind: "binary" | "image";
}

/** Where a frame came from. Line and column are 1-based, as an editor counts them. */
export interface Resolved {
  source: string;
  line: number;
  column: number;
  /** `parseGatewayInstance`, `SecretStore.open`, `<anonymous> in boot`, `<module>`. */
  function: string;
  /** The original line, trimmed — what the frame was doing. */
  text: string;
}

/**
 * Every frame in `input`, in order: a plain stack, a journal line or `docker logs` line whose stack is a JSON string
 * with `\n` escapes, or a whole excerpt of them. Only frames in a release build — a compiled binary's
 * (`/$bunfs/root/…`) or an image's bundle (`…/nouride.bundle.js`, which is `/app/nouride.bundle.js` in the image);
 * anything else has its own file name already and nothing to resolve.
 */
export function parseFrames(input: string): Frame[] {
  const frames: Frame[] = [];
  const pattern =
    /(?:\bat\s+(?:async\s+)?(?:([^\s()\\"]+)(?:\s\[as [^\]]+\])?\s+\()?)?(?:file:\/\/)?(\/\$bunfs\/root\/[\w.@-]+|(?:[^\s()"'\\:]*\/)?nouride\.bundle\.js):(\d+):(\d+)/g;
  for (const m of input.matchAll(pattern)) {
    const kind = m[2]!.startsWith("/$bunfs/") ? "binary" : "image";
    frames.push({ printed: m[1] ?? null, line: Number(m[3]), column: Number(m[4]), kind });
  }
  return frames;
}

/**
 * Error names in `input` — the `ConfigError` of `ConfigError: [memory] dir…`. They survive a release build because
 * every error class names itself with a literal (`error-names.test.ts`), so they are worth printing beside the
 * frames: the name says which class threw, before any frame is read.
 */
export function errorNames(input: string): string[] {
  const names = new Set<string>();
  for (const m of input.replace(/\\n/g, "\n").matchAll(/(?:^|[\s"'(])([A-Z][A-Za-z0-9]*(?:Error|Exception|Refusal|Refused|Unavailable|Exit)|Error):\s/gm)) {
    names.add(m[1]!);
  }
  return [...names];
}

/** A map, decoded once: for each generated line, its segments as absolute positions. */
export interface DecodedMap {
  sources: string[];
  sourcesContent: (string | null)[];
  /** `lines[n]` is generated line n+1: `[generatedColumn, sourceIndex, originalLine, originalColumn]`, 0-based. */
  lines: number[][][];
}

export function decodeMap(map: RawSourceMap): DecodedMap {
  const lines: number[][][] = [];
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const encoded of map.mappings.split(";")) {
    const segments: number[][] = [];
    let column = 0;
    for (const segment of encoded.split(",")) {
      if (!segment) continue;
      const v = decodeVlq(segment);
      column += v[0]!;
      if (v.length < 4) continue; // a segment that maps to no source
      source += v[1]!;
      originalLine += v[2]!;
      originalColumn += v[3]!;
      segments.push([column, source, originalLine, originalColumn]);
    }
    lines.push(segments);
  }
  return { sources: map.sources, sourcesContent: map.sourcesContent ?? [], lines };
}

/**
 * The source position of one frame: the last mapping on its line at or before its column.
 *
 * JavaScriptCore's columns are 1-based and a map's are 0-based, so `column - 1` is looked up. `null` when the map
 * has nothing on that line before that column — a frame in code the map does not cover, which is said rather than
 * guessed at from a neighbouring line.
 */
export function lookup(map: DecodedMap, frame: Frame): { source: number; line: number; column: number } | null {
  const segments = map.lines[frame.line - 1];
  if (!segments) return null;
  let best: number[] | null = null;
  for (const segment of segments) {
    if (segment[0]! > frame.column - 1) break;
    best = segment;
  }
  return best ? { source: best[1]!, line: best[2]!, column: best[3]! } : null;
}

const parsed = new Map<string, ts.SourceFile>();

function sourceFile(name: string, text: string): ts.SourceFile {
  const key = `${name}\0${text.length}`;
  let file = parsed.get(key);
  if (!file) {
    const kind = /\.tsx$/.test(name) ? ts.ScriptKind.TSX : /\.jsx?$|\.[cm]js$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
    parsed.set(key, file);
  }
  return file;
}

type FunctionLike = ts.SignatureDeclaration & { body?: ts.Node };

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function nameText(name: ts.Node | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** The class a member belongs to, by name, for `Class.member`. */
function owner(node: ts.Node): string | null {
  const parent = node.parent;
  if (parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))) return parent.name?.text ?? "<class>";
  return null;
}

/** What one function is called, from its own declaration or what it is assigned to; `null` when nothing names it. */
function functionName(node: FunctionLike): string | null {
  if (ts.isConstructorDeclaration(node)) return `${owner(node) ?? "<class>"}.constructor`;
  const own = nameText(node.name);
  if (own) {
    const cls = owner(node);
    const prefix = ts.isGetAccessorDeclaration(node) ? "get " : ts.isSetAccessorDeclaration(node) ? "set " : "";
    return cls ? `${cls}.${prefix}${own}` : own;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return nameText(parent.name);
  if (ts.isPropertyDeclaration(parent)) {
    const prop = nameText(parent.name);
    const cls = owner(parent);
    return prop && cls ? `${cls}.${prop}` : prop;
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return parent.left.getText().replace(/\s+/g, "");
  }
  return null;
}

/**
 * The function enclosing `line:column` (0-based) in `text`: the innermost one, named as a reader would name it.
 *
 * An anonymous callback is named by where it sits — `<anonymous> in loadConfig` — because "anonymous" alone sends
 * the reader to search the whole file. `<module>` for code at the top level.
 */
export function enclosingFunction(name: string, text: string, line: number, column: number): string {
  const file = sourceFile(name, text);
  const lineStarts = file.getLineStarts();
  if (line >= lineStarts.length) return "<unknown>";
  const position = lineStarts[line]! + column;
  const chain: FunctionLike[] = [];
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(file) || position >= node.getEnd()) return;
    if (isFunctionLike(node)) chain.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (chain.length === 0) return "<module>";
  const innermost = chain[chain.length - 1]!;
  const own = functionName(innermost);
  if (own) return own;
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    const outer = functionName(chain[i]!);
    if (outer) return `<anonymous> in ${outer}`;
  }
  return "<anonymous>";
}

/** One frame, all the way back to its source — or `null` when the map does not cover it. */
export function resolveFrame(map: DecodedMap, frame: Frame): Resolved | null {
  const at = lookup(map, frame);
  if (!at) return null;
  const source = map.sources[at.source] ?? "<unknown source>";
  const text = map.sourcesContent[at.source];
  if (typeof text !== "string") {
    return { source, line: at.line + 1, column: at.column + 1, function: "<no source in map>", text: "" };
  }
  return {
    source,
    line: at.line + 1,
    column: at.column + 1,
    function: enclosingFunction(source, text, at.line, at.column),
    text: (text.split("\n")[at.line] ?? "").trim().slice(0, 160),
  };
}
