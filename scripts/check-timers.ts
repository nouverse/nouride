#!/usr/bin/env bun
/**
 * No timer callback, and no event listener, in daemon code lets an exception out.
 *
 * Nothing is above a `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` or `process.nextTick` callback to
 * catch what it throws, so a throw there is an uncaught exception — and `apps/engine/src/boot/shutdown.ts` shuts the
 * daemon down on one, on purpose. Every conversation on every gateway ends because an hourly check found the database
 * busy, or closed. A promise such a callback lets go of is the other half: it rejects into the `unhandledRejection`
 * handler, which says a `.catch()` is missing and nothing about where. `pipeline/provider-resume.ts` was found doing the
 * first in 0.7.10, and the sweep after it found two dozen more — the retention sweep, the job watchdog, the approval
 * timeout and the restart an update waits on among them.
 *
 * ## The rule
 *
 * A timer's callback is one of:
 *
 * - `contained(log, "what failed", body)` from `@nouride/shared`: the body's throw or rejection is one log line, and
 *   the timer goes on;
 * - a function whose whole body is one `try … catch` — the same by hand, for code that cannot import it (the WhatsApp
 *   bridge, the Pro plugins) or says a failure its own way (the CLI);
 * - a form that cannot throw: the `resolve` or `reject` of the promise it is written inside, passed or called;
 *   `x.abort()`; `clearTimeout` or `clearInterval`; an assignment — each given values, never what a call returned.
 *
 * Anything else is a finding that names the file, the line and the timer. A call is not taken on trust however harmless
 * its name reads: `store.delete(id)` reads like a map's and is a database's.
 *
 * `abort()` is on the list because it returns normally whatever its listeners do. Bun reports a listener that throws
 * as an uncaught exception all the same — at whoever aborted, timer or not — so that risk is the listener's, and
 * catching around the `abort()` would catch nothing.
 *
 * ## Listeners
 *
 * The same holds for an event's listener, and for the same reason: whoever emits the event is the event loop — a
 * socket's data, a child process exiting, a signal aborting — so a listener's throw is uncaught too. In Bun `abort()`
 * returns normally when an abort listener throws, and the throw still reaches `uncaughtException`. So a listener given
 * to `.on`, `.once`, `.addListener`, `.prependListener`, `.prependOnceListener` or `.addEventListener`, or assigned to
 * an `on…` property of an event target (`signal.onabort`), is held to the rule above. `contained` passes the event's
 * arguments through. A promise's `resolve` or `reject`, handed over as it is, is a listener that cannot throw.
 *
 * A listener is often a named function, so the same one can be taken off again (`removeEventListener`). A name this
 * file declares — `const stop = () => …`, `function onAbort() {…}`, `const end = contained(…)` — is judged by what it
 * is declared as; a name declared twice is judged by each.
 *
 * ## Where
 *
 * What runs in the daemon's process, and the `nouride` command's: `apps/engine/src`, each package's `src` and each Pro
 * plugin's. Not tests, and not code a browser runs (`BROWSER`): an exception there ends a page's render, not the daemon.
 *
 * ## The ways this could pass while checking nothing
 *
 * A timer reached by a name the check does not know. An alias — `const later = options.setInterval ?? setInterval` —
 * is followed, and its calls are timers; a timer function handed on as a value any other way is itself a finding. And a
 * parser that stopped finding timers would find nothing wrong forever, so a run that finds too few fails.
 */

import { relative } from "node:path";
import ts from "typescript";
import { lintedFiles } from "./lint-sources.ts";

export interface Finding {
  file: string;
  line: number;
  detail: string;
}

const ROOT = new URL("../", import.meta.url).pathname;

/** The calls whose callback the event loop runs later, with nothing above it to catch — and `process.nextTick`. */
const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]);

/** The calls that register an event listener, with the listener as their second argument. */
const LISTENS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener", "addEventListener"]);

