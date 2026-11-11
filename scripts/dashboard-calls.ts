/**
 * Every control path the dashboard calls, read from its source as text, with the method it calls it with and the
 * answer it expects. Two contracts read the same list: `dashboard-contract.test.ts`, that each is a route the daemon
 * registers, and `plain-replies.test.ts` (0.8.20), that each such route's refusals and notes read as everyday words.
 *
 * Moved here from `dashboard-contract.test.ts` when the second reader came: two copies of how a call is read would let
 * one contract hold routes the other never saw.
 *
 * Read as text rather than imported, because importing browser code into an engine test would invert the dependency
 * the architecture rule protects.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Where the browser's half of the contract is written down: every file of the dashboard that builds a control path.
 *
 * Found, not listed. A list of six was frozen while `api.ts` was being split into `api.*.ts`, and each surface moved
 * out — memory, people, update, the Box, jobs, secrets — dropped its paths from this check: 65 of 179 calls went
 * unchecked, with every test green.
 */
export const CLIENT_FILES = (readdirSync(join(ROOT, "apps/dashboard/src"), { recursive: true }) as string[])
  .filter((file) => /\.tsx?$/.test(file) && readFileSync(join(ROOT, "apps/dashboard/src", file), "utf8").includes("${control}"))
  .map((file) => join("apps/dashboard/src", file))
  .sort();

/** One path as segments, with anything variable marked. `null` is "matches any one segment". */
export type Shape = (string | null)[];

/** A Hono path as a shape: `:id` is a parameter, everything else is literal. */
export function routeShape(path: string): Shape {
  return path
    .replace(/^\/api\/control/, "")
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (segment.startsWith(":") ? null : segment));
}

/**
 * A client template as a shape: `${…}` is a parameter, everything else is literal.
 *
 * Segment by segment rather than as a string, because the two sides are not symmetrical. The
 * dashboard writes `/access/revoke` where the daemon registers `/access/:action`, and
 * `/cron/${id}/run` where the daemon registers `/cron/:id/:action` — a literal on one side against
 * a parameter on the other, which compared as strings looks like a missing route and is not. What
 * the two sides genuinely have to agree on is the *number* of segments and every segment where both
 * are literal.
 */
function clientShape(path: string): Shape {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (segment.includes("${") ? null : segment));
}

/**
 * A parameter on either side matches anything; two literals have to be the same word. A route ending in `*` — the
 * Box's `/appliance/*`, served by a plugin — matches any path under it: dropped as unreadable, its six calls could
 * not pass.
 */
export function matches(call: Shape, route: Shape): boolean {
  const wildcard = route.at(-1) === "*";
  const fixed = wildcard ? route.slice(0, -1) : route;
  if (wildcard ? call.length < fixed.length : call.length !== fixed.length) return false;
  return fixed.every((other, index) => {
    const segment = call[index]!;
    return segment === null || other === null || segment === other;
  });
}

/**
 * The method a call is made with, read off the call around its template: `post` and `put` say it, `request` says it
 * in its options or means GET. Null where the template is not an argument of one — a URL for an `EventSource`. And
 * the answer the call declares, its type argument (`post<{ ok: true; note: string }>`), where it gives one.
 *
 * Paths alone missed half a rename: `/memory/tags/tidy` is a GET and a POST, and renaming one left the other to match.
 *
 * And whether it gives itself longer than the client's default to be answered (`timeoutMs`), for the routes that work
 * for minutes.
 */
