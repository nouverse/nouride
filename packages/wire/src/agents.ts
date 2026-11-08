/** One agent's own settings: the folders it takes project skills from, and the levels its effort is set to. */

import type { LLM_EFFORTS } from "@nouride/shared";

/** A folder an agent takes project skills from, and the skills it brings (0.8.24). */
export interface SkillRoot {
  path: string;
  /** Whether the server can open it now: a repository not cloned yet cannot be. */
  readable: boolean;
  skills: { name: string; description: string }[];
}

/**
 * The levels an agent's effort can be set to, in order. The dashboard offers them, so it keeps a list at runtime,
 * typed as this one: a level the daemon adds and the page lacks fails its typecheck.
 */
export type EffortLevels = typeof LLM_EFFORTS;
