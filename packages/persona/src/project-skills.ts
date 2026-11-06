/**
 * Skills a project brings with it.
 *
 * A directory named in `[workspace] skill_roots` may carry `.agents/skills/`, and those load like
 * any other skill — one line in the prompt naming what it is and where to read it. The point is the
 * loop: drop a `SKILL.md` into the repository you are working on and the next message already knows
 * about it, with no reload.
 *
 * ## Why per turn, when the other two scopes load once
 *
 * Not an inconsistency — the scopes differ in who edits them and when. A pack is config-as-code that
 * an operator reloads deliberately; a project's `.agents/` is something you edit *while working*,
 * and a skill that needs `nouride agent reload` before it takes effect is a skill nobody writes.
 *
 * The cost of being fresh is one `readdir` and one `stat` per skill per turn, which is nothing
 * beside a provider call — and the body is never read here anyway. Frontmatter is re-parsed only
 * when a file actually changed, so the common case is a few stats and a cache hit.
 *
 * ## Why the roots are named rather than discovered
 *
 * A skill is instructions in the **system prompt** — the most trusted position in the whole request.
 * Auto-loading from every directory the agent can reach would mean that anyone who can write a file
 * into a repository it works on can write into that prompt, and a pull request becomes an injection
 * vector. This codebase already marks web content and MCP tool descriptions as untrusted for far
 * less. Naming the roots costs one line of config and removes the entire class.
 */

import { join, listDir, statFile } from "@nouride/runtime";
import { createLogger, type LoadedAgent, type Skill } from "@nouride/shared";
import { PROJECT_SKILLS_DIR } from "./loader.ts";
import { listSkills, skillEnabled } from "./skills.ts";

const log = createLogger("agents.project-skills");

/**
 * Enough that a project can teach an agent its conventions, few enough that one repository cannot
 * crowd the prompt out on its own. Skills are the first section trimmed when the budget is hit, so
 * the failure mode without a cap is *other* skills quietly disappearing.
 */
const MAX_PER_ROOT = 24;

interface CacheEntry {
  /** Every skill file's path, size and mtime. Any change to any of them invalidates the entry. */
  signature: string;
  skills: Skill[];
}

export class ProjectSkills {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * The project skills this agent should be offered right now.
   *
   * Never throws: a root that has gone away, a permission error, an unreadable file — none of them
   * are worth failing a turn over. The agent loses a skill it may not have needed; it does not lose
   * the conversation.
   */
  async forAgent(agent: LoadedAgent): Promise<Skill[]> {
    const roots = agent.config.skillRoots;
    if (roots.length === 0) return [];

    const collected: Skill[] = [];
    for (const root of roots) {
      try {
        collected.push(...(await this.forRoot(root)));
      } catch (err) {
        log.warn("could not read project skills", { root, error: String(err) });
      }
    }
    // Filtered here, not in `forRoot`, because the cache is keyed by directory and shared by every
    // agent that names the root. Filtering inside it would store one agent's toggles under a key the
    // next agent reads — a skill switched off for Nix disappearing for Nero, from a cache hit.
    return collected.filter((skill) => skillEnabled(agent.config.skills, skill, agent.config.id));
  }

  /** Drop everything. Called on reload, so a pack change cannot be served from a stale entry. */
  clear(): void {
    this.cache.clear();
  }

  private async forRoot(root: string): Promise<Skill[]> {
    const dir = join(root, PROJECT_SKILLS_DIR);
    const signature = this.signatureOf(dir);

    // Nothing there: cached as an empty result so a root without skills costs one `readdir` a turn
    // rather than a directory walk.
    const cached = this.cache.get(dir);
    if (cached && cached.signature === signature) return cached.skills;

    // Every skill in the directory, with no toggles applied — everything in a project's `.agents/`
    // was put there deliberately by whoever owns the repository, and the per-agent switch is applied
    // by `forAgent` after the cache.
    const loaded = await listSkills(dir, "project", {});
    const skills: Skill[] = loaded
      .slice(0, MAX_PER_ROOT)
      .map(({ enabled: _enabled, decided: _decided, ...skill }) => skill);

    if (loaded.length > MAX_PER_ROOT) {
      // Said out loud rather than truncated silently: a skill that is simply absent from the prompt
      // looks to the operator like a skill that does not work.
      log.warn("project has more skills than are offered", {
        root,
        found: loaded.length,
        offered: MAX_PER_ROOT,
      });
    }

    this.cache.set(dir, { signature, skills });
    return skills;
  }

  /**
   * A cheap fingerprint of what is on disk.
   *
   * Directory mtime alone is not enough: editing a `SKILL.md` in place changes the file, not the
   * directory holding it, so a cache keyed on the directory would serve yesterday's description
   * forever. Per-file size and mtime catches an edit; the sorted name list catches an add or a
   * delete.
   */
  private signatureOf(dir: string): string {
    const entries = listDir(dir)
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name)
      .sort();

    return entries
      .map((name) => {
        const stat = statFile(join(dir, name, "SKILL.md"));
        return stat ? `${name}:${stat.size}:${stat.mtimeMs}` : `${name}:absent`;
      })
      .join("|");
  }
}
