/**
 * Writing a `SKILL.md` into the pool — the one place that knows what the file looks like.
 *
 * Two callers: the `skill_create` tool, where an agent writes a skill on the spot, and the RSI
 * approval path, where a human says yes to a draft the reflection pass produced. Approving a draft
 * does exactly what `skill_create` does, and the only way to keep that true
 * is for both to call the same function — two renderers agreeing about frontmatter today is two
 * renderers disagreeing about it after the next field is added.
 *
 * Reloading the registry is deliberately *not* here. Both callers do it, and both word the failure
 * differently: an agent reads "wrote the file but reloading failed", an operator reads it in an HTTP
 * response. What is shared is the file format and the refusal to overwrite, and nothing else.
 */

import {
  dirExists,
  dirname,
  ensureDir,
  fileExists,
  join,
  listDir,
  readTextFileIfExists,
  removePath,
  renamePath,
  setFileMode,
  writeTextFileAtomic,
} from "@nouride/runtime";
import { snapshotStamp } from "@nouride/shared";
import { skillsDirFor } from "./loader.ts";
import { parseFrontmatter } from "./skills.ts";

/** Skill names double as directory names. */
export const VALID_SKILL_NAME = /^[a-z][a-z0-9-]{1,47}$/;

export interface SkillDocument {
  name: string;
  description: string;
  /** Host software the procedure needs, comma-separated. Empty writes no `requires:` line. */
  requires?: string;
  /** Nouride tools the procedure calls, comma-separated. The other axis — see `Skill.needsTools`. */
  needsTools?: string;
  body: string;
  /** Agent that wrote it. Provenance, not a permission — every agent can read every skill. */
  author?: string;
  /** The agents it is on for, comma-separated — `Skill.agents`. Empty writes no line: on for everyone. */
  agents?: string;
  /** Who approved it, for a skill that came through the RSI gate. */
  verifiedBy?: string;
  /** `YYYY-MM-DD`. Supplied by the caller so a test can pin it. */
  created?: string;
  /** `YYYY-MM-DD` of the most recent improvement. Only ever set by `updateExistingSkill`. */
  updated?: string;
  /**
   * Where an installed skill came from — `github:owner/repo@sha/path`, `clawhub:slug@1.2.0`. Absent
   * for one an agent or a person wrote here. What a later "is there a newer one" compares against.
   */
  source?: string;
}

export type SkillWriteResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Frontmatter plus body, exactly as `@nouride/persona` parses it back.
 *
 * The parser is `key: value` lines and not YAML (TD-014), so a colon inside a value is fine and a
 * newline inside one is not — which is why every single-line field is flattened before it lands here.
 */
export function renderSkillMarkdown(doc: SkillDocument): string {
  const line = (value: string): string => value.replace(/\r?\n/g, " ").trim();

  return [
    "---",
    `name: ${doc.name}`,
    `description: ${line(doc.description)}`,
    ...(doc.requires?.trim() ? [`requires: ${line(doc.requires)}`] : []),
    ...(doc.needsTools?.trim() ? [`needs_tools: ${line(doc.needsTools)}`] : []),
    ...(doc.author ? [`author: ${line(doc.author)}`] : []),
    ...(doc.agents?.trim() ? [`agents: ${line(doc.agents)}`] : []),
    ...(doc.verifiedBy ? [`verified_by: ${line(doc.verifiedBy)}`] : []),
    ...(doc.created ? [`created: ${line(doc.created)}`] : []),
    ...(doc.updated ? [`updated: ${line(doc.updated)}`] : []),
    ...(doc.source ? [`source: ${line(doc.source)}`] : []),
    "---",
    "",
    doc.body.trim(),
    "",
  ].join("\n");
}

/** Where a skill of this name lives. */
function skillPath(agentsDir: string, name: string): string {
  return join(skillsDirFor(agentsDir), name, "SKILL.md");
}

/**
 * Write a new skill. Never overwrites.
 *
 * A skill somebody has been refining is not something to clobber because a model picked the same
 * name twice, and "create" should never be destructive. Rewriting an existing one is `edit` on its
 * path, which `nouride skills -v` prints.
 */
