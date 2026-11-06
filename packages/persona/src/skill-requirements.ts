/**
 * Does this host have what a skill's procedure needs?
 *
 * A skill can name host software in its frontmatter — `requires: dot, playwright` — and this answers
 * whether each name is on `PATH`. Nothing here gates anything: a skill whose `dot` is missing still
 * loads and is still offered, because the alternative is an agent that silently does not know how to
 * draw a graph and an operator with nothing to read. The Skills Workshop shows the gap, and
 * `nouride doctor` says it out loud.
 *
 * Cached, because a dashboard that polls the catalogue would otherwise run one `PATH` walk per skill
 * per render. The TTL exists so installing the missing program shows up without restarting the
 * daemon — which is exactly what an operator does right after reading that it is missing.
 */

import { whichBinary } from "@nouride/runtime";
import type { Skill } from "@nouride/shared";

/** Long enough to make polling free, short enough that `apt install graphviz` shows up. */
const TTL_MS = 60_000;

export interface SoftwareCheck {
  name: string;
  present: boolean;
  /** Where it was found. Useful when two installs disagree about which `python` is on `PATH`. */
  path?: string;
}

const cache = new Map<string, { checkedAt: number; result: SoftwareCheck }>();

/** One program, cached. */
export function checkSoftware(name: string, now = Date.now()): SoftwareCheck {
  const hit = cache.get(name);
  if (hit && now - hit.checkedAt < TTL_MS) return hit.result;

  const path = whichBinary(name);
  const result: SoftwareCheck = { name, present: path !== null, ...(path ? { path } : {}) };
  cache.set(name, { checkedAt: now, result });
  return result;
}

/** Every distinct program named by any of these skills, checked once each. */
export function checkSkillSoftware(skills: Skill[]): SoftwareCheck[] {
  const names = [...new Set(skills.flatMap((skill) => skill.requires ?? []))].sort();
  return names.map((name) => checkSoftware(name));
}

/** The programs a single skill wants and this host does not have. Empty for most skills. */
export function missingFor(skill: Skill): string[] {
  return (skill.requires ?? []).filter((name) => !checkSoftware(name).present);
}

/** Drop the cache — for tests, and for a `doctor` run that wants a fresh answer. */
export function clearSoftwareCache(): void {
  cache.clear();
}

/**
 * Tools this skill names that the agent does not hold.
 *
 * The other half of `missingFor`, and cheaper: the answer is already in memory, so there is nothing
 * to cache and no `PATH` to walk. Per *agent* rather than per host, which is the whole difference —
 * two agents on one daemon can disagree about this while agreeing about every binary.
 */
export function missingToolsFor(skill: Skill, agentTools: readonly string[]): string[] {
  if (!skill.needsTools || skill.needsTools.length === 0) return [];
  const held = new Set(agentTools);
  return skill.needsTools.filter((tool) => !held.has(tool));
}
