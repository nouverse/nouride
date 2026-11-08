/**
 * The files a mission hands back are checked when it says it is done (0.8.12), while its agent can still name them
 * right. Live: Nouva named its video `worktree/apps/sam/out/…mp4` from inside the worktree, the path held a
 * `worktree` twice and nothing was there, and the person got "Not sent as files" at the end.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@nouride/shared";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { missionsHarness } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-done-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const inside = (missionId: string): ToolContext =>
  ({ agentId: "nova", sessionId: "s", chatId: missionId, gateway: "web", gatewayId: "web:mission", senderId: "8142", chatType: "dm", workspaceDir: dir, agentDir: dir, workspaceRoots: [dir], signal: new AbortController().signal }) as ToolContext;

test("a file that is not there, or a folder, is refused with the path it resolved to; one that is there is taken", async () => {
  const h = await missionsHarness();
  const mission = await h.start("render the video", { workdir: dir });
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "video.mp4"), "mp4");
  const { inside: tool } = createMissionTools(h.missions);
  const done = (files: string[]) => tool.execute({ action: "done", summary: "Rendered.", report: "Rendered the video.", files }, inside(mission.id));

  const missing = await done(["worktree/out/video.mp4"]);
  expect(missing.isError).toBe(true);
  expect(String(missing.content)).toContain(`${join(dir, "worktree/out/video.mp4")} does not exist`);
  expect(String(missing.content)).toContain(`Relative paths start at the mission's folder, ${dir}`);

  const folder = await done(["out"]);
  expect(folder.isError).toBe(true);
  expect(String(folder.content)).toContain("is a folder");

  const taken = await done(["out/video.mp4"]);
  expect(taken.isError).toBeFalsy();
});