/** An event target's handler properties — `signal.onabort = …`. Named rather than `on…`, which `runner.onboard` is. */
const HANDLER_PROPERTIES = new Set(["onabort", "onerror", "onmessage", "onclose", "onopen", "onexit"]);

/** Calls that cannot throw, given values: ending a timer. */
const CLEARS = new Set(["clearTimeout", "clearInterval"]);

/** The helper a callback may be wrapped in — `packages/shared/src/contained.ts`. */
const HELPER = "contained";

/**
 * Code a browser runs, and so not the daemon: the UI packages, and the setup console's page, which `src/core` imports
 * as text once `build:ui` has made it one HTML file.
 */
const BROWSER = [/^packages\/ui-[^/]+\//, /^internals\/pro\/packages\/[^/]+\/src\/ui\//];

/** Operators that combine two values without calling anything a reader would have to look up. */
const VALUE_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/**
 * A run that finds fewer timers than this is a parser that stopped finding them, not a tree that lost them: 0.7.10's
 * has 61. Lower it when timers really go — to a little under the count the run printed.
 */
export const MIN_TIMERS = 45;

/** Whether `rel` runs in the daemon (or the CLI) — see "Where" above. */
export function isDaemonSource(rel: string): boolean {
  if (rel.includes("/tests/") || /\.test\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) return false;
  if (BROWSER.some((pattern) => pattern.test(rel))) return false;
  return rel.startsWith("apps/engine/src/") || /^packages\/[^/]+\/src\//.test(rel) || /^internals\/pro\/packages\/[^/]+\/src\//.test(rel);
}

/**
 * The `resolve` or `reject` of the `new Promise(…)` an identifier is written inside: the nearest function that takes a
 * parameter of its name is a promise's executor. A local `const` of the same name in between is not looked for.
 */
function isExecutorParam(id: ts.Identifier): boolean {
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) continue;
    if (!node.parameters.some((param) => ts.isIdentifier(param.name) && param.name.text === id.text)) continue;
    const call = node.parent;
    return ts.isNewExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "Promise" && call.arguments?.[0] === node;
  }
  return false;
}

/** A value, read: a literal, a name, a field, an error being made — nothing that runs code someone else wrote. */
function isValue(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) return isValue(e.expression);
  if (ts.isLiteralExpression(e) || ts.isIdentifier(e)) return true;
  if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.ThisKeyword].includes(e.kind)) return true;
  if (ts.isPropertyAccessExpression(e)) return isValue(e.expression);
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((span) => isValue(span.expression));
  if (ts.isPrefixUnaryExpression(e)) return isValue(e.operand);
  if (ts.isBinaryExpression(e)) return VALUE_OPERATORS.has(e.operatorToken.kind) && isValue(e.left) && isValue(e.right);
  // `new GatewayError(this.id, "login timed out")`: an error, built from values, to reject with.
  if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && /Error$/.test(e.expression.text) && (e.arguments ?? []).every(isValue);
  return false;
}

/** One expression a timer may run bare — see "The rule" above. */
function cannotThrow(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isVoidExpression(e)) return cannotThrow(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return (ts.isIdentifier(e.left) || (ts.isPropertyAccessExpression(e.left) && isValue(e.left.expression))) && isValue(e.right);
  }
  if (!ts.isCallExpression(e) || !e.arguments.every(isValue)) return false;
  const callee = e.expression;
  if (ts.isIdentifier(callee)) return CLEARS.has(callee.text) || isExecutorParam(callee);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "abort" && isValue(callee.expression);
}

/** What each name a file declares as a function is: the arrow, the function, or the call it is the result of. */
type Declared = ReadonlyMap<string, readonly ts.Node[]>;

