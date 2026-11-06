#!/usr/bin/env bun
/**
 * Keeps what would be published free of what is ours alone: real people's ids, the homelab's
 * addresses and names, a laptop's home directory.
 *
 * ## What "published" means here
 *
 * `publicFiles()` in `public-tree.ts`: every tracked file but `internals/` and the private submodules. Since
 * 2026-11-06 this repository is public itself (`nouverse/nouride`), so that is what anyone can read.
 *
 * ## Why the private values are hashed
 *
 * A check that lists the Telegram id it looks for publishes that id in the check. So the values are
 * kept as SHA-256: every run of digits, every `10.x` network prefix and every email domain in a
 * published file is hashed and compared. Found when a fixture carried the operator's real Telegram
 * id, a real phone number and three WhatsApp ids, beside the obviously fake ones.
 *
 * The hashes are not in this repository either. A phone number or a numeric id has few enough candidates that
 * hashing every one of them takes a GPU seconds, so a published hash is the published value (found by an audit,
 * 2026-10-29). They are in `internals/pro/publish-denylist.json`, which is never published. Where `internals/pro` is
 * not checked out — CI's `verify` job, the exported public tree — there is nothing to compare against, and the run
 * says so; `verify-private` and every checkout with the submodule compare them.
 *
 * To add a value: `printf '%s' <value> | shasum -a 256`, and an entry in that file saying what kind it is.
 *
 * ## Pointers to what the export leaves out
 *
 * A published file that sends its reader to a private document — a design note in a submodule's `docs/`, the
 * release plans, the improvement backlog, one of this repository's own agent skills — is a dead end once exported.
 * Fifty were found in 2026-10, most of them the memory modules citing their private design as their reasoning, which
 * an outside reader meets as "see a file you cannot have". So a published file names no private document: it says the
 * thing itself, or names the public doc that does. Private *code* is another matter — the build names the submodules
 * it checks out, and a public builder is told so — so only documents count: anything under an `internals/<repo>/docs`,
 * a Markdown file anywhere the export drops, a link into a path it drops, and a skill of this repository's own. A bare
 * file name counts when only private files carry it, which can be judged only where the submodules are checked out.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { sourceMapReferences } from "./build/source-map.ts";
import { publicFiles, ROOT } from "./public-tree.ts";

/** SHA-256 of a private value → what kind of value it is. Read from the private submodule, see above. */
export type Hashed = Readonly<Record<string, string>>;

const DENYLIST = join(ROOT, "internals/pro/publish-denylist.json");

/**
 * The deny-list at `path`, or `null` where it is not there. One that is there but is no deny-list is an error: read as
 * empty, it would match nothing and pass everything.
 */
export function readDenylist(path: string): Hashed | null {
  if (!existsSync(path)) return null;
  const list: unknown = JSON.parse(readFileSync(path, "utf8"));
  const entries = list !== null && typeof list === "object" && !Array.isArray(list) ? Object.entries(list) : [];
  const valid = entries.length > 0 && entries.every(([hash, what]) => /^[0-9a-f]{64}$/.test(hash) && typeof what === "string" && what !== "");
  if (!valid) throw new Error(`${path} is not a deny-list: an object of SHA-256 keys, each saying what kind of value it is`);
  return list as Hashed;
}

/** The private values' hashes; `null` where `internals/pro` is not checked out. What publishes refuses then. */
export const PRIVATE_VALUES: Hashed | null = readDenylist(DENYLIST);
/** Said wherever the private values go unchecked. */
export const UNCHECKED = "private values: not checked here — their hashes are in internals/pro, which is not checked out";

/** Plain patterns: nothing in them is private, only what they catch. */
const PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /\/Users\/[a-z][a-z0-9._-]+\//g, what: "a home directory" },
  { pattern: /\bNRD-[A-Z0-9]{4}-[0-9A-F]{4}-[0-9]{4}\b/g, what: "a Nouride Box serial" },
  { pattern: /\b(?:agent|lab|hub|staging)\.nouverse\b/g, what: "a homelab host" },
  { pattern: /\bpi-zero\b/g, what: "a homelab box name" },
];

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

interface Finding {
  file: string;
  line: number;
  what: string;
}

