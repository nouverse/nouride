/**
 * What each control route answers, held to the type its dashboard caller declares.
 *
 * The dashboard types an answer where it asks for it (`request<{ jobs: JobSummary[] }>(…)`), from `@nouride/wire`. The
 * route wrote whatever it wrote: a field renamed, dropped or never sent failed in a browser and nowhere else. A route's
 * answer now says the same type after it, `c.json(body satisfies { jobs: JobSummary[] })`, so the compiler holds the
 * route to what its caller reads. This reads both sides as text and pairs them, for the test that keeps the two the
 * same words (`apps/engine/tests/contracts/route-answers.test.ts`): a type changed on one side alone fails there.
 *
 * The pairing is `dashboard-calls.ts`'s: a call goes to the one route that would take it, the most literal match.
 *
 * An answer is `c.json(body)` in the route's handler, and two shapes beside it: a helper handed the context and a
 * body held to a type (`jsonGzipped(c, graph satisfies MemoryGraph)`), and a function of the same file the handler
 * hands its context to (`(c) => start(c, undefined)`), whose answers are then the route's.
 */

import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { dashboardCalls, matches, routeShape, type Call, type Shape } from "./dashboard-calls.ts";

const ROOT = join(import.meta.dir, "..");
const CONTROL = join(ROOT, "apps/engine/src/modules/web/control");
const METHODS = ["get", "post", "put", "patch", "delete"];

/** A type as written, less what does not change its meaning: comments, line breaks, a last `;`. */
export const sameWords = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ").replace(/\s+/g, " ").replace(/; \}/g, " }").trim();

export interface RouteAnswers {
  /** `GET /cron/:id`, as the route registers it. */
  route: string;
  /** The route's file, from the repository's root. */
  file: string;
  /** Each answer its dashboard callers declare, once. */
  declared: string[];
  /** Each answer the handler gives that is not a refusal: the type it is held to, or null where it is held to none. */
  answers: { line: number; held: string | null }[];
  /** Names in a held type that the file does not import from `@nouride/wire`. */
  notWire: string[];
}

const BUILT_IN = new Set(["Record", "Partial", "Pick", "Omit", "Array", "Promise", "Extract", "Exclude", "Required", "Readonly", "NonNullable"]);

/** How well a route fits a call: a literal segment both have counts for it, one only the route has counts against. */
const fit = (call: Shape, route: Shape): number =>
  route.reduce((score, segment, index) => score + (segment === null || segment === "*" ? 0 : segment === call[index] ? 2 : -1), 0);

/** The functions a file declares by name, each with what it calls its first parameter: where a handler's context can go. */
function localFunctions(source: ts.SourceFile): Map<string, { body: ts.Node; c: string }> {
  const found = new Map<string, { body: ts.Node; c: string }>();
  const keep = (name: string, fn: ts.FunctionLikeDeclaration): void => {
    const first = fn.parameters[0]?.name;
    if (fn.body && first && ts.isIdentifier(first)) found.set(name, { body: fn.body, c: first.text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) keep(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) keep(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function routeAnswers(): RouteAnswers[] {
  interface Route { file: string; method: string; path: string; shape: Shape; handler: ts.Node; c: string; source: ts.SourceFile }
  const routes: Route[] = [];
  for (const name of (readdirSync(CONTROL, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts")).sort()) {
    const file = join(CONTROL, name);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "control" && METHODS.includes(node.expression.name.text) && node.arguments.length >= 2
      ) {
        const [path] = node.arguments;
        const handler = node.arguments.at(-1)!;
        if (path && ts.isStringLiteral(path) && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
          const first = handler.parameters[0]?.name;
          routes.push({ file, method: node.expression.name.text.toUpperCase(), path: path.text, shape: routeShape(path.text), handler, c: first && ts.isIdentifier(first) ? first.text : "c", source });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const taken = new Map<Route, Call[]>();
  for (const call of dashboardCalls()) {
    if (call.answer === null) continue;
    const able = routes.filter((route) => (call.method === null || call.method === route.method) && matches(call.shape, route.shape));
    if (able.length === 0) continue;
    const best = able.reduce((a, b) => (fit(call.shape, b.shape) > fit(call.shape, a.shape) ? b : a));
    taken.set(best, [...(taken.get(best) ?? []), call]);
  }

  return [...taken].map(([route, calls]) => {
    const text = route.source.getFullText();
    const wire = new Set([...text.matchAll(/import type \{([^}]*)\} from "@nouride\/wire";/g)].flatMap((found) => found[1]!.split(",").map((name) => name.trim().split(/\s+as\s+/).at(-1)!)).filter(Boolean));
    const answers: RouteAnswers["answers"] = [];
    const names = new Set<string>();
    const answered = (node: ts.Node, held: string | null): void => {
      answers.push({ line: route.source.getLineAndCharacterOfPosition(node.getStart(route.source)).line + 1, held });
      for (const name of held?.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? []) if (!BUILT_IN.has(name)) names.add(name);
    };
    const local = localFunctions(route.source);
    const followed = new Set<ts.Node>();
    /** The answers under `root`, where the context is called `c`. */
    const read = (root: ts.Node, c: string): void => {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === c && node.expression.name.text === "json") {
          const [body, status] = node.arguments;
          const refusal =
            !body || ts.isSpreadElement(body) || (status !== undefined && !(ts.isNumericLiteral(status) && Number(status.text) < 400)) ||
            (ts.isObjectLiteralExpression(body) && body.properties.some((property) => property.name && ts.isIdentifier(property.name) && property.name.text === "error"));
          if (!refusal) answered(node, ts.isSatisfiesExpression(body) ? sameWords(body.type.getText(route.source)) : null);
        } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === c) {
          const body = node.arguments[1];
          const helper = local.get(node.expression.text);
          // A body held to a type where it is handed over is the answer, whatever the helper does with it.
          if (body && ts.isSatisfiesExpression(body)) answered(node, sameWords(body.type.getText(route.source)));
          else if (helper && !followed.has(helper.body)) {
            followed.add(helper.body);
            read(helper.body, helper.c);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(root);
    };
    read(route.handler, route.c);
    return {
      route: `${route.method} ${route.path}`,
      file: relative(ROOT, route.file),
      declared: [...new Set(calls.map((call) => sameWords(call.answer!)))],
      answers,
      notWire: [...names].filter((name) => !wire.has(name)),
    };
  });
}
