#!/usr/bin/env bun
/**
 * Every refusal and note the control routes answer with, and the route that answers it (0.8.20, "the server's messages
 * in everyday words"). The CLI and the dashboard read the same replies, `{ error, note? }`: the CLI prints them, and the
 * dashboard showed them as they were to people who are not technical (the owner, 2026-11-05), a section of the config
 * file, a flag or a `git` word and all. A reply written for the command line carries a third field, `plain`: what
 * happened and what the person can do, in the dashboard's words. The dashboard shows it, the route's own words under
 * Details, and the CLI prints what it always did.
 *
 *   bun run scripts/route-words.ts               every reply on a route the dashboard calls: the route, the words
 *   bun run scripts/route-words.ts --technical   only those `plain-replies.test.ts` refuses, and why
 *
 * Read by the TypeScript parser, as `dashboard-words.ts` reads the dashboard: each `control.<method>(path, handler)` in
 * `web/control/routes`, each `c.json(body, status)` its handler answers with (the functions of its own file it calls
 * included), and the `error`, `note` and `plain` of each body; the guard's replies answer every route. What a value
 * holds is followed inside the file (`route-values.ts`): a const, what a function of the file returns, an element of a
 * tuple, a field of an object it returns or an entry of a table it looks up, either side of `?:`, `||` and `??`, the
 * right of `&&`, and a parameter of a function, by the argument the call followed passes (else every call of its file):
 * the words a route hands `notSaved` are read in the sentence it makes. What comes from another file, a domain's
 * refusal or an exception's message, is
 * words this cannot read: such a reply carries a `plain`, worded at the route from what the domain returned (its kind
 * and its data), never parsed out of its sentence. Each body a reply can answer with is held on its own, and a word
 * passes with a `plain` beside it, in its object or one it is spread into.
 *
 * In a template, a value is data, an id, a name or a count standing as `{}`, unless it is words: a text this reads, or
 * one it cannot: a caught error, a call that makes words in another file (`String(err)`, `reason(err)`), or a field
 * named for a sentence (`message`, `refused`, `reason`, `note`, `tokenError`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { answersWithWords, dashboardCalls, matches, routeShape, type Call } from "./dashboard-calls.ts";
import { CONTROL, declarationOf, functionOf, isNoText, isText, propertyName, unwrap, values, valuesBound, type Bound } from "./route-values.ts";
import { technical } from "./dashboard-words.ts";

const ROOT = join(import.meta.dir, "..");

/** The middleware every control route passes, whose replies answer any of them. */
const EVERY_ROUTE = new Set(["guard.ts"]);

/** One text a reply carries: its words, `{}` where a value goes, and what in it this could not read. */
export interface Said {
  text: string;
  line: number;
  /** Words written in another file: a domain's refusal, an exception's message. */
  unread: string[];
}

/** One body a reply can answer with, and the words in it. */
export interface Body {
  error: Said[];
  note: Said[];
  plain: Said[];
  /** Every word in it has a `plain` beside it: in its own object, or one it is spread into. */
  plainAlways: boolean;
  /** The body, or a spread in it, written in another file: what it holds cannot be read here. */
  unread: string[];
  /** Its words with no `plain` beside them, which the page shows as they are. */
  bare: { field: "error" | "note"; said: Said }[];
  bareUnread: string[];
}

/**
 * One `c.json(…)` a route answers with: each body it can answer with (`c.json(ok ? a : b)` has two, each held on its
 * own), and every body's words together, as a person reading the route would list them.
 */
export interface Reply extends Omit<Body, "plainAlways" | "bare" | "bareUnread"> {
  file: string;
  line: number;
  /** The route, as it is registered: `POST` and `/memory/embed`; `*` and `*` for the guard's, which answer any. */
  method: string;
  path: string;
  /** The statuses this file says it answers with; null where one is not a number written in it. */
  status: number[] | null;
  bodies: Body[];
  /** Every body that holds words carries a `plain` whatever happens. */
  plainAlways: boolean;
}

/** A name that holds a sentence rather than data; `what`, the words a helper names a field by (`notSaved`). */
const SENTENCE = /^(?:e|err|error|errors|message|refused|refusal|reason|note|why|notice|hint|said|problem|failure|cause|detail|what)$|(?:Error|Message|Reason|Note|Refusal|Notice)$/;

/** Calls that make data of data: a list joined, a number written out, a value trimmed. */
const DATA_METHODS = new Set(["join", "toString", "toFixed", "trim", "slice", "toLowerCase", "toUpperCase", "toISOString", "padStart", "padEnd"]);
const DATA_FUNCTIONS = new Set(["String", "Number", "encodeURIComponent", "JSON.stringify", "Math.round", "Math.ceil", "Math.floor", "Math.max", "Math.min"]);

