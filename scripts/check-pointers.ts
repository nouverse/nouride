#!/usr/bin/env bun
/**
 * Every pointer in a comment or a doc still leads somewhere, and every doc comment sits on something.
 *
 * ## Why
 *
 * This repository keeps its reasoning in comments and in a handful of docs, and both point at each other
 * constantly: "see `modules/tools/mcp.ts`", "`tool-batching.ts` says why", "§6.3 of docs/SPEC.md". Each
 * reorganisation and each doc purge left some of those behind — the `modules/` move, the gateway channel
 * split, the build split, three deleted status documents, a deleted RFC whose sections were still cited by
 * number — and the 2026-10-16 audit found well over a hundred, every one of them a search the next reader
 * pays for. A manual sweep catches the pointers that name the thing that moved and misses the rest, so the
 * sweep is now a check.
 *
 * ## What it checks
 *
 * In the comments of every tracked source file (TypeScript and JavaScript through the parser, so a string
 * that happens to hold a path is not a pointer; shell, YAML and Dockerfiles by their `#` lines), and in the
 * whole text of the docs and skills:
 *
 * - **paths** — `apps/…`, `packages/…`, `scripts/…`, `docs/…` and the other repository roots name a tracked
 *   file or directory;
 * - **file names** — a bare file name ending `.ts`, `.tsx`, `.sql`, `.sh` or `.md` is the name of some tracked file;
 * - **`file:symbol`** — `turns.store.ts:inserted` names a file that contains that word;
 * - **no line numbers** — a file name followed by `:` and a line number is refused: lines drift with every edit
 *   above them, names do not;
 * - **sections** — `SPEC §6.3` and `§3 of docs/ARCHITECTURE.md` name a heading that doc has;
 * - **links** — a relative markdown link resolves, and its `#anchor` is a heading of the target (GitHub's
 *   slugs); a link into the site's docs as the site serves it, `/en/docs/…` or `https://nouride.com/en/docs/…`, in
 *   markdown or a component's `href`, names a page the site has and a heading of that page (the site's slugs);
 * - **commands** — `` `nouride <verb>` `` is a verb `cli/main.ts` dispatches, and a `nouride` line in a doc, a skill
 *   or a comment takes only the words and flags its command reads (`pointers/commands.ts`);
 * - **retired edition names** — the editions' names before 2026-09-30 appear only where they are mapped to the
 *   names now (`pointers/editions.ts`);
 * - **stacked doc blocks** — in `apps/*\/src`, `packages/*\/src` and `scripts/`, a `/** … *\/` followed by
 *   nothing but blank lines and then another one. TypeScript attaches only the nearest block to a
 *   declaration, so the first one describes nothing — and in every case the audit read, it described
 *   something that had moved or been deleted. A file's first block is its header and is exempt.
 *
 * ## What it does not check
 *
 * Whether a backticked identifier exists. Tried during the audit: the wire-format names, the SQL columns,
 * the config keys and the historical names a comment rightly mentions made a list where the real findings
 * were the minority, and a rule people learn to allowlist without reading stops being one. `file:symbol`
 * covers the case where a name is offered as a pointer.
 *
 * The docs are this repository's (not its release notes and plans), the site's pages, the nouride-* skills, and the
 * Pro docs, READMEs and code when `internals/pro` is checked out — not the register and the audit under its
 * `internals/pro/docs/rfc/`, which are records, quoting the file and line a finding was made at. The built-in skills in
 * `content/skills` are read for their `nouride` lines only: their paths are an install's, not this repository's.
 * Inside the Pro tree a path may also be read from Pro's root or from the package it is in.
 *
 * Paths into `internals/pro` and `internals/nougate` are checked only when that submodule is checked out —
 * a public clone does not have them, and a pointer that cannot be read cannot be judged. The same goes for a
 * bare file name that is not in the public tree while Pro is absent. Nougate is never a bare name's answer: it is
 * another product with its own repository, so a file of it is named by its path, which is judged when it is checked
 * out, and its own files are not read for pointers. A submodule that is not checked out is absent, so a pointer into it
 * is not judged either; nor is one into Nouride Home (`apps/android-appliance`), a related repository whose clone, where
 * there is one, this one ignores. Bare names therefore pass or fail the same with Nougate checked out or not — they used to be
 * judged only while it was, so a hook run with Pro alone passed what the full check failed.
 *
 * ## The ways this could pass while checking nothing
 *
 * An extractor that stops matching finds nothing and reports success, so a run that resolves implausibly few
 * pointers fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import ts from "typescript";
import { commandLines, commandProblem } from "./pointers/commands.ts";
import { retiredEditionLines, staleEditionMaps } from "./pointers/editions.ts";
import { PRIVATE } from "./public-tree.ts";

export const ROOT = new URL("../", import.meta.url).pathname;

export interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/** What the rules resolve against: the tracked files, and which parts of the tree cannot be judged here. */
export interface Index {
  files: Set<string>;
  dirs: Set<string>;
  byBase: Map<string, string[]>;
  /** Roots that exist in the repository but are not checked out, so nothing under them can be resolved. */
  absent: string[];
  verbs: Set<string>;
  /** Whether git ignores the path: a build output or a scratch directory is somewhere, just not tracked. */
  ignored(rel: string): boolean;
  read(rel: string): string | undefined;
}

