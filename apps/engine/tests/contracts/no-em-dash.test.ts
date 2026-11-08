/**
 * No em dash in what a person reads: the site's docs, the README and the guide, release notes
 * from 0.8.15 on, the dashboard's words, what the daemon and its packages say (and what their prompts teach a model to
 * write to a person), what the installer and the container's scripts print, and the built-in skills and example pack.
 * A comma, a colon, a full stop or parentheses says it; a page full of dashes reads as written by a machine.
 *
 * Left alone: code blocks and code spans, which quote what a program prints; code comments; a lone "—" shown for a
 * value that is not there, which is not wording; and a line marked `em-dash-ok: <why>`, for text another program
 * matches in what older versions stored.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../../../..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

/**
 * Lines of Markdown prose with an em dash. Fenced blocks and code spans are left out, a span crossing a line break
 * included (a per-line reading flagged its second half), and so is a table cell holding only "—".
 */
function inMarkdown(path: string): string[] {
  let fenced = false;
  const lines = readFileSync(path, "utf8").split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line;
  });
  const prose = lines
    .join("\n")
    .replace(/`[^`\n]*(?:\n(?!\s*\n)[^`\n]*)*`/g, (span) => span.replace(/[^\n]/g, " "))
    .replace(/\|\s*—\s*(?=\|)/g, "|");
  return prose.split("\n").flatMap((line, index) => (line.includes("—") ? [`${relative(ROOT, path)}:${index + 1}`] : []));
}

const WORDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

/** Strings and JSX text holding an em dash, written or escaped (`—`), read by the parser: comments are not tokens. */
function inStrings(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (WORDS.has(node.kind)) {
      const raw = node.getText(source);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const lone = /^(["'`]?)—\1$/.test(raw.trim());
      if (/—|\\u2014|\\u\{2014\}/i.test(raw) && !lone && !lines[line]?.includes("em-dash-ok:")) {
        found.push(`${relative(ROOT, path)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const atLeast0815 = (name: string) => {
  const m = /^v(\d+)\.(\d+)\.(\d+)\.md$/.exec(name);
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number) as [number, number, number];
  return major > 0 || minor > 8 || (minor === 8 && patch >= 15);
};

const daemonSources = () =>
  [join(ROOT, "apps/engine/src"), ...readdirSync(join(ROOT, "packages")).map((name) => join(ROOT, "packages", name, "src"))]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => files(dir, /\.tsx?$/));

describe("no em dash in what a person reads", () => {
  test("the site's docs, English and Indonesian", () => {
    const pages = files(join(ROOT, "apps/site/src/content/docs"), /\.mdx?$/);
    expect(pages.length).toBeGreaterThan(60);
    expect(pages.flatMap(inMarkdown)).toEqual([]);
  });

  test("the README and the guide", () => {
    expect(["README.md", "GETTING_STARTED.md"].flatMap((name) => inMarkdown(join(ROOT, name)))).toEqual([]);
  });

  test("release notes from 0.8.15 on", () => {
    const notes = readdirSync(join(ROOT, "docs/releases")).filter(atLeast0815);
    expect(notes).toContain("v0.8.15.md");
    expect(notes.flatMap((name) => inMarkdown(join(ROOT, "docs/releases", name)))).toEqual([]);
  });

  test("the dashboard's words", () => {
    const sources = files(join(ROOT, "apps/dashboard/src"), /\.tsx?$/);
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.flatMap(inStrings)).toEqual([]);
  });

  test("what the daemon and its packages say, and what their prompts teach a model to write", () => {
    const sources = daemonSources();
    expect(sources.length).toBeGreaterThan(800);
    expect(sources.flatMap(inStrings)).toEqual([]);
  });

  test("a line kept with an em dash says why", () => {
    const marked = [...daemonSources(), ...files(join(ROOT, "apps/dashboard/src"), /\.tsx?$/)].flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) => (line.includes("em-dash-ok") && !/em-dash-ok: \S/.test(line) ? [`${relative(ROOT, path)}:${index + 1}`] : [])),
    );
    expect(marked).toEqual([]);
  });

  test("what the installer and the container's scripts print", () => {
    const scripts = ["scripts/install.sh", "scripts/docker-entrypoint.sh", "scripts/docker-nouride.sh"];
    const found = scripts.flatMap((name) =>
      readFileSync(join(ROOT, name), "utf8")
        .split("\n")
        .flatMap((line, index) => (!/^\s*#/.test(line) && line.includes("—") ? [`${name}:${index + 1}`] : [])),
    );
    expect(found).toEqual([]);
  });

  test("the built-in skills and the example pack", () => {
    const pages = files(join(ROOT, "content"), /\.md$/);
    expect(pages.length).toBeGreaterThan(30);
    expect(pages.flatMap(inMarkdown)).toEqual([]);
  });
});