const lineOf = (node: ts.Node): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

/** The words a field can hold: each text it can be, and what in each this could not read. */
function textsOf(node: ts.Expression, bound?: Bound): Said[] {
  return valuesBound(node, bound).flatMap(({ node: value, bound: under }): Said[] => {
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return [{ text: value.text, line: lineOf(value), unread: [] }];
    if (ts.isTemplateExpression(value)) return template(value, under);
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) return joined(value, under);
    if (isNoText(value)) return [];
    return [{ text: "", line: lineOf(value), unread: [value.getText()] }];
  });
}

/** A sentence written in pieces, `"a " + "b"`: one text where each side is one, else each side's. */
function joined(node: ts.BinaryExpression, bound: Bound): Said[] {
  const left = textsOf(node.left, bound);
  const right = textsOf(node.right, bound);
  if (left.length !== 1 || right.length !== 1) return [...left, ...right];
  return [{ text: left[0]!.text + right[0]!.text, line: lineOf(node), unread: [...left[0]!.unread, ...right[0]!.unread] }];
}

/**
 * A template's words, a value as `{}`; the words a value holds, read or not, beside them. A value is read by what the
 * parameters of the function the template came out of stand for at the call it was reached through.
 */
function template(node: ts.TemplateExpression, bound: Bound): Said[] {
  const inside: Said[] = [];
  let text = node.head.text;
  for (const span of node.templateSpans) {
    const handed = handedWords(span.expression, bound);
    for (const { node: value, bound: under } of valuesBound(span.expression, bound)) {
      if (isText(value)) inside.push(...textsOf(value, under));
      else if (handed || !isData(value)) inside.push({ text: "", line: lineOf(value), unread: [value.getText()] });
    }
    text += `{}${span.literal.text}`;
  }
  const unread = inside.filter((said) => said.text === "").flatMap((said) => said.unread);
  return [{ text, line: lineOf(node), unread }, ...inside.filter((said) => said.text !== "")];
}

/**
 * A parameter named for a sentence, handed its words by the call this followed (`notSaved`'s `what`): whatever the
 * caller passed has to be words this reads. A name or a count it passed would otherwise stand as data, unread, in a
 * sentence the page shows.
 */
function handedWords(expression: ts.Expression, bound: Bound): boolean {
  const at = unwrap(expression);
  if (!ts.isIdentifier(at) || !SENTENCE.test(at.text)) return false;
  const declaration = declarationOf(at.text, at);
  return declaration !== undefined && ts.isParameter(declaration) && bound.has(declaration);
}

/** A value that is data, an id or a name or a count, rather than words. */
function isData(node: ts.Expression): boolean {
  const at = unwrap(node);
  // A literal inside a value is a fallback of that value (`(name ?? "").trim()`): where it stands alone, it is read.
  if (isNoText(at) || ts.isElementAccessExpression(at) || ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at)) return true;
  if (ts.isPrefixUnaryExpression(at)) return isData(at.operand);
  if (ts.isBinaryExpression(at)) return isData(at.left) && isData(at.right);
  if (ts.isIdentifier(at)) return !SENTENCE.test(at.text);
  if (ts.isPropertyAccessExpression(at)) return !SENTENCE.test(at.name.text);
  if (ts.isCallExpression(at)) {
    const callee = at.expression.getText();
    if (/\breq\.(?:param|query|header)$/.test(callee)) return true;
    if (DATA_FUNCTIONS.has(callee)) return at.arguments.every((argument) => isData(argument));
    if (ts.isPropertyAccessExpression(at.expression) && DATA_METHODS.has(at.expression.name.text)) return isData(at.expression.expression);
  }
  return false;
}

/**
 * The fields of one body, through spreads: its `error`, `note` and `plain`, and which of its words have no `plain` beside
 * them: in the same object, or one it is spread into (`covered`). `...(gone ? { error, plain } : {})` says both or
 * neither; `{ error, ...(gone ? { plain } : {}) }` leaves the error bare when it is not gone.
 */
function fieldsOf(object: ts.ObjectLiteralExpression, body: Body, covered = false): void {
  const under = covered || object.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propertyName(p.name) === "plain");
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name !== "error" && name !== "note" && name !== "plain") continue;
      const said = textsOf(ts.isPropertyAssignment(property) ? property.initializer : property.name);
      body[name].push(...said);
      if (name !== "plain" && !under) body.bare.push(...said.map((one) => ({ field: name as "error" | "note", said: one })));
    } else if (ts.isSpreadAssignment(property)) {
      for (const value of values(property.expression)) {
        if (ts.isObjectLiteralExpression(value)) fieldsOf(value, body, under);
        else if (!isNoText(value)) {
          body.unread.push(`...${value.getText()}`);
          if (!under) body.bareUnread.push(`...${value.getText()}`);
        }
      }
    }
  }
}