/** `denylist`: the private values' hashes — the submodule's by default; a test passes its own fakes'. */
function findingsIn(file: string, text: string, denylist: Hashed = PRIVATE_VALUES ?? {}): Finding[] {
  const found: Finding[] = [];
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  const hashed = (value: string, index: number) => {
    const what = denylist[sha(value)];
    if (what) found.push({ file, line: lineOf(index), what });
  };
  // Up to 20: a Discord snowflake is 17 to 20 digits, and a scan that stopped at 16 hashed only part of one.
  for (const m of text.matchAll(/\d{8,20}/g)) hashed(m[0], m.index!);
  // A LAN address names one install's network. Examples use 192.168.0.x, the one subnet left out.
  for (const m of text.matchAll(/\b192\.168\.(\d{1,3})\.\d{1,3}\b/g)) {
    if (m[1] !== "0") found.push({ file, line: lineOf(m.index!), what: "a LAN address (examples use 192.168.0.x)" });
  }
  for (const m of text.matchAll(/\b10\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g)) hashed(`10.${m[1]}`, m.index!);
  for (const m of text.matchAll(/@([a-z0-9-]+\.[a-z.]+)/gi)) hashed(m[1]!.toLowerCase(), m.index!);
  for (const { pattern, what } of PATTERNS) {
    for (const m of text.matchAll(pattern)) found.push({ file, line: lineOf(m.index!), what });
  }
  // A source map is the private source: `sourcesContent` carries every file the build read, Pro plugins included.
  // Each build writes one beside its tarball (`dist/`, gitignored) and `symbolize` caches them under `.cache/`
  // (gitignored); this is what stops one being committed and exported anyway.
  if (/\.map$/.test(file)) found.push({ file, line: 1, what: "a source map — private source, kept on the internal release only" });
  for (const m of text.matchAll(/\/\/[#@] sourceMappingURL=\S+/g)) {
    if (sourceMapReferences(m[0]).length > 0) found.push({ file, line: lineOf(m.index!), what: "a source map reference" });
  }
  return found;
}

/** What a pointer is judged against: which paths the export carries, and what the private half holds. */
export interface PrivateTree {
  published(rel: string): boolean;
  /** Tracked paths the export drops, the checked-out submodules' included, and every directory above each. */
  paths: Set<string>;
  /** Whether a name or a partial path — `<NAME>.md`, `references/tools.md` — ends only private documents' paths. */
  privateOnly(doc: string): boolean;
}

export async function privateTree(): Promise<PrivateTree> {
  const { files, left } = await publicFiles();
  const published = (rel: string): boolean => !left.some((dir) => rel.startsWith(dir) || `${rel}/` === dir);
  // A submodule's files without git's own variables: a commit hook sets `GIT_INDEX_FILE` to the superproject's index,
  // and the submodule's `ls-files` would read that one and list none of its own.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const ls = (cwd: string, own = process.env): string[] =>
    Bun.spawnSync(["git", "ls-files", "-z"], { cwd, env: own }).stdout.toString().split("\0").filter(Boolean);
  const hidden: string[] = [];
  for (const rel of ls(ROOT)) {
    if (published(rel)) continue;
    if (existsSync(join(ROOT, rel, ".git"))) hidden.push(...ls(join(ROOT, rel), env).map((sub) => `${rel}/${sub}`));
    else hidden.push(rel);
  }
  const paths = new Set<string>();
  for (const rel of hidden) for (let at = rel; at !== "."; at = dirname(at)) paths.add(at);
  const isDoc = (rel: string): boolean => /\.mdx?$/.test(rel);
  const privateDocs = hidden.filter(isDoc);
  const publicDocs = files.filter(isDoc);
  const ends = (rel: string, doc: string): boolean => rel === doc || rel.endsWith(`/${doc}`);
  const privateOnly = (doc: string): boolean => privateDocs.some((rel) => ends(rel, doc)) && !publicDocs.some((rel) => ends(rel, doc));
  return { published, paths, privateOnly };
}

/**
 * Published files that name the private tree because saying what it is is their job. Kept short on purpose: a pointer
 * that leads where the export does not go is fixed, not listed.
 */
const MAY_NAME_PRIVATE: Readonly<Record<string, string>> = {
  "scripts/public-tree.ts": "it is the list of what the export leaves out",
  "scripts/check-public.ts": "it is this check",
  "scripts/check-pointers.ts": "it reads the backlog and the release plans as records of their moment, by name",
  "scripts/pointers/editions.ts": "the files that map the editions' old names, the private ones among them",
  "apps/engine/tests/contracts/check-pointers.test.ts": "it holds which of the private tree's docs lint:pointers reads",
};

const PRIVATE_DOC_PATH = /(?<![\w./-])((?:internals\/[\w.-]+\/docs|docs\/tasks|docs\/archive)(?:\/[\w.@-]*)*|internals\/[\w./-]+\.mdx?)/g;
const SKILL_PATH = /(?<![\w./-])\.(?:agents|claude)\/skills\/([\w.-]+)/g;
/** A document's name, or a partial path to one. One that starts at a root of this repository is a path, judged above. */
const DOC_REF = /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.mdx?)(?![\w/-])/g;
const ROOTED = /^(?:apps|packages|scripts|docs|content|internals|\.agents|\.claude|\.github)\//;
const LINK = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)\)/g;
/** A lockfile names paths in the repositories it locks — `skills/daisyui/SKILL.md` upstream — not in this one. */
const LOCKFILE = /(?:^|\/)(?:[\w.-]+-)?lock\.(?:json|ya?ml)$|\.lock$/;

