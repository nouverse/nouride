#!/usr/bin/env bun
/**
 * Keeps the coding agents' skills where every tool finds them: `.claude/skills` a symlink to `.agents/skills`, and
 * `.agents/skills` a directory of skills, each either written here (public) or a link to the private one of the same
 * name in `internals/pro/.agents/skills`.
 *
 * Since the source went public (2026-11-06), what describes the homelab this repository is developed on (the box, the
 * release gate, the private docs) lives in the private submodule; what any contributor needs (the invariants, how a
 * change is proven, the UI kit) is written here. A public clone has the public skills and links with nothing behind
 * them. Claude Code and Codex follow a link per skill, and so does Nouride's `project` scope, for a link that stays
 * inside the root an agent named (`packages/persona/src/project-skills.ts`).
 *
 * Two paths because two families of tooling look in different places, and one directory because a copy drifts.
 *
 * Checked rather than trusted. A checkout with `core.symlinks=false` turns a link into a small text file, and a tool
 * that "repairs" a path can replace one with a real directory; either way the coding agent quietly reads something
 * other than the skills. Where the submodule is checked out, every private skill has its link and every link leads
 * to one, so a skill moved or added there is never silently missing here.
 */

import { lstat, readdir, readlink } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const HERE = ".agents/skills";
const PRIVATE = "internals/pro/.agents/skills";

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
const claude = await kindOf(".claude/skills");
if (claude !== "link") problems.push(`.claude/skills should be a symlink to ../${HERE}, found: ${claude}`);
else if ((await readlink(`${ROOT}.claude/skills`)) !== `../${HERE}`) problems.push(`.claude/skills points at ${await readlink(`${ROOT}.claude/skills`)}, not ../${HERE}`);

const here = await kindOf(HERE);
if (here !== "directory") problems.push(`${HERE} should be a directory of skills, found: ${here}`);
const privateOut = (await kindOf(PRIVATE)) === "directory";
const privateNames = privateOut ? (await readdir(`${ROOT}${PRIVATE}`)).filter((n) => !n.startsWith(".")) : [];

let shared = 0;
let linked = 0;
if (here === "directory") {
  for (const name of (await readdir(`${ROOT}${HERE}`)).filter((n) => !n.startsWith("."))) {
    const rel = `${HERE}/${name}`;
    const kind = await kindOf(rel);
    if (kind === "directory") {
      if ((await kindOf(`${rel}/SKILL.md`)) !== "file") problems.push(`${rel} has no SKILL.md`);
      if (privateNames.includes(name)) problems.push(`${name} is both public (${rel}) and private (${PRIVATE}/${name}): one home`);
      shared++;
    } else if (kind === "link") {
      const target = `../../${PRIVATE}/${name}`;
      const actual = await readlink(`${ROOT}${rel}`);
      if (actual !== target) problems.push(`${rel} points at ${actual}, not ${target}`);
      else if (privateOut && !privateNames.includes(name)) problems.push(`${rel} leads to no private skill: ${PRIVATE}/${name} is gone`);
      linked++;
    } else {
      problems.push(`${rel} should be a skill's directory or a link to ${PRIVATE}/${name}, found: ${kind}`);
    }
  }
  for (const name of privateNames) {
    if ((await kindOf(`${HERE}/${name}`)) === "missing") problems.push(`${PRIVATE}/${name} has no link: ln -s ../../${PRIVATE}/${name} ${HERE}/${name}`);
  }
}

if (problems.length === 0) {
  const tail = privateOut ? `, ${linked} linked to ${PRIVATE}` : `, ${linked} links to ${PRIVATE} (private, not checked out here)`;
  console.log(`✓ .claude/skills → ${HERE}: ${shared} public skill(s)${tail}`);
} else {
  console.error(`✗ the skills layout is broken:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