/** One reply: each body's words, and the statuses it answers with. */
function readReply(call: ts.CallExpression, route: { method: string; path: string }): Reply {
  const reply: Reply = { file: relative(ROOT, call.getSourceFile().fileName), line: lineOf(call), ...route, status: null, bodies: [], error: [], note: [], plain: [], plainAlways: true, unread: [] };
  const [first, second] = call.arguments as unknown as [ts.Expression, ts.Expression | undefined];
  let bodies: ts.Expression[];
  let statuses: ts.Expression[] | null;
  if (ts.isSpreadElement(first)) {
    // `c.json(...refused(x))`: a body and its status, as a tuple a function of the file returns.
    const tuples = values(first.expression);
    bodies = tuples.flatMap((tuple) => (ts.isArrayLiteralExpression(tuple) && tuple.elements[0] ? values(tuple.elements[0] as ts.Expression) : [tuple]));
    statuses = tuples.every((tuple) => ts.isArrayLiteralExpression(tuple) && tuple.elements[1]) ? tuples.flatMap((tuple) => values((tuple as ts.ArrayLiteralExpression).elements[1] as ts.Expression)) : null;
  } else {
    bodies = values(first);
    statuses = second ? values(second) : [];
  }
  reply.status = statuses === null || !statuses.every(ts.isNumericLiteral) ? null : statuses.length === 0 ? [200] : statuses.map((status) => Number(status.text));
  for (const value of bodies) {
    const body: Body = { error: [], note: [], plain: [], plainAlways: false, unread: [], bare: [], bareUnread: [] };
    if (ts.isObjectLiteralExpression(value)) fieldsOf(value, body);
    else if (!isNoText(value)) {
      body.unread.push(value.getText());
      body.bareUnread.push(value.getText());
    }
    body.plainAlways = body.plain.length > 0 && body.bare.length === 0 && body.bareUnread.length === 0;
    reply.bodies.push(body);
    for (const field of ["error", "note", "plain", "unread"] as const) (reply[field] as unknown[]).push(...body[field]);
  }
  reply.plainAlways = reply.plain.length > 0 && reply.bodies.every((body) => body.plainAlways || !hasWords(body));
  return reply;
}

const hasWords = (body: Body): boolean => body.error.length > 0 || body.note.length > 0 || body.unread.length > 0;

const isReply = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && node.arguments.length > 0 && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "json" &&
  ts.isIdentifier(node.expression.expression) && node.expression.expression.text !== "Response";

/** The replies a function answers with, and those of each function of its file it calls. */
function repliesOf(fn: ts.Node, seen: Set<ts.Node> = new Set()): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (isReply(node)) found.push(node);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const local = functionOf(declarationOf(node.expression.text, node));
      if (local && !seen.has(local)) {
        seen.add(local);
        found.push(...repliesOf(local, seen));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

const METHODS = new Set(["get", "post", "put", "delete", "patch", "all"]);

/** A route registered on the control app: its method, its path (a template's value as a parameter) and its handlers. */
function registration(node: ts.Node): { method: string; path: string; handlers: ts.Node[] } | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const target = node.expression.expression;
  if (!ts.isIdentifier(target) || target.text !== "control" || !METHODS.has(node.expression.name.text)) return null;
  const [path, ...handlers] = node.arguments;
  if (!path) return null;
  const text = ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path)
    ? path.text
    : ts.isTemplateExpression(path)
      ? path.head.text + path.templateSpans.map((span, index) => `:${index}${span.literal.text}`).join("")
      : null;
  return text === null ? null : { method: node.expression.name.text.toUpperCase(), path: text, handlers };
}

