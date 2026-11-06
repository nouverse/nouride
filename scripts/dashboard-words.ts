#!/usr/bin/env bun
/**
 * Every string a person reads on the dashboard, with its file and line (0.8.19, "the dashboard in plain words"). The
 * people who use the dashboard are not technical (the owner, 2026-11-05), and a sweep for wording that says otherwise
 * starts from the list of what is there.
 *
 *   bun run scripts/dashboard-words.ts               every string, as a table: file and line, how it shows, the words
 *   bun run scripts/dashboard-words.ts --technical   only those the contract test refuses, and why
 *   bun run scripts/dashboard-words.ts <path>…       only the files under these paths (`modules/chat`, say)
 *
 * Read by the TypeScript parser, as `no-em-dash.test.ts` reads the dashboard's strings, so a comment is never wording,
 * and a string is wording only where it ends up on the screen: JSX text; the props that carry text (`title`,
 * `description`, `label`, `placeholder`, `aria-label` and the rest of `VISIBLE_PROPS`); a string a JSX child renders,
 * through `?:`, `||`, `??`, `&&`, `+` or a template; a toast; an object's text keys (a confirmation's `title` and
 * `body`, a choice's `label`); an error the page throws; and, anywhere else, a literal that reads as a sentence. A class
 * name, a query key, a route or a value compared against is code, and left out.
 *
 * `apps/engine/tests/contracts/plain-dashboard.test.ts` reads the dashboard through `wordsIn` and holds it to
 * `TECHNICAL`: no command, flag, path, file name or internal word outside a "Details" section, the admin pages (Logs,
 * LLM gateway) aside, and a line marked `plain-words-ok: <why>` kept. `plain-replies.test.ts` holds the server's
 * refusals and notes on the dashboard's routes to the same `technical()` (0.8.20, `route-words.ts`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");
export const DASHBOARD = join(ROOT, "apps/dashboard/src");

/** One string a person reads, where it is, and whether it sits in a "Details" section for whoever runs the server. */
export interface Wording {
  file: string;
  line: number;
  /** How it reaches the screen: `text`, `prop:title`, `child`, `toast`, `key:label`, `error`, `sentence`. */
  where: string;
  /** The words, with `{}` where a template puts a value. */
  text: string;
  /** Inside `<details>` whose summary reads "Details", or the shared `<Details>`: for whoever runs the server. */
  inDetails: boolean;
  /** Inside `<code>`: shown as typed, which is what a command or a path looks like. */
  inCode: boolean;
  /** The line holds `plain-words-ok: <why>`: kept on purpose, with its reason. */
  kept: boolean;
}

/** JSX props whose value is shown, or read aloud: found by counting which props the dashboard passes a sentence to. */
const VISIBLE_PROPS = new Set([
  "title", "description", "label", "placeholder", "aria-label", "alt", "hint", "summary", "message", "detail", "body",
  "confirmLabel", "text", "note", "caption", "badge", "suffix", "says", "said", "customHint", "cta", "none", "when",
  "reason", "what", "done", "empty", "heading", "subtitle", "tooltip", "help",
  // `AskAgentButton`'s: the rest of its label after the orchestrator's name, and the message it writes for the person.
  "task",
]);

/** An object's keys whose value is shown: a choice's label, a confirmation's title and body, a field's hint. */
const VISIBLE_KEYS = new Set([
  "label", "title", "body", "hint", "confirmLabel", "placeholder", "note", "detail", "summary", "description", "text",
  "message", "blurb", "said", "tokenHint", "where", "help", "caption", "heading", "empty",
]);

/** Calls whose arguments are classes or selectors, never words. */
const CODE_CALLS = new Set(["cn", "clsx", "twMerge", "querySelector", "querySelectorAll", "getElementById", "matchMedia"]);

