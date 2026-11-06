#!/usr/bin/env bun
/**
 * What the two release pages say: the internal repository's, and the public mirror's.
 *
 *   bun run scripts/release/release-notes.ts --tag v0.7.9 --previous v0.7.8 \
 *     --repo nouverse/nouride-legacy --public-repo nouverse/nouride \
 *     --internal /tmp/release-notes-internal.md --public /tmp/release-notes-public.md [--require-private-values]
 *
 * `docs/releases/<tag>.md` from the tagged tree, when it is there: the notes written for the people who install the
 * release, the same text on both pages. Both bodies used to be the commit subjects since the previous tag, and v0.7.8's
 * named a private host — so the public page carried it until the body was replaced by hand, which every release
 * since had needed anyway, to put the written notes there instead.
 *
 * Without the file, the subjects are still the floor, as before: on the internal page all of them, and on the public
 * page only those that name nothing `check-public.ts` calls private. A file in the published tree is held to that by
 * `lint:public` already; a commit subject never was.
 *
 * Private means the plain patterns and, with `internals/pro` checked out, the hashed private values beside them. Which
 * of the two it held the public page to is said first, every run; `--require-private-values`, which the release job
 * passes, refuses to write either page without the hashed list (HARDENING §3).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findingsIn, PRIVATE_VALUES, UNCHECKED, type Hashed } from "../check-public.ts";
import { parseNotes } from "./release-floor.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

export interface ReleaseBodiesInput {
  tag: string;
  /** The tag before it, or null for the first release. */
  previous: string | null;
  /** The internal repository and the public mirror, as `owner/name`. */
  repo: string;
  publicRepo: string;
  /** `docs/releases/<tag>.md` in the tagged tree, or null when the release has no notes of its own. */
  notes: string | null;
  /** The subjects of the commits since `previous`, merges left out — read only when there are no notes. */
  subjects: readonly string[];
}

export interface ReleaseBodies {
  internal: string;
  public: string;
  /** Subjects left off the public page because they name something private. */
  withheld: number;
}

/**
 * How Pro is sold and licensed is not the notes' to say: they are a product's changelog, read on the public mirror.
 * 0.8.2's and 0.8.3's put the licence link's template and the licensing mechanics there. Each term here leaked once;
 * the rule they stand for is in the writing rules (`nouride-contributing`, "Release notes").
 */