/** Every reply in one control source file. `source` is the file's text, read from `path` unless given (a test's fixture). */
export function repliesIn(path: string, source: string = readFileSync(path, "utf8")): Reply[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: Reply[] = [];
  if (EVERY_ROUTE.has(path.split("/").pop() ?? "")) {
    for (const call of repliesOf(file)) found.push(readReply(call, { method: "*", path: "*" }));
    return found;
  }
  const visit = (node: ts.Node): void => {
    const route = registration(node);
    if (route) {
      const seen = new Set<ts.Node>();
      for (const handler of route.handlers) for (const call of repliesOf(handler, seen)) found.push(readReply(call, route));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every route one control source file registers, as this reads it: a route it cannot read is not held by `unplain`. */
export function routesIn(path: string, source: string = readFileSync(path, "utf8")): { method: string; path: string }[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: { method: string; path: string }[] = [];
  const visit = (node: ts.Node): void => {
    const route = registration(node);
    if (route) found.push({ method: route.method, path: route.path });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The control API's sources: the guard, and every file of routes. */
export function controlSources(): string[] {
  const routes = readdirSync(join(CONTROL, "routes")).filter((name) => name.endsWith(".ts")).map((name) => join(CONTROL, "routes", name));
  return [...[...EVERY_ROUTE].map((name) => join(CONTROL, name)), ...routes.sort()];
}

/** Whether the dashboard calls this route: one of its calls, for the method it calls it with. The guard's: always. */
export function calledBy(reply: Pick<Reply, "method" | "path">, calls: readonly Call[]): Call[] {
  if (reply.method === "*") return [...calls];
  const shape = routeShape(reply.path);
  return calls.filter((call) => (call.method === null || reply.method === "ALL" || call.method === reply.method) && matches(call.shape, shape));
}

/**
 * Why a reply on a route the dashboard calls does not read as everyday words, or nothing when it does. Each body it can
 * answer with is held on its own. A `plain` is what the page shows: it has to be words this reads, passing the
 * dashboard's rule, beside the route's own `error` or `note` for the CLI. An `error` or `note` with a `plain` beside it
 * passes as it is; one without is held to the same rule, and a refusal whose words are written in another file cannot
 * pass. `pageWords`: the page shows words from this route's success (its call's answer has a note or an error), so a
 * success whose fields are written elsewhere cannot pass either.
 */
export function unplain(reply: Reply, pageWords = false): string[] {
  const refusal = reply.status === null || reply.status.some((status) => status >= 400);
  return [...new Set(reply.bodies.flatMap((body) => unplainBody(body, refusal || pageWords, refusal)))];
}

/** Why one body does not read as everyday words: `held`, a refusal's or a success the page shows words from. */
function unplainBody(body: Body, held: boolean, refusal: boolean): string[] {
  const why: string[] = [];
  const hold = (field: string, said: Said) => {
    for (const expression of said.unread) why.push(`${field} holds words written elsewhere: ${expression}`);
    const rule = said.text ? technical({ text: said.text, inCode: false }) : null;
    if (rule) why.push(`${field} has ${rule}: "${said.text}"`);
  };
  for (const said of body.plain) hold("plain", said);
  if (body.plain.length > 0 && !hasWords(body)) why.push("a plain with no error or note beside it, the words the CLI prints");
  for (const { field, said } of body.bare) hold(field, said);
  if (body.bareUnread.length > 0 && held) {
    why.push(`${refusal ? "a refusal" : "a success the page shows words from"} written elsewhere: ${body.bareUnread.join(", ")}`);
  }
  return why;
}

/** Every reply on a route the dashboard calls, with why each does not read as everyday words (empty when it does). */
export function dashboardReplies(): { reply: Reply; why: string[] }[] {
  const calls = dashboardCalls();
  return controlSources()
    .flatMap((path) => repliesIn(path))
    .flatMap((reply) => {
      const callers = calledBy(reply, calls);
      if (callers.length === 0) return [];
      const pageWords = reply.method !== "*" && callers.some((call) => answersWithWords(call.answer));
      return [{ reply, why: unplain(reply, pageWords) }];
    });
}

if (import.meta.main) {
  const flagged = process.argv.includes("--technical");
  const rows = dashboardReplies().filter((row) => !flagged || row.why.length > 0);
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  const words = (said: Said[]) => said.map((one) => one.text || one.unread.join(" ")).join(" / ");
  console.log(flagged ? "| where | route | why |\n|---|---|---|" : "| where | route | status | error | note | plain |\n|---|---|---|---|---|---|");
  const done = new Set<string>();
  for (const { reply, why } of rows) {
    const at = `${relative("apps/engine/src/modules/web/control", reply.file)}:${reply.line}`;
    if (done.has(at)) continue;
    done.add(at);
    const route = `${reply.method} ${reply.path}`;
    if (flagged) console.log(`| ${at} | ${route} | ${cell(why.join("; "))} |`);
    else console.log(`| ${at} | ${route} | ${reply.status?.join(",") ?? "?"} | ${cell(words(reply.error))} | ${cell(words(reply.note))} | ${cell(words(reply.plain))} |`);
  }
  console.error(`${done.size} replies on routes the dashboard calls${flagged ? " that do not read as everyday words" : ""}`);
}