function declaredFunctions(source: ts.SourceFile): Declared {
  const out = new Map<string, ts.Node[]>();
  const add = (name: string, node: ts.Node): void => void out.set(name, [...(out.get(name) ?? []), node]);
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = node.initializer;
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isCallExpression(value)) add(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Why a timer's callback or a listener can let an exception out, or null when it cannot. */
function verdict(callback: ts.Expression, declared: Declared = new Map()): string | null {
  const wrap = `wrap it in \`${HELPER}(log, "what failed", …)\` from @nouride/shared — or, where that cannot be imported, its whole body in one \`try … catch\``;
  if (ts.isCallExpression(callback) && ts.isIdentifier(callback.expression) && callback.expression.text === HELPER) return null;
  if (ts.isIdentifier(callback)) {
    if (isExecutorParam(callback)) return null;
    const as = declared.get(callback.text) ?? [];
    if (as.length === 0) return `\`${callback.text}\` is a function this check cannot see into: ${wrap}`;
    for (const node of as) {
      const why = ts.isFunctionDeclaration(node) ? bodyVerdict(node.body, wrap) : verdict(node as ts.Expression);
      if (why) return `\`${callback.text}\` — ${why}`;
    }
    return null;
  }
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) return bodyVerdict(callback.body, wrap);
  return `it is computed, so this check cannot see what it runs: ${wrap}`;
}

/** A function's body: one `try … catch`, or only statements that cannot throw. */
function bodyVerdict(body: ts.ConciseBody | undefined, wrap: string): string | null {
  if (!body) return `it has no body to read: ${wrap}`;
  if (!ts.isBlock(body)) return cannotThrow(body) ? null : `its body can throw or reject: ${wrap}`;
  const [only] = body.statements;
  if (body.statements.length === 1 && only && ts.isTryStatement(only) && only.catchClause) return null;
  return body.statements.every((statement) => ts.isExpressionStatement(statement) && cannotThrow(statement.expression))
    ? null
    : `its body can throw or reject: ${wrap}`;
}

/** Inside a type — `ReturnType<typeof setTimeout>` — rather than a value. */
function inType(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at && !ts.isStatement(at); at = at.parent) {
    if (ts.isTypeNode(at)) return true;
  }
  return false;
}

/** The node that stands for a timer function where it is written — `setTimeout`, `options.setInterval` — if this is one. */
function timerReference(node: ts.Node): ts.Expression | null {
  if (ts.isIdentifier(node) && TIMERS.has(node.text)) {
    const parent = node.parent;
    // The name half of `options.setInterval` (met as the access itself), or a member's own name: `setInterval?: …`.
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return null;
    if ((ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return null;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || inType(node)) return null;
    return node;
  }
  if (!ts.isPropertyAccessExpression(node) || inType(node)) return null;
  const { name, expression } = node;
  if (TIMERS.has(name.text)) return node;
  return name.text === "nextTick" && ts.isIdentifier(expression) && expression.text === "process" ? node : null;
}

const calleeOf = (ref: ts.Expression): ts.CallExpression | null =>
  ts.isCallExpression(ref.parent) && ref.parent.expression === ref ? ref.parent : null;

/** The variable a timer function is the value of — `const later = options.setInterval ?? setInterval` — if any. */
function aliasOf(ref: ts.Expression): string | null {
  for (let at: ts.Node = ref; at.parent; at = at.parent) {
    const parent = at.parent;
    if (ts.isVariableDeclaration(parent)) return parent.initializer === at && ts.isIdentifier(parent.name) ? parent.name.text : null;
    if (!ts.isBinaryExpression(parent) && !ts.isParenthesizedExpression(parent) && !ts.isConditionalExpression(parent)) return null;
  }
  return null;
}

/** A listener registered in `node` — `x.on("data", cb)`, `signal.onabort = cb` — as what it is given and how it is named. */
function listenerOf(node: ts.Node, source: ts.SourceFile): { listener: ts.Expression; name: string } | null {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LISTENS.has(node.expression.name.text)) {
    const [event, listener] = node.arguments;
    if (!event || !listener) return null;
    return { listener, name: `${node.expression.name.text}(${event.getText(source)})` };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
    return HANDLER_PROPERTIES.has(node.left.name.text) ? { listener: node.right, name: node.left.name.text } : null;
  }
  return null;
}