/** A literal that reads as a sentence where nothing else says it is shown: two words or more, the first capitalised. */
const SENTENCE = /^[A-Z][A-Za-z']*[,:]?\s+[A-Za-z(]/;

/**
 * Words, wherever they are: a capitalised sentence, or two plain words or more making up at least half of it — a
 * heading a helper returns in lowercase ("the daemon started this turn") is read, a class list ("btn btn-ghost") is not.
 */
function readsAsWords(text: string): boolean {
  if (SENTENCE.test(text)) return true;
  const tokens = text.trim().split(/\s+/);
  const plain = tokens.filter((token) => /^[A-Za-z][a-z']*[,.;:!?)]?$/.test(token));
  return plain.length >= 2 && plain.length * 2 >= tokens.length;
}

const isLiteral = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** A template's words, a value standing as `{}`. */
const templateText = (node: ts.TemplateExpression): string => node.head.text + node.templateSpans.map((span) => `{}${span.literal.text}`).join("");

/**
 * The literals an expression can render as: itself, either side of `?:`, `||` and `??`, the right of `&&`, both sides
 * of `+`, a template's words and what its values render. A comparison's operands and a call's arguments are code.
 */
function rendered(node: ts.Expression | undefined): ts.Node[] {
  if (!node) return [];
  if (isLiteral(node)) return [node];
  if (ts.isTemplateExpression(node)) return [node, ...node.templateSpans.flatMap((span) => rendered(span.expression))];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return rendered(node.expression);
  }
  if (ts.isConditionalExpression(node)) return [...rendered(node.whenTrue), ...rendered(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
      return [...rendered(node.left), ...rendered(node.right)];
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return rendered(node.right);
  }
  return [];
}

const tagOf = (node: ts.Node): string | null =>
  ts.isJsxElement(node) ? node.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(node) ? node.tagName.getText() : null;

/** `<details>` whose `<summary>` reads "Details", or the shared `<Details>` that draws one. */
function isDetails(node: ts.Node): boolean {
  if (!ts.isJsxElement(node)) return false;
  const tag = tagOf(node);
  if (tag === "Details") return true;
  return tag === "details" && node.children.some((child) => ts.isJsxElement(child) && tagOf(child) === "summary" && child.children.map((part) => part.getText()).join("").trim() === "Details");
}

const within = (node: ts.Node, test: (at: ts.Node) => boolean): boolean => {
  for (let at = node.parent; at; at = at.parent) if (test(at)) return true;
  return false;
};

const COMPARISON = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword]);

/**
 * A position that holds code: an import, a type, a lookup's key, a `case`, an operand of a comparison, a class list, or
 * a prop that is not shown (`className`, `href`, `to`). Inside a function in a prop (an `onClick`), the sentence test
 * decides: `setError("Could not save")` is wording.
 */
function inCode(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isElementAccessExpression(parent) || ts.isCaseClause(parent) || (ts.isPropertyAssignment(parent) && parent.name === node)) return true;
  if (ts.isBinaryExpression(parent) && COMPARISON.has(parent.operatorToken.kind)) return true;
  for (let at: ts.Node | undefined = parent; at; at = at.parent) {
    if (ts.isCallExpression(at) && CODE_CALLS.has(at.expression.getText().split(".").pop() ?? "")) return true;
    if (ts.isTypeNode(at)) return true;
    if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) return false;
    if (ts.isJsxAttribute(at)) return !VISIBLE_PROPS.has(at.name.getText());
  }
  return false;
}

const TOAST_METHODS = new Set(["success", "error", "warning", "info", "show"]);
const isToast = (node: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(node.expression) && TOAST_METHODS.has(node.expression.name.text) && /toast/i.test(node.expression.expression.getText());

/**
 * Every string a person reads in one dashboard source file. `source` is the file's text, read from `path` unless given
 * (a test hands it a fixture).
 */
export function wordsIn(path: string, source: string = readFileSync(path, "utf8")): Wording[] {
  const lines = source.split("\n");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const seen = new Set<ts.Node>();
  const found: Wording[] = [];
  const add = (node: ts.Node, where: string) => {
    if (seen.has(node)) return;
    seen.add(node);
    const raw = ts.isJsxText(node) ? node.text : ts.isTemplateExpression(node) ? templateText(node) : isLiteral(node) ? node.text : "";
    const text = raw.replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]{2}/.test(text)) return;
    // JSX text starts with the whitespace after its tag: its line is where its first word is.
    const start = ts.isJsxText(node) ? node.getStart(file) + (raw.length - raw.trimStart().length) : node.getStart(file);
    const line = file.getLineAndCharacterOfPosition(start).line;
    found.push({
      file: relative(ROOT, path),
      line: line + 1,
      where,
      text,
      inDetails: within(node, isDetails),
      inCode: within(node, (at) => tagOf(at) === "code"),
      kept: /plain-words-ok: \S/.test(lines[line] ?? ""),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) add(node, "text");
    else if (ts.isJsxAttribute(node) && VISIBLE_PROPS.has(node.name.getText()) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      for (const literal of rendered(value as ts.Expression | undefined)) add(literal, `prop:${node.name.getText()}`);
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const literal of rendered(node.expression)) add(literal, "child");
    } else if (ts.isCallExpression(node) && isToast(node)) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) for (const literal of rendered(arg)) add(literal, "toast");
        else for (const prop of arg.properties) if (ts.isPropertyAssignment(prop) && ["message", "detail"].includes(prop.name.getText())) for (const literal of rendered(prop.initializer)) add(literal, "toast");
      }
    } else if (ts.isPropertyAssignment(node) && VISIBLE_KEYS.has(node.name.getText().replace(/["']/g, ""))) {
      for (const literal of rendered(node.initializer)) add(literal, `key:${node.name.getText().replace(/["']/g, "")}`);
    } else if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText())) {
      for (const arg of node.arguments ?? []) for (const literal of rendered(arg)) add(literal, "error");
    } else if ((isLiteral(node) || ts.isTemplateExpression(node)) && !seen.has(node) && !inCode(node)) {
      if (readsAsWords(ts.isTemplateExpression(node) ? templateText(node) : node.text)) add(node, "sentence");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every `.ts` and `.tsx` file under `dir`, sorted; generated and declaration files left out. */
export function sources(dir: string = DASHBOARD): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
      return /\.tsx?$/.test(name) && !/\.(gen|d)\.ts$/.test(name) ? [path] : [];
    })
    .sort();
}