/** Where a pointer may start. A token that starts anywhere else is a word, a URL or a runtime path. */
const ROOTS = ["apps", "packages", "scripts", "docs", "content", "internals", ".agents", ".claude", ".github", ".githooks"];

const PATH = new RegExp(`(?<![\\w./@:-])((?:${ROOTS.map((r) => r.replace(".", "\\.")).join("|")})/[\\w.@/$\\[\\]-]*[\\w\\]/-])`, "g");
const CODE_EXT = "ts|tsx|js|mjs|sql|sh|md|mdx";
// Not `.js` for a bare name: `discord.js`, `Node.js` and `Next.js` are libraries far more often than files.
const BARE = new RegExp(`(?<![\\w./@$<{-])([A-Za-z0-9_][\\w.-]*\\.(?:ts|tsx|sql|sh|md|mdx))(?![\\w/*<{-])`, "g");
const FILE_COLON = new RegExp(`(?<![\\w-])([\\w./@-]*[\\w-]\\.(?:${CODE_EXT})):(\\d+|[A-Za-z_$][\\w$]*)`, "g");
const SECTION = [
  /(?<![\w/])(?:docs\/)?([A-Z][A-Z_]{2,})(?:\.md)?`?\s*§\s*(\d+(?:\.\d+)*)/g,
  /§\s*(\d+(?:\.\d+)*)\s+(?:of|in)\s+`?(?:docs\/)?([A-Z][A-Z_]{2,})(?:\.md)?/g,
];
const LINK = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)\)/g;
/** A component's link in an `.mdx` page, `<LinkCard href="/en/docs/…" />`: read for links into the site only. */
const HREF = /\bhref="([^"]+)"/g;
/**
 * A link into the site's docs: its language, its page and its anchor. Unchecked until 2026-11-05, when the 399 in the
 * site's own pages were read by hand and all still led somewhere; a page renamed would have broken them silently.
 */
