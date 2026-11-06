/**
 * An external agent's Nouride skills, where its CLI reads its own (0.8.1): each copied into the CLI's skills folder in
 * the agent's profile of it (`skillsDir` on its row — Claude Code's `$CLAUDE_CONFIG_DIR/skills`), read whatever folder
 * the CLI works in, so the Skills tab means the same for it as for any agent. Written as the agent, only when what it should hold changed: when its pack reloads — a skill
 * switched on or off — so a CLI that watches the folder has them before the next message, and before each turn.
 *
 * Only what Nouride put there is Nouride's: the names it copied are kept in `.nouride-skills`, and a skill switched
 * off is removed by that list — a skill the person put in that folder themselves is never touched.
 */

import { dirname, join, linkTarget, listDir, readFileBytes, readPlainTextFile, runCommand, statFile, writeFileAsAgent } from "@nouride/runtime";
import type { CliRow } from "@nouride/acp";
import { missingToolsFor } from "@nouride/persona";
import type { LoadedAgent, Skill } from "@nouride/shared";
import { lends } from "./lent-tools.ts";

const KEPT = ".nouride-skills";
/** A line a skill: far more than any agent holds. */
const KEPT_MAX_BYTES = 256 * 1024;
/** A skill's folder name: what a CLI shows it as, and nothing a shell or a path could read otherwise. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Nouride's tools a CLI has its own of: its files, its shell, the web — and `multi_edit` and `session`, the same files
 * and shell (0.8.13: a skill naming them was marked missing on every coding CLI's agent).
 */
const CLI_OWN = new Set(["exec", "read", "write", "edit", "multi_edit", "glob", "grep", "session", "web_fetch", "web_search"]);
/**
 * The tools a skill can count on where a coding CLI answers: the CLI's own files, shell and web, and the agent's tools
 * Nouride lends it. Read for the copy, and by the Skills page — which counted an external agent's Nouride toolset, and
 * marked every skill needing `exec` as one it lacked (Kuro, on the live box).
 */
export function toolsOfCli(enabled: readonly string[]): string[] {
  return [...CLI_OWN, ...enabled.filter(lends)];
}

/**
 * A tool no coding CLI is ever given — neither its own nor lent: `nouride`, `update`, `session_status` (`lent-tools.ts`
 * says why). A skill needing one is not copied to the CLI (`syncSkills`), and no pack edit changes that — so the Skills
 * page says so (0.8.13) rather than warning that the agent lacks it and telling the person to add it: the yellow "!" on
 * Kuro, Nix and Nox for the `nouride` skill, which nothing could clear.
 */
export const neverForCli = (tool: string): boolean => !CLI_OWN.has(tool) && !lends(tool);

/** A skill is a few files; one that is not is not copied whole into every agent's folder. */
const MOST_FILES = 200;

/**
 * What a skill's folder holds, as its files' count and size and its newest change: a file edited, added or removed
 * anywhere in it changes it. Its `SKILL.md` and folder alone missed an edit to a file in `references/`.
 */
function stampOf(root: string): string {
  let files = 0;
  let bytes = 0;
  let newest = statFile(root)?.mtimeMs ?? 0;
  const walk = (dir: string) => {
    for (const entry of listDir(dir)) {
      if (files > MOST_FILES) return;
      const at = join(dir, entry.name);
      const link = linkTarget(at);
      if (link !== null) {
        files += 1;
        bytes += link.length;
        continue;
      }
      const stat = statFile(at);
      newest = Math.max(newest, stat?.mtimeMs ?? 0);
      if (entry.isDirectory) {
        walk(at);
        continue;
      }
      files += 1;
      bytes += stat?.size ?? 0;
    }
  };
  walk(root);
  return `${files} ${bytes} ${newest}`;
}

/** A skill's files, and its links as links — each by its path inside it. */
interface SkillFiles {
  files: { path: string; data: Uint8Array }[];
  links: { path: string; target: string }[];
}

/**
 * Every file under a skill's folder, by its path inside it — read as the daemon, which can; null where it cannot. A
 * link stays a link: x-twitter-poster links `node_modules/playwright` to the box's own, and read as a file it was a
 * folder, and the whole skill was left out as unreadable (the live box). A link gives the agent nothing its user
 * cannot already read.
 */
async function filesOf(root: string): Promise<SkillFiles | null> {
  const files: SkillFiles["files"] = [];
  const links: SkillFiles["links"] = [];
  const walk = async (dir: string, inside: string): Promise<boolean> => {
    for (const entry of listDir(dir)) {
      const at = join(dir, entry.name);
      const name = inside ? `${inside}/${entry.name}` : entry.name;
      const target = linkTarget(at);
      if (target !== null) {
        links.push({ path: name, target });
        continue;
      }
      if (entry.isDirectory) {
        if (!(await walk(at, name))) return false;
        continue;
      }
      try {
        files.push({ path: name, data: await readFileBytes(at) });
      } catch {
        return false;
      }
      if (files.length > MOST_FILES) return false;
    }
    return true;
  };
  return (await walk(root, "")) && files.length > 0 ? { files, links } : null;
}