export async function writeNewSkill(
  agentsDir: string,
  doc: SkillDocument & { files?: readonly SkillFileInput[]; installed?: boolean },
): Promise<SkillWriteResult> {
  if (!VALID_SKILL_NAME.test(doc.name)) {
    return {
      ok: false,
      error: `"${doc.name}" is not a valid skill name: lowercase letters, digits and hyphens, starting with a letter, 2–48 characters.`,
    };
  }
  if (!doc.description.trim()) {
    return { ok: false, error: "`description` is required: it is how the skill is found later." };
  }
  if (!doc.body.trim()) {
    return { ok: false, error: "`body` is required: a skill with no instructions is not a skill." };
  }

  const path = skillPath(agentsDir, doc.name);
  if (await fileExists(path)) {
    return {
      ok: false,
      error: `A skill called "${doc.name}" already exists at ${path}. Use \`edit\` to change it, or pick another name.`,
    };
  }

  const fileError = validateSupportFiles(doc.files ?? [], { installed: doc.installed });
  if (fileError) return { ok: false, error: fileError };

  await writeTextFileAtomic(path, renderSkillMarkdown(doc));
  await writeSupportFiles(agentsDir, doc.name, doc.files ?? []);
  return { ok: true, path };
}

export type SkillDeleteResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Remove a skill from the pool — the whole directory, `references/` and `scripts/` with it.
 *
 * The name is validated against `VALID_SKILL_NAME` before it is joined to anything, and that check is
 * the security boundary rather than a politeness: a name is a path segment here, and a route that
 * passed `../../..` through to `removePath` would delete whatever the daemon can reach. The pattern
 * admits lowercase letters, digits and hyphens only, so a traversal cannot be spelled in it.
 *
 * Built-in skills are refused by the **caller**, not here: they live in a different directory
 * entirely (`skillsDirFor` only ever names the pool), so this function cannot reach one to begin
 * with. Deleting a skill that is not in the pool is simply "no such skill".
 *
 * What this deliberately does not do is tidy `skills.toml`. An agent that had this skill switched
 * off keeps a line saying so, which costs nothing and is already surfaced by `unknownSkillStates`
 * and `nouride doctor`. Rewriting up to six pack files on a delete is a much larger blast radius
 * than the delete itself, and a partial failure would leave the packs disagreeing with each other.
 */
export async function deletePoolSkill(agentsDir: string, name: string): Promise<SkillDeleteResult> {
  if (!VALID_SKILL_NAME.test(name)) {
    return { ok: false, error: `"${name}" is not a valid skill name` };
  }

  const path = skillPath(agentsDir, name);
  if (!(await fileExists(path))) {
    return { ok: false, error: `no skill called "${name}" is in the pool` };
  }

  // The directory, not just the file. A skill is a directory holding `SKILL.md` plus whatever
  // support files it came with, and leaving those behind would make the name un-recreatable —
  // `writeNewSkill` refuses an existing path, and the operator would have no way to see why.
  removePath(dirname(path));
  return { ok: true, path };
}

/**
 * Move a skill out of the pool into `skills/.archive/` — what the weekly review's archive and merge proposals do once
 * a person approves them. Kept rather than deleted, so moving the directory back undoes it; a directory without a
 * `SKILL.md` at its top is not a skill, so the loader passes `.archive` by. A name archived twice gets `-2`, `-3`.
 */
export async function archivePoolSkill(agentsDir: string, name: string): Promise<SkillDeleteResult> {
  if (!VALID_SKILL_NAME.test(name)) return { ok: false, error: `"${name}" is not a valid skill name` };
  const path = skillPath(agentsDir, name);
  if (!(await fileExists(path))) return { ok: false, error: `no skill called "${name}" is in the pool` };
  const archive = join(skillsDirFor(agentsDir), ".archive");
  let to = join(archive, name);
  for (let n = 2; dirExists(to); n += 1) to = join(archive, `${name}-${n}`);
  ensureDir(archive);
  renamePath(dirname(path), to);
  return { ok: true, path: to };
}

/**
 * Where a support file may go, and nowhere else.
 *
 * One level under one of three known directories, and the segment is a plain filename. This is the
 * same boundary `deletePoolSkill` relies on: a path from a model or an HTTP body is joined to a
 * directory the daemon can write, so the pattern is what stands between a skill and an arbitrary
 * file write. `..` cannot be spelled in it, and neither can a second slash.
 *
 * Exported because the reflection pass now *reads* support files as well as writing them, and a
 * second pattern for reading would be a second answer to "what may this path be" — the one that
 * drifts is always the copy nobody is looking at.
 */
