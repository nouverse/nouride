/**
 * Reading the skill pool, for the reflection pass.
 *
 * Split out of `index.ts`, which is over its line budget and may only shrink. These five are one
 * concern rather than a convenient grouping: every one of them answers "what does the pool currently
 * say", every one is called only while synthesising, and every one takes a name that came from a
 * model — which is why they all resolve through the pool listing rather than joining a path.
 */

import { createLogger } from "@nouride/shared";
import { dirname, join, listDir, readTextFileIfExists } from "@nouride/runtime";
import { agentSkillPool, parseFrontmatter, skillsDirFor, type SkillState } from "@nouride/persona";
import { VALID_SUPPORT_PATH } from "@nouride/persona";
import type { DraftsPort } from "./drafts.store.ts";

const log = createLogger("reflection");

/**
 * Everything in the pool, with descriptions — and what ships with the daemon alongside it.
 *
 * Descriptions and not just names, because the pass has to decide *which* existing skill a lesson
 * belongs to — matching by meaning, which a bare name cannot support.
 *
 * Built-in skills are listed even though nothing here may write to one. They are the answer to a
 * question triage asks on every pass — "is this territory already covered?" — and reading only the
 * operator's pool made that question impossible to answer honestly about anything Nouride ships
 * with. Live: an agent watched its own daemon upgrade itself and drafted `nouride-daemon-update`,
 * half of which was a copy of the harness prompt and half a copy of `nouride update --help`. There
 * was no existing skill to point at, so `create` was the correct answer to the wrong listing.
 *
 * Shared wins a name collision, which is the precedence `Skill.scope` documents: the operator's
 * pool beats what ships.
 */
export async function readPool(agentsDir: string, builtinDir?: string): Promise<SkillState[]> {
  return await agentSkillPool({ poolDir: skillsDirFor(agentsDir), builtinDir, states: {} });
}

/**
 * The refusal for a skill that ships with the daemon, or null when the name is not one.
 *
 * Shared by the two places that write, because they are reached differently and must answer the
 * same: the `skill_improve` tool, and the approval that applies a draft. Neither may touch a
 * built-in — upgrading Nouride replaces those files, so an accepted improvement would survive
 * exactly until the next release and then vanish with nothing logged.
 *
 * Worse than losing it: `updateExistingSkill` writes into the operator's pool, and shared beats
 * builtin on a name collision. An improvement to a built-in would therefore not update it at all —
 * it would shadow it with a copy that stops receiving our updates.
 */
export function shippedSkillRefusal(pool: SkillState[], name: string): string | null {
  const found = pool.find((skill) => skill.name === name);
  if (!found || found.scope !== "builtin") return null;
  return (
    `"${name}" ships with Nouride and is maintained in its source, so the loop does not rewrite it` +
    ": an accepted change would be replaced by the next upgrade. If it is wrong or incomplete, say" +
    " so in your reply so it can be fixed where it is written."
  );
}

/**
 * Whose skill is this, and may the loop write to it — the whole answer, in one place.
 *
 * Two rules that read as one question, so they are asked as one. Order matters between them: a
 * built-in has no `author` either, so checking the hand-written rule first refuses a shipped skill
 * with a sentence about a person who does not exist.
 *
 * `null` for "yes", including for a name that is in no pool at all — that is a `create`, and it is
 * the caller that knows whether one is allowed here.
 */
export async function writeRefusal(
  agentsDir: string,
  builtinDir: string | undefined,
  name: string,
  /**
   * A new skill rather than a rewrite. Only the built-in rule applies then: a new skill under a
   * built-in's name would shadow it (the pool wins a collision) and stop receiving our fixes, with
   * nothing said — and `writeNewSkill` only looks in the pool. Its own existing-file check covers
   * the rest.
   */
  creating = false,
): Promise<string | null> {
  const pool = await readPool(agentsDir, builtinDir);
  if (creating) {
    return shippedSkillRefusal(pool, name)
      ? `"${name}" is the name of a skill Nouride ships with. Rename this one before approving it.`
      : null;
  }
  const shipped = shippedSkillRefusal(pool, name);
  if (shipped) return shipped;
  const target = pool.find((skill) => skill.name === name);
  if (target && !target.author) {
    return (
      `"${name}" was written by hand, not by an agent, and the loop does not rewrite those. Edit it` +
      " yourself, or delete it and let one be proposed."
    );
  }
  return null;
}