/**
 * Copy the agent's skills into its CLI's skills folder in `folder` — its profile; none where the row names no folder. The daemon reads
 * them — a skill's folder is the daemon's, not every agent's to read — and writes them as the agent. Returns the skills
 * it could not read, for the turn to say.
 *
 * `project` is what the folders in its `skill_roots` bring (`ProjectSkills`): a CLI works in its own folder, not the
 * repository, so it read none of them — its pack named /opt/projects/nouride and the repo's testing skill never reached
 * it (0.8.9). A project skill named like one of the agent's own is left out, as the prompt leaves it out
 * (`skillsInScope`): a repository somebody else writes to does not replace what the operator gave the agent.
 */
export async function syncSkills(agent: LoadedAgent, row: CliRow, folder: string, run: typeof runCommand = runCommand, project: readonly Skill[] = []): Promise<string[]> {
  if (!row.skillsDir) return [];
  const target = join(folder, row.skillsDir);
  // Not one that needs a tool the CLI neither has nor is lent — `nouride`, `secret_save`: it would send the CLI to a tool
  // it cannot call (Nix was given the nouride skill, on the live box).
  const held = toolsOfCli(agent.config.tools.enabled);
  // Nor one whose folder is gone since the agent loaded: archived by a merge while this copy waited behind an earlier
  // reload's. It is gone, not unreadable — taken out here as the next reload's copy would — and was said as a skill the
  // CLI could not be given (0.8.8, the live box: three approvals, github-pr named for each CLI agent).
  const owned = new Set(agent.skills.map((skill) => skill.name));
  const inScope = [...agent.skills, ...project.filter((skill) => !owned.has(skill.name))];
  const skills = inScope.filter((skill) => SAFE.test(skill.name) && missingToolsFor(skill, held).length === 0 && statFile(dirname(skill.path))?.isDirectory === true);
  // What it should hold, with what each source holds: unchanged, nothing is written.
  const lines = new Map(skills.map((skill) => [skill.name, `${skill.name} ${stampOf(dirname(skill.path))}`]));
  const wanted = [...lines.values()].sort();
  // In the agent's folder, which its CLI writes: read only as a plain file (`readPlainTextFile`).
  const kept = readPlainTextFile(join(target, KEPT), KEPT_MAX_BYTES) ?? "";
  if (kept === `${wanted.join("\n")}\n`) return [];
  const before = new Map(kept.split("\n").map((line) => [line.split(" ")[0] ?? "", line] as const).filter(([name]) => SAFE.test(name)));
  // Only what changed is touched: a skill taken out and written again was missing meanwhile, to a CLI watching the folder.
  const changed = skills.filter((skill) => before.get(skill.name) !== lines.get(skill.name));
  const copied = await Promise.all(changed.map(async (skill) => ({ name: skill.name, files: await filesOf(dirname(skill.path)) })));
  const skipped = copied.filter((skill) => !skill.files).map((skill) => skill.name);
  const gone = [...[...before.keys()].filter((name) => !lines.has(name)), ...copied.map((skill) => skill.name)];
  const entries = copied.flatMap((skill) => [...(skill.files?.files ?? []), ...(skill.files?.links ?? [])].map((entry) => `${skill.name}/${entry.path}`));
  const dirs = [...copied.map((skill) => skill.name), ...entries.map(dirname)];
  const links = copied.flatMap((skill) => (skill.files?.links ?? []).flatMap((link) => [`${skill.name}/${link.path}`, link.target]));
  // Old copies out, folders made and links made, as the agent, in one step: paths are arguments, never spliced in.
  const script = [
    "set -e",
    'target="$1"; shift',
    'mkdir -p "$target"',
    'while [ "$1" != "--" ]; do rm -rf "$target/$1"; shift; done; shift',
    'while [ "$1" != "--" ]; do mkdir -p "$target/$1"; shift; done; shift',
    'while [ "$#" -gt 1 ]; do ln -sfn "$2" "$target/$1"; shift 2; done',
  ].join("\n");
  const out = await run(["sh", "-c", script, "nouride-skills", target, ...gone, "--", ...new Set(dirs), "--", ...links], { cwd: folder, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000, maxOutputBytes: 4096, agent: agent.config.id });
  if (out.exitCode !== 0) throw new Error(`could not make its skills folder: ${out.stderr.trim() || `exit ${out.exitCode}`}`);
  for (const skill of copied) for (const file of skill.files?.files ?? []) await writeFileAsAgent(agent.config.id, join(target, skill.name, file.path), file.data);
  await writeFileAsAgent(agent.config.id, join(target, KEPT), `${wanted.join("\n")}\n`);
  return skipped;
}

/**
 * Each agent's copies one at a time: a reload's and a turn's together would each remove what the other was writing.
 * Each waits for the one before it, failed or not.
 */
export class SkillCopies {
  private readonly last = new Map<string, Promise<string[]>>();

  run(agentId: string, copy: () => Promise<string[]>): Promise<string[]> {
    const next = (this.last.get(agentId) ?? Promise.resolve([])).catch(() => []).then(copy);
    this.last.set(agentId, next);
    return next;
  }
}
