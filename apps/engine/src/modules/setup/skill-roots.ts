/**
 * An agent's skill roots (0.8.24): the folders whose `.agents/skills/` it takes as its own skills, set without editing its
 * `config.toml` by hand. The list was a line of that file, which only an admin changes, on the Files tab or on the box:
 * no form, no command, and an agent asked to add a repository could only ask the person to edit it — Nix, asked to add
 * Nouride Home's, could not (2026-11-08). Now the agent's Skills page, `nouride agent skill-root add|rm` and the agent's
 * own request (`skill_root`, an admin's yes) all come here.
 *
 * Written as the Files tab's save writes (`files.ts`): parsed first, the version before kept, the agent reloaded and put
 * back where it no longer loads, audited. The folder is checked before that, and refused by what is wrong with it: a
 * folder the daemon reads, and not one that holds the credentials folder — every agent naming it could read the keys
 * there, and the next boot refuses it (`assertCredentialsUnreadable`).
 */

import { escapes, expandHome, isAbsolute, isReadableDir, parseToml, realPathStrict, relative, resolve, statFile } from "@nouride/runtime";
import { projectSkillNames, type AgentRegistry, type ProjectSkills } from "@nouride/persona";
import { removeTomlKey, removeTomlTable, upsertTomlTable } from "@/modules/config/edit.ts";
import type { FileService } from "./files.ts";

/** One root as its agent's Skills page lists it. */
export interface SkillRootView {
  /** As the loader reads it: `~` expanded, a relative one against the pack. */
  path: string;
  /** Whether the daemon can read it now: a repository not cloned yet cannot be. */
  readable: boolean;
  /** What its `.agents/skills/` brings. */
  skills: { name: string; description: string }[];
}

/** Why a change was not made, for the route to word for a person and the command and the agent to read. */
export type SkillRootRefusal = "agent" | "path" | "missing" | "file" | "unreadable" | "credentials" | "already" | "unknown" | "conflict" | "unsaved";

export type SkillRootChange =
  | { ok: true; path: string; skills: string[] }
  | { ok: false; refused: SkillRootRefusal; error: string };

export interface SkillRootsDeps {
  registry: Pick<AgentRegistry, "get">;
  files: Pick<FileService, "read" | "write">;
  /** The credentials folder as the daemon uses it (`keptFolders`), which no root may hold. */
  credentialsDir: string;
  projectSkills: Pick<ProjectSkills, "ofRoot">;
}

/** A folder as given: `~` expanded and normalized, or null where it is not a full path. */
function fullPath(given: string): string | null {
  const expanded = expandHome(given.trim());
  return expanded && isAbsolute(expanded) ? resolve(expanded) : null;
}

/** The same folder: by its path, or by where both really are. */
function sameFolder(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const real = realPathStrict(a);
  return real !== null && real === realPathStrict(b);
}

/** Whether `child` is `parent` or inside it, by path and by where both really are. */
function holds(parent: string, child: string): boolean {
  const inside = (from: string, to: string) => !escapes(relative(from, to));
  if (inside(resolve(parent), resolve(child))) return true;
  const realParent = realPathStrict(parent);
  const realChild = realPathStrict(child);
  return realParent !== null && realChild !== null && inside(realParent, realChild);
}

/** The entries of `[workspace] skill_roots` as written in the pack's file. */
function writtenRoots(text: string): string[] {
  const parsed = text.trim() ? parseToml<{ workspace?: { skill_roots?: unknown } }>(text) : {};
  const roots = parsed.workspace?.skill_roots;
  return Array.isArray(roots) ? roots.filter((root): root is string => typeof root === "string") : [];
}

/**
 * The file with `roots` as its skill roots: the key taken away when there are none, and `[workspace]` with it when
 * nothing else is in it — the table the first root added, left empty behind the last one.
 */
function withRoots(text: string, roots: string[]): string {
  if (roots.length > 0) return upsertTomlTable(text, "workspace", { skill_roots: roots });
  const without = removeTomlKey(text, "workspace", "skill_roots");
  const left = parseToml<{ workspace?: Record<string, unknown> }>(without).workspace;
  // Without the blank line that set the table apart, at the end of the file where adding it put it.
  return left && Object.keys(left).length === 0 ? removeTomlTable(without, "workspace").replace(/\n+$/, "\n") : without;
}

export class SkillRoots {
  constructor(private readonly deps: SkillRootsDeps) {}

  /** Each of the agent's roots with the skills it brings; null where there is no such agent. */
  async list(agentId: string): Promise<SkillRootView[] | null> {
    const agent = this.deps.registry.get(agentId);
    if (!agent) return null;
    return await Promise.all(
      agent.config.skillRoots.map(async (path) => ({
        path,
        readable: isReadableDir(path),
        skills: (await this.skillsOf(path)).map(({ name, description }) => ({ name, description })),
      })),
    );
  }