/**
 * How many subjects a skill has grown to cover, and how much it weighs.
 *
 * Read from disk rather than carried on `SkillState`, because it is wanted on the one code path
 * that reflects and nowhere else — putting it on the type would make every boot count headings for
 * every skill to serve a question only this asks. A few KB per file, on turns that were already
 * about to spend two provider calls.
 *
 * Zero on anything unreadable, which reads as "not broad" and leaves the decision where it was.
 * Guessing high on a missing file would push the pass toward `create` on no evidence.
 */
export async function breadthOf(skill: SkillState): Promise<{ bytes: number }> {
  const source = await readTextFileIfExists(skill.path);
  if (!source) return { bytes: 0 };
  /**
   * Bytes, and deliberately not a heading count.
   *
   * Two earlier versions counted headings. `##` alone missed `domain-management` — 23KB across four
   * sections, because everything it absorbed went into subsections under one `## Workflow`. Counting
   * `##` and `###` caught that and then marked six of the seven largest skills, including a 7.6KB
   * one. Size separated them in both directions and the heading shape did not.
   */
  return { bytes: parseFrontmatter(source).body.length };
}

/**
 * The support files beside one skill, relative to its directory.
 *
 * Resolved through the pool listing for the same reason `readSkill` is: the name comes from a
 * model, and joining it to a path directly would let a chosen string address a directory outside
 * the pool. One level deep only, matching `VALID_SUPPORT_PATH` — nothing writes deeper, so
 * nothing needs to be read deeper.
 */
export async function listSkillFiles(pool: SkillState[], name: string): Promise<string[]> {
  const found = pool.find((skill) => skill.name === name);
  if (!found) return [];
  const root = dirname(found.path);
  const out: string[] = [];
  for (const kind of ["references", "scripts", "templates"]) {
    for (const entry of listDir(join(root, kind))) {
      if (!entry.isDirectory) out.push(`${kind}/${entry.name}`);
    }
  }
  return out;
}

/**
 * One support file's contents, for a model that asked to read it.
 *
 * Two boundaries, and both are needed because both inputs come from the model. The *name* is
 * resolved through the pool listing, exactly as `readSkill` does, so a chosen string cannot address
 * a directory outside the pool. The *path* is matched against the same pattern that governs
 * writing — one level, under one of the three known directories — so `../../config.toml` is a
 * miss rather than a read.
 *
 * `null` for anything that does not resolve. The caller turns that into a sentence naming what was
 * not found, because a model handed an empty string reads the same path again.
 */
export async function readSkillFile(pool: SkillState[], name: string, path: string): Promise<string | null> {
  if (!VALID_SUPPORT_PATH.test(path)) {
    log.warn("reflection asked to read a path it may not", { skill: name, path });
    return null;
  }
  const found = pool.find((skill) => skill.name === name);
  if (!found) return null;
  return await readTextFileIfExists(join(dirname(found.path), path));
}

/** One skill's `SKILL.md`, resolved through the pool listing rather than from a name the model chose. */
export async function readSkill(pool: SkillState[], name: string, drafts: DraftsPort): Promise<string | null> {
  /**
   * The waiting draft's body wins over the file on disk, when there is one.
   *
   * This is what makes a second improvement *accumulate* rather than compete. Read from disk, two
   * conversations a day apart each produce a full rewrite of the same skill from the same
   * starting point, and since the body is overwritten whole, approving both keeps only the second.
   * That is not hypothetical — four such drafts were sitting in the live queue, and between them
   * they would have thrown away two lessons out of three.
   *
   * Built on the pending body instead, each revision contains the last, and `pendingByName` above
   * retires the one it was built from. The queue holds one decision rather than several that
   * silently cancel each other.
   */
  const waiting = drafts.pendingByName(name);
  if (waiting) return waiting.body;
  const found = pool.find((skill) => skill.name === name);
  return found ? await readTextFileIfExists(found.path) : null;
}