/**
 * What a person who is not technical should never meet, each with the reason the test gives. A command or a flag says
 * "go to a terminal"; a path or a file name is where the server keeps something; the words are how the program is
 * built, not what it does for them. "install" counts as a noun ("this install"), never the verb; "line" and "track" as
 * a line of releases; "token" in every sense but the one the Secrets page is about, so a count of a model's tokens is
 * kept with its reason. "Coding CLI" is the name the owner kept for Claude Code, Codex and their like (2026-11-05), the
 * Models page's tab, so it passes; a CLI on its own does not. A section of the config file (`[memory.semantic]`,
 * `[[people]]`) and a setting's name as the file writes it (`pass_model`) are the file itself, and `git`'s words
 * (commit, worktree) a tool's: three the server's replies said on the page (0.8.20). `[forgotten]`, what a hidden name
 * becomes, reads as a section and is kept on its line with its reason.
 */
export const TECHNICAL: { why: string; pattern: RegExp }[] = [
  { why: "a command", pattern: /(?<![\w/.-])nouride [a-z][a-z-]+/ },
  { why: "a flag", pattern: /(?<![\w-])--[a-z][a-z-]*/ },
  { why: "a file name", pattern: /\b[\w-]+\.(?:toml|json|ya?ml|env|sh|md|db|sqlite|key|enc|sealed|lock|py)\b/ },
  { why: "a path", pattern: /(?:^|[\s(`'"])(?:\/srv\/|\/etc\/|\/opt\/|\/var\/|\/usr\/|\/tmp\/|\/path\/|~\/|\.nouride\b|data\/|workspace\/|agents\/)/ },
  { why: "an internal word", pattern: /\b(?:daemon|gateways?|snapshots?|seal(?:s|ed|ing)?|unseal\w*|passphrases?|payloads?|ACP|MCP|(?<!coding )CLIs?|stdin|adapters?|registry|config(?:s|uration)?|tokens?)\b/i },
  { why: "an internal word", pattern: /\b(?:the|this|that|an|each|every|your|its|our|whole|one|whose)\s+install(?:'s|s)?\b|\binstall's\b/i },
  { why: "an internal word", pattern: /\b(?:update|release|long-term|newer|older|stable|LTS)\s+(?:track|line)s?\b/i },
  { why: "a section of the config file", pattern: /\[\[?[a-z][a-z_]*(?:\.[a-z][a-z_]*)*\]\]?/ },
  { why: "a setting's name", pattern: /\b[a-z]+(?:_[a-z]+)+\b/ },
  { why: "a git word", pattern: /\b(?:[Gg]it|[Cc]ommit(?:s|ted|ting)?|[Uu]ncommitted|[Ww]orktrees?|[Rr]ebas(?:e|ed|ing)|[Ss]tash(?:ed|es)?|HEAD)\b/ },
];

/** Why a string a person reads is technical, or null: shown as code, or one of `TECHNICAL`. */
export function technical(word: Pick<Wording, "text" | "inCode">): string | null {
  if (word.inCode) return "shown as code";
  return TECHNICAL.find((rule) => rule.pattern.test(word.text))?.why ?? null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const only = args.filter((arg) => !arg.startsWith("--"));
  const flagged = args.includes("--technical");
  const files = sources().filter((path) => only.length === 0 || only.some((part) => relative(DASHBOARD, path).startsWith(part)));
  const rows = files.flatMap((path) => wordsIn(path)).filter((word) => !flagged || (!word.inDetails && !word.kept && technical(word)));
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  console.log(flagged ? "| where | how | why | words |\n|---|---|---|---|" : "| where | how | words |\n|---|---|---|");
  for (const word of rows) {
    const at = `${relative("apps/dashboard/src", word.file)}:${word.line}`;
    const how = `${word.where}${word.inDetails ? ", in Details" : ""}${word.kept ? ", kept" : ""}`;
    console.log(flagged ? `| ${at} | ${how} | ${technical(word)} | ${cell(word.text)} |` : `| ${at} | ${how} | ${cell(word.text)} |`);
  }
  console.error(`${rows.length} strings in ${files.length} files`);
}
