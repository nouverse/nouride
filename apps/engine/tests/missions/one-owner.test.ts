/**
 * Joint work has one owner (0.8.7): an agent starting a mission while another of its own is open in the same
 * repository is reminded to make it a sub-mission — and may still start it separately. The `mission` tool says how
 * related work is shaped and what a check should prove. And the repository a worktree belongs to, followed to its source.
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { sourceRepositoryOf } from "@/modules/missions/decide.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { missionsHarness } from "./harness.ts";

/** Each folder's repository is the part before `/sub`, a worktree's (`/w/<id>`) the one it was made from: `/repo`. */
const sourceRepository = (workdir: string) => (workdir.startsWith("/w/") ? "/repo" : workdir.split("/sub")[0]!);

async function setup() {
  const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 }, sourceRepository });
  const tools = createMissionTools(h.missions);
  const ctx = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", senderId: "8142" } as ToolContext;
  const start = (args: Record<string, unknown>) => tools.chat.execute({ action: "start", ...args }, ctx);
  return { h, tools, start };
}

describe("a second mission in the same repository", () => {
  test("is started, and the answer reminds the agent of the open one", async () => {
    const { h, start } = await setup();
    const first = await h.start("part one", { workdir: "/w/msn_first", byAgent: "nova" });
    const second = await start({ goal: "part two", workdir: "/repo/sub/app" });
    expect(second.isError).toBe(false);
    expect(second.content).toContain(`${first.id.slice(0, 10)} is still running in this repo; make it a sub-mission, or start separately?`);
  });

  test("no reminder for another repository, another agent's mission, or one that ended", async () => {
    const { h, start } = await setup();
    await h.start("elsewhere", { workdir: "/other", byAgent: "nova" });
    await h.start("nox's own", { agentId: "nox", workdir: "/repo" });
    const ended = await h.start("ended", { workdir: "/repo", byAgent: "nova" });
    h.missions.stop(ended.id, "Gading");
    const answer = await start({ goal: "part two", workdir: "/repo/sub" });
    expect(answer.content).not.toContain("still running in this repo");
  });
});

describe("the tool's guidance", () => {
  test("one parent for related work; checks prove what the work leaves, run in the mission's folder", async () => {
    const { tools } = await setup();
    for (const tool of [tools.chat, tools.inside]) {
      expect(tool.definition.description).toContain("Related pieces of work go in one parent mission, with isolated helpers or sub-missions; the parent merges them.");
      const checks = (tool.definition.parameters as { properties: Record<string, { description: string }> }).properties.checks!.description;
      // Its folder is its worktree only in a repository (0.8.11): a person's documents are worked on where they are.
      expect(checks).toContain("They run in the mission's folder, with nobody to ask and none of your credentials.");
      expect(checks).toContain('never outside state that can change, such as "the PR is open"');
    }
  });
});

describe("the repository a folder's work belongs to", () => {
  const files: Record<string, string> = { "/repo/.git": "", "/m/worktree/.git": "gitdir: /repo/.git/worktrees/worktree\n" };
  const exists = (path: string) => path in files;
  const read = (path: string) => (files[path] ? files[path]! : null);

  test("a folder in a repository is that repository; a worktree is followed to the one it was made from", () => {
    expect(sourceRepositoryOf("/repo/app/src", read, exists)).toBe("/repo");
    expect(sourceRepositoryOf("/m/worktree/app", read, exists)).toBe("/repo");
    expect(sourceRepositoryOf("/plain/folder", read, exists)).toBe("/plain/folder");
  });
});
