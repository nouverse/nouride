import { expandHome, resolve } from "@nouride/runtime";
import { GREEN, RESET, DIM, emit, say, usageError } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";

const USAGE = "Usage: nouride agent skill-root <add|rm> <id> <path>";

/**
 * `nouride agent skill-root add|rm <id> <path>` (0.8.24): a folder whose `.agents/skills/` an agent takes as its own,
 * added or taken away from a terminal as its Skills page does it — checked, written as the Files tab's save writes the
 * pack's config.toml, the agent reloaded, audited (`setup/skill-roots.ts`). A relative path is the one this command runs
 * in, as a person typing `.` in a repository means it; the daemon is told the full path.
 */
export async function skillRootCommand(client: Client, args: string[]): Promise<void> {
  const [verb, id, path] = args;
  if (verb !== "add" && verb !== "rm") usageError(verb ? `\`nouride agent skill-root\` has no "${verb}".` : "Add or remove?", USAGE);
  if (!id || !path) usageError("Which agent, and which folder?", USAGE);
  const full = resolve(process.cwd(), expandHome(path));
  if (verb === "add") {
    const answer = await client.post<{ path: string; skills: string[] }>(`/agents/${id}/skill-roots`, { path: full });
    emit(answer);
    say(`${GREEN}✓${RESET} ${answer.path} is a skill root of ${id}: applied`);
    say(`${DIM}  ${answer.skills.length > 0 ? `its skills: ${answer.skills.join(", ")}` : "it brings no skills yet: they go in its .agents/skills/<name>/SKILL.md"}${RESET}`);
    return;
  }
  const answer = await client.del<{ path: string }>(`/agents/${id}/skill-roots?path=${encodeURIComponent(full)}`);
  emit(answer);
  say(`${GREEN}✓${RESET} ${answer.path} is no longer a skill root of ${id}: applied`);
}