export const VALID_SUPPORT_PATH = /^(references|scripts|templates)\/[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The wider shape a skill installed from elsewhere may have.
 *
 * Skills written to the open format put files where they like: `reference.md` beside `SKILL.md`,
 * a script nested a level down under `scripts/`, `assets/`, capital letters.
 Forcing those into the three one-level
 * directories above would break every relative link the skill's own instructions make, so an
 * installed skill keeps its layout — within limits that still make a path safe to join: up to seven
 * segments, no segment starting with a dot (so no `..`, no hidden files), and not `SKILL.md` itself.
 * Only the installer passes `installed`; an agent writing a skill still gets the narrow rule.
 */
export const VALID_INSTALLED_PATH = /^(?!SKILL\.md$)[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){0,6}$/;

export interface SkillFileInput {
  path: string;
  content: string;
}

/** Refuse the whole set, naming the first offender. Half-written support files help nobody. */
export function validateSupportFiles(files: readonly SkillFileInput[], options: { installed?: boolean } = {}): string | null {
  for (const file of files) {
    if (options.installed ? !VALID_INSTALLED_PATH.test(file.path) : !VALID_SUPPORT_PATH.test(file.path)) {
      return options.installed
        ? `"${file.path}" is not a path an installed skill may have: at most seven segments, none starting with a dot.`
        : `"${file.path}" is not a valid support-file path: use references/<name>, scripts/<name> or templates/<name>, one level, lowercase.`;
    }
    if (!file.content.trim()) return `"${file.path}" is empty.`;
  }
  return null;
}

/**
 * Write the files a skill ships alongside its body.
 *
 * Anything under `scripts/` is made executable. The pool holds real Python and shell helpers — 44 of
 * them on the live box — and a skill whose procedure says `./scripts/wake_pc.py` against a file
 * written 0644 fails with `Permission denied`, which reads as a broken skill rather than a missing
 * bit. `setFileMode` is a no-op where the filesystem has no modes, so this costs nothing on hosts
 * that do not care.
 */
async function writeSupportFiles(
  agentsDir: string,
  name: string,
  files: readonly SkillFileInput[],
): Promise<void> {
  const root = dirname(skillPath(agentsDir, name));
  for (const file of files) {
    const path = join(root, file.path);
    await writeTextFileAtomic(path, file.content);
    if (file.path.startsWith("scripts/")) setFileMode(path, 0o755);
  }
}

/**
 * Improve a skill that already exists — the verb the loop was missing.
 *
 * Overwrites `SKILL.md` rather than applying a patch, and that is deliberate. A patch is a diff that
 * can fail to apply against a file that moved on, and the failure arrives *after* a human approved
 * it, which is the worst moment for it. A whole body always applies; the reviewing surface computes
 * the diff, so the person still sees exactly what changes.
 *
 * Provenance is merged rather than replaced. The original `author` and `created` survive — the agent
 * that first worked this out still wrote it — and `updated` plus `verified_by` record this round. A
 * skill that loses its history on the first improvement cannot answer "where did this come from"
 * six months later, which is half the reason the gate is human.
 */
export async function updateExistingSkill(
  agentsDir: string,
  doc: SkillDocument & { files?: readonly SkillFileInput[]; removeFiles?: readonly string[] },
): Promise<SkillWriteResult> {
  if (!VALID_SKILL_NAME.test(doc.name)) {
    return { ok: false, error: `"${doc.name}" is not a valid skill name` };
  }
  if (!doc.body.trim()) return { ok: false, error: "`body` is required." };

  const fileError = validateSupportFiles(doc.files ?? []);
  if (fileError) return { ok: false, error: fileError };
  // Removals go through the same pattern as writes: the path is joined to a directory the daemon
  // can delete from, so it is exactly as much of a boundary.
  for (const path of doc.removeFiles ?? []) {
    if (!VALID_SUPPORT_PATH.test(path)) return { ok: false, error: `"${path}" is not a support-file path.` };
  }

  const path = skillPath(agentsDir, doc.name);
  const existing = await readTextFileIfExists(path);
  if (existing === null) {
    return { ok: false, error: `no skill called "${doc.name}" is in the pool to update` };
  }

  const { fields } = parseFrontmatter(existing);
  // The version an approval replaces is kept (0.8.18, REVIEW B2): an improvement overwrote it and kept nothing.
  await keepPreviousSkill(agentsDir, doc.name, existing);
  await writeTextFileAtomic(
    path,
    renderSkillMarkdown({
      ...doc,
      description: doc.description.trim() || (fields.description ?? ""),
      ...(fields.author ? { author: fields.author } : doc.author ? { author: doc.author } : {}),
      // Who it is on for is the operator's line once written: an improvement keeps it as it was.
      ...(fields.agents ? { agents: fields.agents } : {}),
      ...(fields.created ? { created: fields.created } : {}),
      ...(doc.verifiedBy ? { verifiedBy: doc.verifiedBy } : {}),
      ...(doc.updated ? { updated: doc.updated } : {}),
    }),
  );
  await writeSupportFiles(agentsDir, doc.name, doc.files ?? []);
  // Removals last, so a file both replaced and listed for removal ends up gone rather than half-there.
  const root = dirname(path);
  for (const relative of doc.removeFiles ?? []) removePath(join(root, relative));
  return { ok: true, path };
}

/** How many earlier versions of a skill's `SKILL.md` the pool keeps. */
const SKILL_VERSIONS = 10;

/**
 * `skills/.history/<name>/<stamp>.md`, ten deep: what a skill said before an improvement replaced it, readable and
 * copied back by hand. Beside `.archive/`, and as that one is, never read as a skill: it holds no `SKILL.md` of its own.
 */
async function keepPreviousSkill(agentsDir: string, name: string, text: string, now: number = Date.now()): Promise<void> {
  const dir = join(skillsDirFor(agentsDir), ".history", name);
  await writeTextFileAtomic(join(dir, `${snapshotStamp(now)}.md`), text);
  const versions = listDir(dir)
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name)
    .sort();
  for (const old of versions.slice(0, Math.max(0, versions.length - SKILL_VERSIONS))) removePath(join(dir, old));
}

