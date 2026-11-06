#!/usr/bin/env bun
/**
 * Keeps `.claude/skills` a symlink to `.agents/skills`, and `.agents/skills` one to `internals/pro/agent-skills`.
 *
 * The skills describe the homelab this repository is developed on, so since the source went public (2026-11-06) they
 * live in the private submodule; `.agents/skills` points there, which the `project` scope follows (it opens the
 * directory by its path, `statFile` follows a link). A public clone has both links and nothing behind them.
 *
 * Two paths because two families of tooling look in different places, and one directory because
 * a copy drifts. The skills live in `.agents/skills`, the path Nouride's own `project` scope reads
 * (`<root>/.agents/skills`), and `.claude/skills` points there, the same layout as nouverse-core.
 *
 * This replaced a byte-identical mirror. The mirror existed because a symlinked *directory* is
 * invisible to a reader that walks with `withFileTypes` and tests `isDirectory()`. That blind spot
 * is why the real directory is `.agents/skills`: it is the one walked that way. `.claude/skills`
 * is only ever opened by its own path, which follows the link.
 *
 * The link is checked rather than trusted. A checkout with `core.symlinks=false` turns it into a
 * small text file, and a tool that "repairs" a path can replace it with a real directory; either
 * way the coding agent quietly reads something other than the skills.
 */

import { lstat, readlink } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const SOURCE = "internals/pro/agent-skills";
const LINKS: [string, string][] = [
  [".agents/skills", "../internals/pro/agent-skills"],
  [".claude/skills", "../.agents/skills"],
];

async function kindOf(path: string): Promise<"link" | "directory" | "file" | "missing"> {
  try {
    const stat = await lstat(`${ROOT}${path}`);
    if (stat.isSymbolicLink()) return "link";
    return stat.isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

const problems: string[] = [];
for (const [link, target] of LINKS) {
  const kind = await kindOf(link);
  if (kind !== "link") problems.push(`${link} should be a symlink to ${target}, found: ${kind}`);
  else if ((await readlink(`${ROOT}${link}`)) !== target) problems.push(`${link} points at ${await readlink(`${ROOT}${link}`)}, not ${target}`);
}
const source = await kindOf(SOURCE);

if (problems.length === 0) {
  console.log(source === "directory" ? `✓ .claude/skills → .agents/skills → ${SOURCE}` : `✓ the skills links are in place (${SOURCE} is private and not checked out here)`);
} else {
  console.error(`✗ skills link is broken:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\nThe skills live in ${SOURCE}; each link is \`ln -s <target> <link>\`.`);
  process.exit(1);
}
