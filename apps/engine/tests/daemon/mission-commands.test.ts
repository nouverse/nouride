/**
 * The commands a mission runs as its agent — its folder, its worktree's `git` (`boot/missions.ts`) — get the agent's own
 * HOME where it is its own user, as its other commands do. With the daemon's, git never read the `safe.directory` seeded
 * in the agent's own, and a repository the agent does not own was refused as "dubious".
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentCommandsThrough, whichBinary } from "@nouride/runtime";
import { agentCommand } from "@/boot/missions.ts";

const dirs: string[] = [];
afterEach(() => {
  runAgentCommandsThrough(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world() {
  const workspace = join(mkdtempSync(join(tmpdir(), "nouride-mission-commands-")), "workspace");
  dirs.push(join(workspace, ".."));
  const own = join(workspace, "private/nouva");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, ".gitconfig"), "[safe]\n\tdirectory = *\n");
  return { workspace, own };
}

test("where the agent is its own user, a mission's command has its own folder as HOME, and git reads its config", async () => {
  const { workspace, own } = world();
  // The helper's stand-in runs the command as given: what is tested is what the command is handed.
  runAgentCommandsThrough({ prefix: () => [], put: (_agent, path) => ["/bin/sh", "-c", 'cat > "$0"', path] });
  const run = agentCommand(workspace, "nouva");
  expect(await run(["sh", "-c", 'printf %s "$HOME"'])).toEqual({ ok: true, out: own });
  if (whichBinary("git")) expect((await run(["git", "config", "--global", "--get-all", "safe.directory"])).out.trim()).toBe("*");
});

test("where the agents share the daemon's user, it keeps the daemon's HOME, as before", async () => {
  const { workspace } = world();
  expect(await agentCommand(workspace, "nouva")(["sh", "-c", 'printf %s "$HOME"'])).toEqual({ ok: true, out: process.env.HOME ?? "" });
});