/**
 * English function words. Frequency, not vocabulary.
 *
 * These are the words English prose cannot avoid — a paragraph is dense with them, and a paragraph
 * of any other language is not. That is what makes the test work in *one* direction for *every*
 * other language, rather than needing a pattern per language.
 */
const ENGLISH =
  /\b(the|of|and|to|in|is|that|it|for|with|as|on|this|be|are|from|by|or|an|a|not|you|your|if|when|which|there|then|do|does|use|can|will|has|have|its|at|into|out|so|but|than|each|any|all|no|only|what|how|why|after|before|while|until|unless|these|those|they|them|their)\b/gi;

/**
 * Below this share of function words, the prose is not English.
 *
 * Measured against the twenty skills on the live box plus samples, not picked. The least
 * function-word-dense *English* skill of a judgeable length scores 14.6%; Spanish prose scores 2.6%
 * and Indonesian 0%. Eight per cent sits 3× above the highest non-English sample and 1.8× below the
 * lowest English one — a wide, empty gap.
 */
const ENGLISH_SHARE = 0.08;

/** Prose the check has to see before it can say anything. Below this, it says nothing. */
const MIN_PROSE_WORDS = 50;

/**
 * Is this skill body written in English?
 *
 * A skill is read by every agent on the daemon and by whoever reviews it next, so it is written in
 * English whatever language the conversation was in. Saying that in the prompt was not enough — a
 * model working in another language all turn writes the skill in that language too, and one sat in
 * the live pool for weeks before anybody noticed.
 *
 * **Positive detection, and that is the whole point.** The first version of this looked for
 * Indonesian, which is backwards: it passes Spanish, Javanese, Japanese and everything else that is
 * also not English. Asking "does this read as English" is one test that covers every language nobody
 * thought of, which is exactly the set that matters.
 *
 * Code is stripped first — a fenced block is not prose, and a shell snippet full of short tokens
 * would drag the ratio around for no reason. A body with too little prose left to measure passes:
 * three lines carry no statistics, and refusing one on a coin flip is worse than letting it reach a
 * human who sees it immediately.
 *
 * Applied to what a **model** produces, never to what a person types. An operator editing a draft in
 * the Workshop may write in any language they like — it is their skill and their call. The rule
 * exists to stop the machine drifting, not to police the human.
 */
export function skillBodyIsEnglish(body: string): boolean {
  const prose = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const words = prose.split(/\s+/).filter(Boolean).length;
  if (words < MIN_PROSE_WORDS) return true;
  return (prose.match(ENGLISH) ?? []).length / words > ENGLISH_SHARE;
}