const LICENSING: readonly { what: string; pattern: RegExp }[] = [
  { what: "a licence's install link", pattern: /licenses\/nouride/i },
  { what: "a licence's identity file", pattern: /--identity\b|device\.json/i },
  { what: "the update gate", pattern: /update gate/i },
  { what: "Nouverse's admin", pattern: /Nouverse's admin|admin licen[cs]es/i },
];

/** Where the notes tell how Pro is licensed, as `line N, what`. */
export function licensingIn(notes: string): string[] {
  const found: string[] = [];
  notes.split("\n").forEach((line, index) => {
    for (const term of LICENSING) if (term.pattern.test(line)) found.push(`line ${index + 1}, ${term.what}`);
  });
  return found;
}

/** A notes file already ending in its own compare link keeps it, on both pages: it was written for the public one. */
const ENDS_WITH_CHANGELOG = /(^|\n)\*\*Full Changelog\*\*:[^\n]*$/;

/** Throws when the notes themselves name something private: the public page is not where that is found out. */
export function releaseBodies(input: ReleaseBodiesInput): ReleaseBodies {
  const compare = (repo: string) =>
    input.previous ? `**Full Changelog**: https://github.com/${repo}/compare/${input.previous}...${input.tag}` : null;
  const page = (lines: readonly string[], repo: string) => {
    const link = compare(repo);
    return `${[lines.join("\n"), link].filter(Boolean).join("\n\n")}\n`;
  };

  if (input.notes !== null) {
    const leaks = findingsIn(`docs/releases/${input.tag}.md`, input.notes);
    if (leaks.length > 0) {
      throw new Error(`docs/releases/${input.tag}.md names something private: ${leaks.map((f) => `line ${f.line}, ${f.what}`).join("; ")}`);
    }
    const told = licensingIn(input.notes);
    if (told.length > 0) {
      throw new Error(`docs/releases/${input.tag}.md tells how Pro is licensed — notes say what changed for whoever installs it: ${told.join("; ")}`);
    }
    // Without its front matter: the upgrade floor is for the checksum files (`release-floor.ts`), not the page.
    const text = parseNotes(input.notes).body.trimEnd();
    if (ENDS_WITH_CHANGELOG.test(text)) return { internal: `${text}\n`, public: `${text}\n`, withheld: 0 };
    return { internal: page([text], input.repo), public: page([text], input.publicRepo), withheld: 0 };
  }

  if (!input.previous) return { internal: "First release.\n", public: "First release.\n", withheld: 0 };

  // The version bump says nothing the tag does not.
  const listed = input.subjects.filter((subject) => !subject.startsWith("chore(release)"));
  const shown = listed.filter((subject) => findingsIn("a commit subject", subject).length === 0);
  return {
    internal: page(listed.map((subject) => `- ${subject}`), input.repo),
    public: page(shown.map((subject) => `- ${subject}`), input.publicRepo),
    withheld: listed.length - shown.length,
  };
}

/** Which list the public page is held to, said either way — and whether that is enough, when the hashed list is required. */
export function privateValuesHeld(values: Hashed | null, required: boolean): { ok: boolean; line: string } {
  if (values) return { ok: true, line: `private values: the public page is held to the plain patterns and internals/pro's ${Object.keys(values).length} hashed value(s)` };
  const line = `${UNCHECKED}: the public page is filtered by the plain patterns alone`;
  return required ? { ok: false, line: `${line}, and --require-private-values refuses that — check out internals/pro first` } : { ok: true, line };
}

function arg(flag: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? "" : (process.argv[index + 1] ?? "");
}

function main(): void {
  const tag = arg("--tag");
  const previous = arg("--previous") || null;
  const repo = arg("--repo");
  const publicRepo = arg("--public-repo");
  const internalOut = arg("--internal");
  const publicOut = arg("--public");
  if (!/^v\d+\.\d+\.\d+/.test(tag) || !repo || !publicRepo || !internalOut || !publicOut) {
    console.error("usage: release-notes.ts --tag vX.Y.Z [--previous vX.Y.Z] --repo o/n --public-repo o/n --internal FILE --public FILE [--require-private-values]");
    process.exit(2);
  }
  const held = privateValuesHeld(PRIVATE_VALUES, process.argv.includes("--require-private-values"));
  if (!held.ok) {
    console.error(`✗ ${held.line}`);
    process.exit(1);
  }
  console.log(`- ${held.line}`);

  const file = join(ROOT, "docs/releases", `${tag}.md`);
  const notes = existsSync(file) ? readFileSync(file, "utf8") : null;
  let subjects: string[] = [];
  if (notes === null && previous) {
    const log = Bun.spawnSync(["git", "log", "--no-merges", "--format=%s", `${previous}..${tag}`], { cwd: ROOT });
    if (log.exitCode !== 0) throw new Error(`git log ${previous}..${tag} failed: ${log.stderr.toString().trim()}`);
    subjects = log.stdout.toString().split("\n").filter(Boolean);
  }

  const bodies = releaseBodies({ tag, previous, repo, publicRepo, notes, subjects });
  writeFileSync(internalOut, bodies.internal);
  writeFileSync(publicOut, bodies.public);
  console.log(
    notes !== null
      ? `release notes for ${tag}: docs/releases/${tag}.md, on both pages`
      : `release notes for ${tag}: no docs/releases/${tag}.md, so the ${subjects.length} commit subject(s) since ${previous ?? "the beginning"}` +
          (bodies.withheld > 0 ? ` — ${bodies.withheld} left off the public page for naming something private` : ""),
  );
}

if (import.meta.main) main();