/** Every timer and listener in one file, what is wrong with each, and a timer function handed on as a value. */
export function timerFindings(rel: string, text: string): { timers: number; listeners: number; findings: Finding[] } {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const calls: { call: ts.CallExpression; name: string }[] = [];
  const findings: Finding[] = [];
  const aliases = new Set<string>();
  const loose: ts.Expression[] = [];
  let listeners = 0;
  const declared = declaredFunctions(source);

  const visit = (node: ts.Node): void => {
    const listening = listenerOf(node, source);
    if (listening) {
      listeners += 1;
      // `null` takes a handler away.
      const why = listening.listener.kind === ts.SyntaxKind.NullKeyword ? null : verdict(listening.listener, declared);
      if (why) findings.push({ file: rel, line: lineOf(node), detail: `the listener given to \`${listening.name}\` can let an exception out — ${why}` });
    }
    const ref = timerReference(node);
    if (ref) {
      const call = calleeOf(ref);
      const alias = call ? null : aliasOf(ref);
      if (call) calls.push({ call, name: ref.getText(source) });
      else if (alias) aliases.add(alias);
      else loose.push(ref);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Calls through an alias, once every alias in the file is known.
  const viaAlias = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) calls.push({ call: node, name: node.expression.text });
    ts.forEachChild(node, viaAlias);
  };
  if (aliases.size > 0) viaAlias(source);

  for (const ref of loose) {
    findings.push({
      file: rel,
      line: lineOf(ref),
      detail: `\`${ref.getText(source)}\` is handed on as a value, so this check cannot read the callback it is given — call it by its name, or bind it to a const first`,
    });
  }
  for (const { call, name } of calls) {
    const [callback] = call.arguments;
    if (!callback) continue;
    const why = verdict(callback, declared);
    if (why) findings.push({ file: rel, line: lineOf(call), detail: `\`${name}\`'s callback can let an exception out — ${why}` });
  }
  return { timers: calls.length, listeners, findings };
}

export function floorFailure(timers: number): string | null {
  return timers < MIN_TIMERS
    ? `found only ${timers} timers in daemon code, expected at least ${MIN_TIMERS} — the parser in this script is broken, not the repo`
    : null;
}

/** The whole tree: every daemon source file this repository has, the Pro plugins' when they are checked out. */
export async function checkTimers(root: string = ROOT): Promise<{ timers: number; listeners: number; files: number; findings: Finding[] }> {
  let timers = 0;
  let listeners = 0;
  let files = 0;
  const findings: Finding[] = [];
  for (const path of await lintedFiles(root, ["ts", "tsx"])) {
    const rel = relative(root, path);
    if (!isDaemonSource(rel)) continue;
    files += 1;
    const found = timerFindings(rel, await Bun.file(path).text());
    timers += found.timers;
    listeners += found.listeners;
    findings.push(...found.findings);
  }
  return { timers, listeners, files, findings };
}

async function main(): Promise<void> {
  const { timers, listeners, files, findings } = await checkTimers();
  const floor = floorFailure(timers);
  if (floor) {
    console.error(`✗ ${floor}. Fix it before trusting a pass.`);
    process.exit(1);
  }
  if (findings.length === 0) {
    console.log(`✓ ${timers} timers and ${listeners} listeners in ${files} daemon source files — none can let an exception out`);
    return;
  }
  console.error(`✗ ${findings.length} timer callback(s) or listener(s) that can let an exception out of the event loop:\n`);
  for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.detail}\n`);
  }
  console.error("An uncaught exception shuts the daemon down (apps/engine/src/boot/shutdown.ts) — see the header of scripts/check-timers.ts.");
  process.exit(1);
}

if (import.meta.main) await main();