const SITE_LINK = /^(?:https:\/\/nouride\.com)?\/(en|id)\/docs\/([^#?]*)(?:#(.+))?$/;
const SITE_DOCS = "apps/site/src/content/docs";
const VERB = /`nouride ([a-z][a-z-]*)\b/g;

/**
 * Names that look like pointers and are not, each with why. Kept short on purpose: a pointer that no longer
 * resolves is fixed, not listed.
 */
export const NOT_POINTERS: Readonly<Record<string, string>> = {
  "routeTree.gen.ts": "generated by the router plugin, gitignored",
  "apps/backend": "Nougate's layout, in its own repository",
  "apps/frontend": "Nougate's layout, in its own repository",
  "apps/docs": "what `apps/site` was called, named where the rename is explained",
  "packages/core": "a package this repository decided not to have, named where ARCHITECTURE says why",
  "docs/OAUTH_PROVIDER.md": "in the Nouverse service's repository, not this one",
  "SKILL.md": "the name of every skill's file, an agent's included",
  "AGENTS.md": "a file an agent pack or a workspace may hold, read at runtime",
  "CLAUDE.md": "a file a workspace may hold, read at runtime",
  "MEMORY.md": "a file in an agent's memory directory, at runtime",
  "report.md": "the file a mission's report is sent to its chat as, built from its text at runtime (0.8.11)",
  "Gate.md": "an example of a file someone sends in a chat, and how it is stored (attachments' sentName, 0.8.20)",
  "170748-2c91-01-Gate.md": "that example's name as the attachment store keeps it, at runtime (0.8.20)",
  "BRIEF.md": "a mission's brief, written into its own folder at runtime when it is drafted (0.8.11)",
  "_RFC.md": "the end of a release's RFC's name, `v<version>_RFC.md`, a pattern in the nouride-release-rfc skill (0.8.17)",
  "_SHIPPED.md": "the end of the name a topic RFC's shipped part is archived under, a pattern in the nouride-release-rfc skill",
  "USER.md": "a file in an agent's memory directory, at runtime",
  "IDENTITY.md": "a persona file, in an agent pack at runtime",
  "SOUL.md": "a persona file, in an agent pack at runtime",
  "HEARTBEAT.md": "a file an agent keeps in its workspace, at runtime",
  "Bun.sql": "Bun's SQL API, not a file",
  "index.ts": "a directory's entry point, named generically",
  "foo.ts": "an example",
  "shared.md": "the shared memory file, in an install's vault",
  "notes.md": "an example file an agent reads",
  "deploy.sh": "an example script an approval is bound to",
  "script.sh": "an example script",
  "skills.sh": "the skills registry's site, not a file",
  "YYYY-MM-DD-HHMM.md": "the name pattern of a captured transcript",
  "nouva.v2.md": "a persona file in an imported vault",
  "x.ts": "an example",
  "scripts/publish.py": "an example script a secret is bound to, in an agent's workspace",
  "apps/admin": "the Nouverse service's admin app, in that repository",
  "appliances.releases.service.ts": "in the Nouverse service's repository, not this one",
  "appliances.factory.controller.ts": "in the Nouverse service's repository, not this one",
  "appliances.admin.controller.ts": "in the Nouverse service's repository, not this one",
};

/**
 * Other products' trees: judged by path when they are checked out, never the answer to a bare file name, and their own
 * files not read for pointers, which are to their own repository's paths: Nougate.
 */
const OTHER_PRODUCTS = ["internals/nougate/"];

/**
 * Related repositories cloned at a path of this tree, which ignores them: Nouride Home, the Android app, a submodule
 * from 2026-11-07 to 2026-11-08 (the owner: its own repository, linked from the README). Always absent, clone or not:
 * a pointer into one names that repository's path, which this tree cannot judge.
 */
const ELSEWHERE = ["apps/android-appliance/"];
const otherProduct = (rel: string): boolean => OTHER_PRODUCTS.some((dir) => rel.startsWith(dir));

/**
 * Whether git ignores `rel`: a build output or a scratch directory is somewhere, just not tracked. Asked as a
 * directory too — `dist/` matches only a directory, and one not built yet is not a directory to git, so a fresh
 * clone failed on `apps/dashboard/dist` while a clone that had built the dashboard passed.
 */
export function isIgnored(root: string, rel: string): boolean {
  return Bun.spawnSync(["git", "check-ignore", "--no-index", rel, `${rel}/`], { cwd: root }).exitCode === 0;
}


/** The directories `files` make, and each file by its bare name — Nougate's left out of the second (see the header). */
export function indexOf(files: Iterable<string>): { dirs: Set<string>; byBase: Map<string, string[]> } {
  const dirs = new Set<string>();
  const byBase = new Map<string, string[]>();
  for (const file of files) {
    for (let dir = dirname(file); dir !== "."; dir = dirname(dir)) dirs.add(dir);
    if (otherProduct(file)) continue;
    const base = basename(file);
    byBase.set(base, [...(byBase.get(base) ?? []), file]);
  }
  return { dirs, byBase };
}

/** Tracked files, the submodules' too when they are checked out. */
export function buildIndex(root = ROOT): Index {
  // Without git's own variables: a commit hook runs with `GIT_INDEX_FILE` set to the superproject's index, and a
  // submodule's `ls-files` would read that one and list none of its own files.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const ls = (cwd: string): string[] => Bun.spawnSync(["git", "ls-files", "-z"], { cwd, env }).stdout.toString().split("\0").filter(Boolean);
  // A submodule's entry, checked out or not: one that is not (Pro's CI has no Android app) is absent, not a file.
  const gitlinks = new Set(
    Bun.spawnSync(["git", "ls-files", "-s", "-z"], { cwd: root, env }).stdout.toString().split("\0")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.slice(line.indexOf("\t") + 1)),
  );
  const files = new Set<string>();
  const absent: string[] = [];
  for (const rel of ls(root)) {
    if (existsSync(join(root, rel, ".git")) || gitlinks.has(rel) || (rel.startsWith("internals/") && !rel.includes("/", "internals/".length))) {
      if (existsSync(join(root, rel, "package.json")) || existsSync(join(root, rel, ".git"))) for (const sub of ls(join(root, rel))) files.add(`${rel}/${sub}`);
      else absent.push(`${rel}/`);
      continue;
    }
    files.add(rel);
  }
  // In the public export the private paths are not there at all, not even as a submodule's entry: a pointer into one
  // cannot be checked there, and `check-public` already decides which of them a published file may name.
  for (const dir of PRIVATE) if (![...files].some((rel) => rel.startsWith(dir)) && !absent.includes(dir)) absent.push(dir);
  for (const dir of ELSEWHERE) if (!absent.includes(dir)) absent.push(dir);
  const { dirs, byBase } = indexOf(files);
  const main = readFileSync(join(root, "apps/engine/src/cli/main.ts"), "utf8");
  const verbs = new Set([...main.matchAll(/^\s*case "([a-z][a-z-]*)":/gm)].map((m) => m[1]!));
  return {
    files,
    dirs,
    byBase,
    absent,
    verbs,
    ignored: (rel) => isIgnored(root, rel),
    read: (rel) => (files.has(rel) && existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : undefined),
  };
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;
const unverifiable = (index: Index, rel: string): boolean => index.absent.some((dir) => rel.startsWith(dir) || `${rel}/` === dir);

/** Comments of a TypeScript or JavaScript file, through the parser: a string holding `/**` is not one. */
export function commentsOf(fileName: string, text: string): { pos: number; end: number; text: string }[] {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.jsx?$|\.mjs$|\.cjs$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const seen = new Map<number, { pos: number; end: number; text: string }>();
  const take = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) if (!seen.has(r.pos)) seen.set(r.pos, { pos: r.pos, end: r.end, text: text.slice(r.pos, r.end) });
  };
  const visit = (node: ts.Node): void => {
    take(ts.getLeadingCommentRanges(text, node.pos));
    take(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  take(ts.getLeadingCommentRanges(text, source.endOfFileToken.pos));
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/** `#` comments of a shell script, a workflow or a Dockerfile — whole lines and trailing ones. */
export function hashCommentsOf(text: string): { pos: number; end: number; text: string }[] {
  const out: { pos: number; end: number; text: string }[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const at = line.search(/(^|\s)#(?![!{])/);
    if (at >= 0) out.push({ pos: offset + at, end: offset + line.length, text: line.slice(at) });
    offset += line.length + 1;
  }
  return out;
}

/**
 * Lines of every doc block that sits directly on another one, or on the end of the file.
 *
 * Only blank lines between them: a block followed by code, a `//` line or anything else is attached to that.
 */
export function stackedDocBlocks(fileName: string, text: string): number[] {
  const docs = commentsOf(fileName, text).filter((c) => c.text.startsWith("/**"));
  const out: number[] = [];
  // The first block is the file's header, wherever the imports put it, and is followed by the first declaration's doc.
  for (let i = 1; i < docs.length; i++) {
    const doc = docs[i]!;
    const next = docs[i + 1];
    const after = text.slice(doc.end, next ? next.pos : text.length);
    if (after.trim() === "") out.push(lineAt(text, doc.pos));
  }
  return out;
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const headings = (markdown: string): string[] =>
  [...markdown.replace(/^```[\s\S]*?^```/gm, "").matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]!);

/** Where a path written in `from` may be read from: the root, and inside Pro also Pro's root and the package it is in. */
function bases(from: string): string[] {
  const pro = /^(internals\/pro\/)(packages\/[^/]+\/)?/.exec(from);
  return pro ? ["", pro[1]!, ...(pro[2] ? [`${pro[1]}${pro[2]}`] : [])] : [""];
}

function resolvesPath(index: Index, rel: string, from = ""): boolean {
  const clean = normalize(rel).replace(/\/$/, "");
  if (clean in NOT_POINTERS || unverifiable(index, clean)) return true;
  if (bases(from).some((base) => index.files.has(`${base}${clean}`) || index.dirs.has(`${base}${clean}`))) return true;
  return index.ignored(clean);
}

/** The file a `name.ext` or `dir/name.ext` token means, or undefined when nothing tracked is called that. */
function candidates(index: Index, token: string): string[] {
  if (index.files.has(token)) return [token];
  const base = basename(token);
  return (index.byBase.get(base) ?? []).filter((file) => file.endsWith(`/${token}`) || file === token || !token.includes("/"));
}

/**
 * Every pointer in `text` that does not lead anywhere. `text` is a comment or a whole doc; `offset` places
 * its lines in the file; `from` is the file it is in, for relative links.
 */
export function pointerProblems(index: Index, text: string, from: string, offset = 0, whole = text): Finding[] {
  const out: Finding[] = [];
  const add = (at: number, rule: string, detail: string): void => {
    out.push({ file: from, line: lineAt(whole, offset + at), rule, detail });
  };
  const someAbsent = index.absent.some((dir) => !OTHER_PRODUCTS.includes(dir));

  for (const m of text.matchAll(PATH)) {
    const token = m[1]!.replace(/[.\]]+$/, "");
    const next = text[m.index! + m[0].length] ?? "";
    if (/[*<{]/.test(next) || /[*<>{}$]/.test(token) || token.includes("…")) continue;
    if (!resolvesPath(index, token, from)) add(m.index!, "path", `\`${token}\` is not a tracked file or directory`);
  }

  for (const m of text.matchAll(BARE)) {
    const token = m[1]!;
    if (token in NOT_POINTERS || /^\d{3}_/.test(token) || index.byBase.has(token)) continue;
    if (someAbsent) continue;
    add(m.index!, "file-name", `no tracked file is called \`${token}\``);
  }

  for (const m of text.matchAll(FILE_COLON)) {
    const [, file, target] = m as unknown as [string, string, string];
    if (/^\d+$/.test(target)) {
      // `file:line:col` is a position a tool printed — a stack frame, `symbolize`'s answer, a compiler error — quoted
      // as output, not a pointer someone wrote to send a reader there.
      if (/^:\d+/.test(text.slice(m.index! + m[0].length))) continue;
      add(m.index!, "line-number", `\`${file}:${target}\` — name the function or the section instead; lines move`);
      continue;
    }
    const found = candidates(index, file.replace(/^\.?\//, ""));
    if (found.length === 0) continue; // the path and file-name rules report it, once
    const texts = found.map((f) => index.read(f)).filter((t): t is string => t !== undefined);
    if (texts.length > 0 && !texts.some((t) => new RegExp(`\\b${target.replace(/\$/g, "\\$")}\\b`).test(t))) {
      add(m.index!, "file-symbol", `\`${file}\` has no \`${target}\``);
    }
  }

  for (const [i, re] of SECTION.entries()) {
    for (const m of text.matchAll(re)) {
      const [doc, section] = i === 0 ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      const markdown = bases(from).map((base) => index.read(`${base}docs/${doc}.md`)).find((text) => text !== undefined);
      if (markdown === undefined) continue;
      const has = headings(markdown).some((h) => new RegExp(`^(?:§\\s*)?${section.replace(/\./g, "\\.")}(?:[.\\s:)]|$)`).test(h));
      if (!has) add(m.index!, "section", `docs/${doc}.md has no §${section}`);
    }
  }

  for (const m of text.matchAll(VERB)) {
    if (!index.verbs.has(m[1]!)) add(m.index!, "command", `\`nouride ${m[1]}\` is not a command cli/main.ts dispatches`);
  }
  return out;
}

/** The file a site page is served from: `start/install/` is `start/install.md` or `.mdx`, or that folder's `index`. */
function sitePage(index: Index, lang: string, page: string): string | undefined {
  const base = `${SITE_DOCS}/${lang}/docs/${page.replace(/\/+$/, "")}`;
  return [".md", ".mdx", "/index.md", "/index.mdx"].map((end) => base + end).find((file) => index.files.has(file));
}

/**
 * A site page's anchors, as the site makes them: every heading, one in a list item or an indented block too (the site
 * renders those, and GitHub's rule above reads column 0 only), slugged as GitHub does, a repeat numbered `-1`, `-2`;
 * and `_top`, the page's title. A line of a fenced block, indented with its list item or not, is code.
 */
export function siteAnchors(markdown: string): Set<string> {
  const anchors = new Set(["_top"]);
  const repeats = new Map<string, number>();
  let code = false;
  for (const line of markdown.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) code = !code;
    const heading = code ? undefined : /^\s*(?:(?:[-*+]|\d+[.)])\s+)?#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = slug(heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, ""));
    const seen = repeats.get(base) ?? 0;
    repeats.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

/** What is wrong with a link into the site's docs (`SITE_LINK`), or nothing. */
function siteLinkProblem(index: Index, [, lang, page, anchor]: RegExpExecArray): { rule: string; detail: string } | undefined {
  const file = sitePage(index, lang!, page!);
  if (!file) return { rule: "link", detail: `the site has no such page (${SITE_DOCS}/${lang}/docs/${page!.replace(/\/+$/, "")})` };
  if (anchor && !siteAnchors(index.read(file) ?? "").has(decodeURIComponent(anchor).toLowerCase())) return { rule: "anchor", detail: `${file} has no such heading` };
  return undefined;
}

/** Links in a markdown file, and their anchors: relative ones as files, and links into the site's docs as its pages. */
export function linkProblems(index: Index, markdown: string, from: string): Finding[] {
  const out: Finding[] = [];
  // Fenced blocks and inline code are examples, not links: `[![alt](img)` quoted in a sentence goes nowhere on purpose.
  const blank = (code: string): string => code.replace(/[^\n]/g, " ");
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, blank).replace(/`[^`\n]+`/g, blank);
  for (const m of prose.matchAll(HREF)) {
    const site = SITE_LINK.exec(m[1]!);
    const problem = site && siteLinkProblem(index, site);
    if (problem) out.push({ file: from, line: lineAt(markdown, m.index!), rule: problem.rule, detail: `\`${m[1]}\` — ${problem.detail}` });
  }
  for (const m of prose.matchAll(LINK)) {
    const target = m[1]!;
    const site = SITE_LINK.exec(target);
    if (site) {
      const problem = siteLinkProblem(index, site);
      if (problem) out.push({ file: from, line: lineAt(markdown, m.index!), rule: problem.rule, detail: `\`${target}\` — ${problem.detail}` });
      continue;
    }
    // `@@TARBALL_BASE@@/…` is filled in when the site is built.
    if (/^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("@@")) continue;
    const [path, anchor] = target.split("#") as [string, string | undefined];
    const rel = path === "" ? from : normalize(join(dirname(from), decodeURIComponent(path))).replace(/\/$/, "");
    if (unverifiable(index, rel)) continue;
    const line = lineAt(markdown, m.index!);
    if (!index.files.has(rel) && !index.dirs.has(rel)) {
      out.push({ file: from, line, rule: "link", detail: `\`${target}\` — no such file` });
      continue;
    }
    if (anchor && rel.endsWith(".md")) {
      const doc = index.read(rel) ?? "";
      if (!headings(doc).some((h) => slug(h) === anchor.toLowerCase())) out.push({ file: from, line, rule: "anchor", detail: `\`${target}\` — ${rel} has no such heading` });
    }
  }
  return out;
}

/**
 * The docs read whole. Release notes, execution plans, the RFCs and what 0.7.x archived — the review and the debt
 * register — are records of their moment and are not: a finding quotes the file and line it was found at, on the day
 * it was found, and a pointer to something since deleted is often the finding itself.
 */
export function isDoc(rel: string): boolean {
  if (/^docs\/(?:releases|tasks|archive)\//.test(rel) || rel.startsWith("internals/pro/docs/rfc/") || rel.startsWith("internals/pro/docs/archive/")) return false;

  return (
    /^docs\/[^/]+\.md$/.test(rel) ||
    /^docs\/contracts\/[^/]+\.md$/.test(rel) ||
    ["README.md", "GETTING_STARTED.md", "config.example.toml", ".env.example", "content/agents/README.md"].includes(rel) ||
    /^packages\/[^/]+\/README\.md$/.test(rel) ||
    /^\.agents\/skills\/nouride-[^/]+\/.+\.md$/.test(rel) ||
    /^apps\/site\/src\/content\/docs\/.+\.mdx?$/.test(rel) ||
    /^internals\/pro\/(?:docs\/)?[^/]+\.md$/.test(rel) ||
    /^internals\/pro\/.+\/README\.md$/.test(rel)
  );
}

const isScript = (rel: string): boolean => /\.(?:ts|tsx|js|mjs|cjs)$/.test(rel) && !rel.endsWith(".d.ts.map");
const isHashed = (rel: string): boolean =>
  /\.sh$/.test(rel) || /^\.github\/workflows\/.+\.ya?ml$/.test(rel) || /^\.githooks\//.test(rel) || /(^|\/)Dockerfile$/.test(rel) || /^docker-compose.*\.ya?ml$/.test(rel);
const isCode = (rel: string): boolean => /^(?:apps|packages|scripts|internals\/pro)\//.test(rel);
/** The built-in skills an install ships: read for their `nouride` lines, the only part of them about this repository. */
const isShippedSkill = (rel: string): boolean => /^content\/skills\/.+\.md$/.test(rel);

/** Each `nouride` line of `text` the CLI would refuse. A span's unknown verb is the pointer rule's, said once. */
function commandFindings(index: Index, text: string, from: string, markdown: boolean, offset = 0, whole = text): Finding[] {
  return commandLines(text, markdown).flatMap((line) => {
    if (text[line.at] === "`" && !index.verbs.has(line.verb)) return [];
    const problem = commandProblem(line, index.verbs);
    return problem ? [{ file: from, line: lineAt(whole, offset + line.at), rule: "command", detail: problem }] : [];
  });
}

const retired = (rel: string, text: string): Finding[] =>
  retiredEditionLines(rel, text).map((line) => ({
    file: rel,
    line,
    rule: "retired-edition",
    detail:
      "an edition's old name — say basic, router or pro; a file that maps the old names to the new ones goes in " +
      "MAPS_RETIRED_EDITIONS (scripts/pointers/editions.ts), with why",
  }));
const holdsDocBlocks = (rel: string): boolean => /^(?:apps|packages)\/[^/]+\/src\//.test(rel) || /^scripts\//.test(rel);

export function check(index: Index, root = ROOT): { findings: Finding[]; pointers: number } {
  const findings: Finding[] = [];
  let pointers = 0;
  for (const rel of [...index.files].sort()) {
    if (rel.includes("/node_modules/") || otherProduct(rel)) continue;
    const doc = isDoc(rel);
    const code = isCode(rel) && isScript(rel);
    const hashed = isHashed(rel);
    const skill = isShippedSkill(rel);
    if (!doc && !code && !hashed && !skill) continue;
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    findings.push(...retired(rel, text));
    if (skill) {
      findings.push(...commandFindings(index, text, rel, true));
      continue;
    }
    if (doc) {
      pointers += [...text.matchAll(PATH)].length;
      findings.push(...pointerProblems(index, text, rel), ...commandFindings(index, text, rel, /\.mdx?$/.test(rel)));
      if (/\.mdx?$/.test(rel)) findings.push(...linkProblems(index, text, rel));
      continue;
    }
    const comments = code ? commentsOf(rel, text) : hashCommentsOf(text);
    for (const comment of comments) {
      pointers += [...comment.text.matchAll(PATH)].length;
      findings.push(...pointerProblems(index, comment.text, rel, comment.pos, text), ...commandFindings(index, comment.text, rel, false, comment.pos, text));
    }
    if (code && holdsDocBlocks(rel) && !/\.(?:test|spec)\.tsx?$/.test(rel)) {
      for (const line of stackedDocBlocks(rel, text)) {
        findings.push({ file: rel, line, rule: "stacked-doc", detail: "a doc block on another doc block (or on nothing) describes nothing — move it onto its declaration, merge it, or delete it" });
      }
    }
  }
  for (const rel of staleEditionMaps(index.read, index.absent)) {
    findings.push({ file: rel, line: 0, rule: "retired-edition", detail: "listed in MAPS_RETIRED_EDITIONS and names no old edition any more — remove its entry" });
  }
  return { findings, pointers };
}

/** Fewer pointers than this means the extractor stopped matching, not that the tree has none. */
const FLOOR = 500;

if (import.meta.main) {
  const index = buildIndex();
  const { findings, pointers } = check(index);
  if (pointers < FLOOR) {
    console.error(`✗ only ${pointers} path pointers read — the extractor is broken, not the tree clean (floor ${FLOOR})`);
    process.exit(1);
  }
  if (findings.length > 0) {
    console.error(`✗ ${findings.length} pointer(s) that lead nowhere:\n`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.detail}`);
    console.error(
      `\nFix the pointer to where the thing lives now, or say the thing itself instead of pointing at it.` +
        `\nA name that is not a pointer (an example, a runtime file) goes in NOT_POINTERS in scripts/check-pointers.ts, with why.`,
    );
    process.exit(1);
  }
  const skipped = index.absent.length > 0 ? ` (not checked out, so not judged: ${index.absent.join(", ")})` : "";
  console.log(`✓ ${pointers} path pointers and every link, section, command and doc block lead somewhere${skipped}`);
}
