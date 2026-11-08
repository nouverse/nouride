#!/usr/bin/env bun
/**
 * No engine domain imports another it did not import when the rule began, unless the link is added with its reason.
 *
 * A domain is a folder of `apps/engine/src/modules/`. Nothing held the imports between them, and every feature that
 * needed something from next door imported it: 134 links among 32 domains, 24 pairs both ways, `web` reaching 28 of the
 * others and `tools` 19. A link both ways is a cycle, and a cycle is a change to one domain that breaks the other with no
 * sign at either's door. A folder outside `modules/` is not a domain: `commons/` is there to be shared, and `boot/`
 * wires the domains together on purpose.
 *
 * Every import counts: a value or a type, static or `import(…)`, by the `@/modules/` alias or by a relative path that
 * climbs into another domain's folder. Read by TypeScript's own import scanner (`preProcessFile`), which skips comments
 * and strings, rather than a pattern over the text.
 *
 * ## The ratchet
 *
 * The links at the start are recorded in `domain-links.ts` as found. A link not there is refused, at each import that
 * makes it, until it is taken away (handed in through a port at boot, or moved to `commons/`) or added to
 * `LINKS_ADDED` with the reason. A recorded link nothing makes any more is refused too, so it leaves the list and
 * cannot come back unseen.
 */

import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { MAX_WHY } from "./check-size.ts";
import { LINKS_ADDED, LINKS_AT_START } from "./domain-links.ts";

const ROOT = new URL("../", import.meta.url).pathname;

/** Where the domains are: each folder here is one. */
const MODULES = "apps/engine/src/modules/";

/** The alias every engine file may reach a domain by. */
const ALIAS = "@/modules/";

/** An import from one domain into another: where it is, what it names, and the domain it reaches. */
interface Link {
  line: number;
  specifier: string;
  to: string;
}

interface Finding {
  file: string;
  line: number;
  rule: "domain-link-new" | "domain-link-gone" | "domain-link-why";
  detail: string;
}

/** The domain a file of `apps/engine/src/modules/` belongs to: the folder under it. */
const domainOf = (rel: string): string => rel.slice(MODULES.length).split("/")[0]!;

/** The imports in `text`, the file `rel` of one domain, that reach another. */
export function domainLinks(rel: string, text: string): Link[] {
  const from = domainOf(rel);
  const links: Link[] = [];
  for (const { fileName: specifier, pos } of ts.preProcessFile(text, true, true).importedFiles) {
    let target: string;
    if (specifier.startsWith(ALIAS)) target = specifier.slice(ALIAS.length);
    else if (specifier.startsWith(".")) target = relative(MODULES, join(dirname(rel), specifier));
    else continue;
    if (target.startsWith("..")) continue;
    const to = target.split("/")[0]!.replace(/\.tsx?$/, "");
    if (to === from) continue;
    links.push({ line: text.slice(0, pos).split("\n").length, specifier, to });
  }
  return links;
}

/** `from → to`, the way a link is written in the table and in a finding. */
const pair = (from: string, to: string) => `${from} → ${to}`;

/** What the links found say against the table: each new one at every import that makes it, and each recorded one gone. */
export function linkFindings(
  found: ReadonlyMap<string, readonly Link[]>,
  atStart: Readonly<Record<string, readonly string[]>> = LINKS_AT_START,
  added: Readonly<Record<string, string>> = LINKS_ADDED,
): Finding[] {
  const recorded = new Set([...Object.entries(atStart).flatMap(([from, tos]) => tos.map((to) => pair(from, to))), ...Object.keys(added)]);
  const made = new Set<string>();
  const findings: Finding[] = [];
  for (const [file, links] of found) {
    const from = domainOf(file);
    for (const { line, specifier, to } of links) {
      made.add(pair(from, to));
      if (recorded.has(pair(from, to))) continue;
      findings.push({
        file,
        line,
        rule: "domain-link-new",
        detail:
          `"${specifier}": \`${from}\` importing \`${to}\` is a link the domains did not have. Hand \`${from}\` what it needs ` +
          `through a port at boot, or move what both need to commons/; else add "${pair(from, to)}" to \`LINKS_ADDED\` ` +
          `(scripts/domain-links.ts) with the reason ${from} needs ${to}`,
      });
    }
  }
  for (const link of recorded) {
    if (made.has(link)) continue;
    findings.push({ file: "scripts/domain-links.ts", line: 0, rule: "domain-link-gone", detail: `"${link}" is recorded and nothing makes it any more: remove it, or it could come back unseen` });
  }
  for (const [link, why] of Object.entries(added)) {
    if (why.trim() !== "" && why.length <= MAX_WHY) continue;
    findings.push({ file: "scripts/domain-links.ts", line: 0, rule: "domain-link-why", detail: `"${link}" in \`LINKS_ADDED\` has a reason of ${why.length} characters; say why ${link.replace(" → ", " needs ")}, in 1 to ${MAX_WHY}` });
  }
  return findings;
}

/** Every link between the domains in the tree at `root`, by the file that makes it, and what the table says of them. */
export async function checkDomains(
  root: string,
  atStart: Readonly<Record<string, readonly string[]>> = LINKS_AT_START,
  added: Readonly<Record<string, string>> = LINKS_ADDED,
): Promise<{ files: number; links: number; findings: Finding[] }> {
  const found = new Map<string, Link[]>();
  let files = 0;
  for await (const rel of new Bun.Glob(`${MODULES}**/*.{ts,tsx}`).scan({ cwd: root })) {
    files += 1;
    const links = domainLinks(rel, await Bun.file(join(root, rel)).text());
    if (links.length > 0) found.set(rel, links);
  }
  const pairs = new Set([...found].flatMap(([file, links]) => links.map((link) => pair(domainOf(file), link.to))));
  return { files, links: pairs.size, findings: linkFindings(found, atStart, added) };
}

async function main(): Promise<void> {
  const { files, links, findings } = await checkDomains(ROOT);
  if (findings.length === 0) {
    console.log(`✓ ${links} links between the engine's domains, every one recorded (${files} files)`);
    return;
  }
  console.error(`✗ ${findings.length} finding(s):\n`);
  for (const f of findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)) {
    console.error(`  ${f.file}${f.line > 0 ? `:${f.line}` : ""}  [${f.rule}]`);
    console.error(`    ${f.detail}\n`);
  }
  process.exit(1);
}

if (import.meta.main) await main();