  /**
   * Why `given` cannot be added to the agent's roots, or null with the folder as it will be written. Asked by the
   * request's gate too, so an agent is refused before an admin is asked about a folder that could not be added.
   */
  check(agentId: string, given: string): { path: string } | { refused: SkillRootRefusal; error: string } {
    const agent = this.deps.registry.get(agentId);
    if (!agent) return { refused: "agent", error: `No agent called "${agentId}".` };
    const path = fullPath(given);
    if (!path) return { refused: "path", error: `"${given}" is not a full path: name the folder as it is on this machine, from /.` };
    const stat = statFile(path);
    if (!stat) return { refused: "missing", error: `There is no folder at ${path}.` };
    if (!stat.isDirectory) return { refused: "file", error: `${path} is a file. A skill root is a project's folder, the one that holds .agents/skills.` };
    if (!isReadableDir(path)) return { refused: "unreadable", error: `The daemon cannot read ${path}: its user is not let into that folder.` };
    if (holds(path, this.deps.credentialsDir)) {
      return {
        refused: "credentials",
        error: `${path} holds the credentials folder (${this.deps.credentialsDir}): an agent with it as a skill root could read the keys in there, and the daemon would not start.`,
      };
    }
    if (agent.config.skillRoots.some((root) => sameFolder(root, path))) return { refused: "already", error: `${path} is already one of ${agentId}'s skill roots.` };
    return { path };
  }

  /** The agent's root `given` names, as the loader reads it, or null where it is not one of them. */
  rootOf(agentId: string, given: string): string | null {
    const path = fullPath(given);
    if (!path) return null;
    return this.deps.registry.get(agentId)?.config.skillRoots.find((root) => sameFolder(root, path)) ?? null;
  }

  /** The names of the skills a folder brings now, read from its folders alone. */
  skillsAt(path: string): string[] {
    return projectSkillNames(path);
  }

  /** Add a root, checked first. `details` goes into the audit entry beside what changed: a request says it was one. */
  async add(input: { agentId: string; path: string; actor: string; details?: Record<string, unknown> }): Promise<SkillRootChange> {
    const checked = this.check(input.agentId, input.path);
    if ("refused" in checked) return { ok: false, ...checked };
    const agent = this.deps.registry.get(input.agentId)!;
    // Written already, where the file changed since the agent loaded: once is enough.
    const there = (roots: string[]) => roots.some((root) => sameFolder(resolve(agent.dir, expandHome(root)), checked.path));
    const saved = await this.write(input.agentId, input.actor, (roots) => (there(roots) ? roots : [...roots, checked.path]), { added: checked.path, ...input.details });
    if (saved) return saved;
    return { ok: true, path: checked.path, skills: (await this.skillsOf(checked.path)).map((skill) => skill.name) };
  }

  /** Take a root away: named by its path as the page lists it, or as written in the file. */
  async remove(input: { agentId: string; path: string; actor: string; details?: Record<string, unknown> }): Promise<SkillRootChange> {
    const agent = this.deps.registry.get(input.agentId);
    if (!agent) return { ok: false, refused: "agent", error: `No agent called "${input.agentId}".` };
    const path = fullPath(input.path) ?? input.path.trim();
    // A root as written is read against the pack, as the loader reads it.
    const named = (written: string) => written.trim() === input.path.trim() || sameFolder(resolve(agent.dir, expandHome(written)), path);
    let found = false;
    const saved = await this.write(
      input.agentId,
      input.actor,
      (roots) => {
        found = roots.some(named);
        return roots.filter((root) => !named(root));
      },
      { removed: path, ...input.details },
    );
    if (saved) return saved;
    if (!found) return { ok: false, refused: "unknown", error: `${path} is not one of ${input.agentId}'s skill roots.` };
    return { ok: true, path, skills: [] };
  }

  /** The pack's file with its roots changed, saved as the Files tab saves it; null once saved, or why it was not. */
  private async write(agentId: string, actor: string, change: (roots: string[]) => string[], details: Record<string, unknown>): Promise<SkillRootChange | null> {
    const read = await this.deps.files.read(agentId, "config.toml");
    if ("error" in read) return { ok: false, refused: "agent", error: read.error };
    const before = read.content;
    let content: string;
    try {
      const roots = writtenRoots(before);
      const next = change(roots);
      if (next.length === roots.length && next.every((root, i) => root === roots[i])) return null;
      content = withRoots(before, next);
    } catch (err) {
      // A file hand-edited since the agent loaded, that no longer parses, or a shape the editor cannot change safely.
      return { ok: false, refused: "unsaved", error: `Saved nothing: ${err instanceof Error ? err.message : String(err)}` };
    }
    const saved = await this.deps.files.write({ agentId, name: "config.toml", content, expected: before, actor, details: { via: "skill_roots", ...details } });
    if (saved.ok) return null;
    return { ok: false, refused: "conflict" in saved ? "conflict" : "unsaved", error: saved.error };
  }

  private async skillsOf(root: string): Promise<{ name: string; description: string }[]> {
    try {
      return await this.deps.projectSkills.ofRoot(root);
    } catch {
      return [];
    }
  }
}