function callAround(source: string, templateStart: number, templateEnd: number): { method: string | null; answer: string | null; patient: boolean } {
  const before = source.slice(Math.max(0, templateStart - 300), templateStart);
  const helper = /\b(request|post|put|del)(<[^()]*>)?\(\s*$/.exec(before);
  if (!helper) return { method: null, answer: null, patient: false };
  const answer = helper[2]?.slice(1, -1) ?? null;
  // The rest of its argument list, up to the parenthesis that closes it.
  let depth = 1;
  let end = templateEnd + 1;
  for (; end < source.length && depth > 0; end += 1) {
    if (source[end] === "(") depth += 1;
    else if (source[end] === ")") depth -= 1;
  }
  const rest = source.slice(templateEnd, end);
  const patient = /\btimeoutMs\b/.test(rest);
  if (helper[1] === "post") return { method: "POST", answer, patient };
  if (helper[1] === "put") return { method: "PUT", answer, patient };
  if (helper[1] === "del") return { method: "DELETE", answer, patient };
  return { method: /method:\s*"([A-Z]+)"/.exec(rest)?.[1] ?? "GET", answer, patient };
}

/**
 * Paths whose shape cannot be read from the source, with the reason.
 *
 * One entry, and it is not a gap in the check: `file.url` is a *path* the daemon itself produced
 * and handed to the browser in a turn record, so what the browser does with it is append it. The
 * contract for that one is enforced where the value is made, not here — and a test that guessed at
 * its shape would be asserting something this file cannot see.
 */
const NOT_STATIC = ["/sessions/${encodeURIComponent(sessionId)}/${file.url}"];

/** One call: its path's shape, its method (null where the source does not say), its template, file and answer. */
export interface Call {
  shape: Shape;
  method: string | null;
  raw: string;
  file: string;
  /** The answer's type as the call writes it, `{ ok: boolean; note: string }` or `UpdateInstall`; null for none. */
  answer: string | null;
  /** Whether the call says how long it waits for its answer, rather than the client's default seconds. */
  patient: boolean;
}

/**
 * Every `` `${control}/…` `` template in the dashboard's client.
 *
 * Scanned rather than matched with one regex: several of these templates contain a nested template
 * — `` `${control}/cron${all ? "?all=1" : ""}` `` — and `[^`]*` stops at the *inner* backtick, which
 * silently truncates the path into something that then fails to match. Three of the first run's
 * nine "missing" routes were that, which is the argument for tracking depth instead.
 */
export function dashboardCalls(): Call[] {
  const out: Call[] = [];

  for (const file of CLIENT_FILES) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const marker = "${control}";

    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
      const raw = readTemplate(source, at + marker.length);
      if (raw === null || NOT_STATIC.includes(raw)) continue;
      const path = pathOf(raw);
      // The template's backtick is just before the marker; its closing one ends `raw`.
      const { method, answer, patient } = callAround(source, at - 1, at + marker.length + raw.length);
      out.push({ shape: clientShape(path), method, raw, file, answer, patient });
    }
  }

  return out;
}

/**
 * A call's path, without its query: a query string is not part of the path, and neither is a value that only ever
 * makes one, `${all ? "?all=1" : ""}`, a suffix on the last segment rather than a segment. Read by depth, not by a
 * regex: `${query ? `?${query}` : ""}` holds a template of its own, and a regex cut it at its own `?` and its inner `}`,
 * which left the path one segment of anything. `GET /sessions…` then matched every route of one segment, `/web-search`
 * among them, and would have matched still had `/sessions` been renamed.
 */
function pathOf(raw: string): string {
  let path = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "?") break;
    if (raw[i] !== "$" || raw[i + 1] !== "{") {
      path += raw[i];
      continue;
    }
    let depth = 0;
    let end = i;
    for (; end < raw.length; end += 1) {
      if (raw[end] === "{") depth += 1;
      else if (raw[end] === "}" && (depth -= 1) === 0) break;
    }
    const value = raw.slice(i, end + 1);
    // A value that makes a query: one of its branches is text that starts with one.
    if (!/[`"']\?/.test(value)) path += value;
    i = end;
  }
  return path;
}

/**
 * The rest of one template literal, from `from` to its closing backtick.
 *
 * Tracks `${…}` depth so a nested template inside an interpolation does not end the scan early,
 * which is the whole reason this is not a regex.
 */
function readTemplate(source: string, from: number): string | null {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "$" && source[i + 1] === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (char === "`" && depth === 0) return source.slice(from, i);
  }
  return null;
}

/**
 * Whether an answer, as a call declares it, has words of the server's own at its top, a `note` or an `error` (a test
 * that failed, answered as a success): written inline (`{ ok: boolean; note: string }`), or a type of that name declared
 * in the dashboard's client files. The page shows them from a success, so the route's have to read as everyday words
 * like its refusals.
 */
export function answersWithWords(answer: string | null): boolean {
  if (!answer) return false;
  const trimmed = answer.trim();
  const words = (keys: string[]) => keys.includes("note") || keys.includes("error");
  if (trimmed.startsWith("{")) return words(topLevelKeys(trimmed));
  const name = /^[A-Za-z_]\w*$/.exec(trimmed)?.[0];
  if (!name) return false;
  for (const file of CLIENT_FILES) {
    // Without comments, whose prose holds braces of its own: "answers `{ error, note }`".
    const source = readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const declared = new RegExp(`(?:interface\\s+${name}\\b[^{]*|type\\s+${name}\\s*=\\s*)\\{`).exec(source);
    if (declared) return words(topLevelKeys(source.slice(declared.index + declared[0].length - 1)));
  }
  return false;
}

/** The keys of the object type that starts at `text[0]`, `{`, at its own depth only. */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let start = true;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    // A function type's arrow is no bracket.
    if (char === ">" && text[i - 1] === "=") continue;
    if (char === "{" || char === "(" || char === "[" || char === "<") depth += 1;
    else if (char === "}" || char === ")" || char === "]" || char === ">") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && (char === ";" || char === "," || char === "\n")) start = true;
    else if (depth === 1 && start && /[A-Za-z_]/.test(char)) {
      const key = /^(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/.exec(text.slice(i));
      if (key) keys.push(key[1]!);
      start = false;
    }
  }
  return keys;
}