/** Every pointer in a published file that leads into what the export leaves out. */
export function privatePointers(file: string, text: string, tree: PrivateTree): Finding[] {
  if (file in MAY_NAME_PRIVATE || LOCKFILE.test(file)) return [];
  const found: Finding[] = [];
  const add = (index: number, what: string) => found.push({ file, line: text.slice(0, index).split("\n").length, what });
  for (const m of text.matchAll(PRIVATE_DOC_PATH)) add(m.index!, `\`${m[1]}\` — a private document`);
  for (const m of text.matchAll(SKILL_PATH)) {
    // A skill of this repository's, not the `.agents/skills/` an agent's working directory holds at runtime.
    if (tree.paths.has(`.agents/skills/${m[1]}`)) add(m.index!, `\`${m[0]}\` — this repository's own skill, which is private`);
  }
  for (const m of text.matchAll(DOC_REF)) {
    if (!ROOTED.test(m[1]!) && tree.privateOnly(m[1]!)) add(m.index!, `\`${m[1]}\` — a document only the private tree has`);
  }
  if (/\.mdx?$/.test(file)) {
    // Links in prose only: a link quoted in a code block or in backticks is an example, not one.
    const blank = (code: string): string => code.replace(/[^\n]/g, " ");
    const prose = text.replace(/^```[\s\S]*?^```/gm, blank).replace(/`[^`\n]+`/g, blank);
    for (const m of prose.matchAll(LINK)) {
      const target = m[1]!.split("#")[0]!;
      if (!target || /^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const rel = normalize(join(dirname(file), decodeURIComponent(target))).replace(/\/$/, "");
      if (!tree.published(rel)) add(m.index!, `a link to \`${rel}\`, which the export leaves out`);
    }
  }
  return found;
}

async function main(): Promise<void> {
  const { files, left } = await publicFiles();
  const tree = await privateTree();
  const findings: Finding[] = [];
  const pointers: Finding[] = [];
  for (const rel of files) {
    const file = Bun.file(join(ROOT, rel));
    if (!(await file.exists())) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.includes(0)) continue; // binary
    const text = new TextDecoder().decode(bytes);
    findings.push(...findingsIn(rel, text));
    pointers.push(...privatePointers(rel, text, tree));
  }

  if (!PRIVATE_VALUES) console.log(`- ${UNCHECKED}`);
  if (findings.length === 0 && pointers.length === 0) {
    console.log(`✓ nothing private in the published tree, and nothing in it points there (${files.length} files, ${left.length} private paths left out)`);
    return;
  }
  if (findings.length > 0) {
    console.log(`✗ ${findings.length} private value(s) in files that would be published:`);
    for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.what}`);
    console.log("\n  Replace it with an obviously fake one, or move the file under internals/.");
  }
  if (pointers.length > 0) {
    console.log(`✗ ${pointers.length} pointer(s) in published files to what the export leaves out:`);
    for (const f of pointers) console.log(`  ${f.file}:${f.line}  ${f.what}`);
    console.log("\n  Say the thing itself, or point at the published doc that says it.");
  }
  process.exit(1);
}

if (import.meta.main) await main();

export { findingsIn };
