/**
 * A file a tool writes into an agent's own folders is written as that agent; its pack stays the daemon's to write
 * (`modules/tools/agent-files.ts`).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentCommandsThrough } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { writeAgentFile } from "@/modules/tools/agent-files.ts";
import { createReadTool, editTool, writeTool } from "@/modules/tools/builtins/files.ts";
import { globTool } from "@/modules/tools/builtins/search.ts";

const dirs: string[] = [];
afterEach(() => {
  runAgentCommandsThrough(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "nouride-agent-files-"));
  dirs.push(root);
  const ctx = { agentId: "nouva", ownFolders: [join(root, "workspace/shared"), join(root, "workspace/private/nouva"), join(root, "projects/site")] };
  for (const dir of [...ctx.ownFolders, join(root, "agents/nouva")]) mkdirSync(dir, { recursive: true });
  // A stand-in for the helper's `put`: what it was asked to write, and as whom — its folder made, as the helper does.
  const puts: string[] = [];
  runAgentCommandsThrough({ prefix: () => [], put: (agent, path) => (puts.push(`${agent}:${path}`), ["/bin/sh", "-c", 'mkdir -p "${0%/*}" && cat > "$0"', path]) });
  return { root, ctx, puts };
}

test("into its own folders — shared, private, a declared root — as the agent", async () => {
  const { root, ctx, puts } = world();
  for (const path of [join(root, "workspace/shared/notes.md"), join(root, "workspace/private/nouva/run.sh"), join(root, "projects/site/index.html")]) {
    await writeAgentFile(ctx, path, "x");
    expect(readFileSync(path, "utf-8")).toBe("x");
  }
  expect(puts.map((put) => put.split(":")[0])).toEqual(["nouva", "nouva", "nouva"]);
});

test("into its pack, or anywhere else, as the daemon — and everywhere when agents share the daemon's user", async () => {
  const { root, ctx, puts } = world();
  await writeAgentFile(ctx, join(root, "agents/nouva/MEMORY.md"), "remembered");
  // A folder whose name only starts like one of its own is not one.
  await writeAgentFile(ctx, join(root, "workspace/shared-not/x.md"), "y");
  expect(puts).toEqual([]);
  runAgentCommandsThrough(null);
  await writeAgentFile(ctx, join(root, "workspace/shared/plain.md"), "z");
  expect(readFileSync(join(root, "workspace/shared/plain.md"), "utf-8")).toBe("z");
  expect(puts).toEqual([]);
});

test("through `write` and `edit`, into its own folders named through a link — a declared root, a linked disk — as the agent", async () => {
  // The tools hand over the path with links followed; the folders, as configured, were compared as written.
  const { root, puts } = world();
  const linked = join(realpathSync(root), "linked");
  symlinkSync(realpathSync(root), linked);
  const ctx = {
    agentId: "nouva", sessionId: "s", chatId: "c", gateway: "web", gatewayId: "web", senderId: "u",
    workspaceDir: join(linked, "workspace/shared"),
    agentDir: join(linked, "agents/nouva"),
    workspaceRoots: [join(linked, "workspace/shared"), join(linked, "projects/site"), join(linked, "agents/nouva")],
    ownFolders: [join(linked, "workspace/shared"), join(linked, "projects/site")],
    signal: new AbortController().signal,
  } as ToolContext;
  expect((await writeTool.execute({ path: "run.sh", content: "echo hi\n" }, ctx)).isError).toBe(false);
  expect((await editTool.execute({ path: join(linked, "workspace/shared/run.sh"), old_string: "hi", new_string: "there" }, ctx)).isError).toBe(false);
  expect((await writeTool.execute({ path: join(linked, "projects/site/index.html"), content: "x" }, ctx)).isError).toBe(false);
  expect(readFileSync(join(root, "workspace/shared/run.sh"), "utf-8")).toBe("echo there\n");
  expect(puts.map((put) => put.split(":")[0])).toEqual(["nouva", "nouva", "nouva"]);
});

test("`~/` is the HOME its commands have: its own folder where it is its own user, the daemon's where they share it", async () => {
  // Read as the daemon's, `write ~/.ssh/config` was refused as outside the workspace — the file its own ssh reads.
  const { root, puts } = world();
  const own = join(root, "workspace/private/nouva");
  const ctx = {
    agentId: "nouva", sessionId: "s", chatId: "c", gateway: "web", gatewayId: "web", senderId: "u",
    workspaceDir: join(root, "workspace/shared"),
    agentDir: join(root, "agents/nouva"),
    workspaceRoots: [join(root, "workspace/shared"), own],
    ownFolders: [join(root, "workspace/shared"), own],
    privateDir: own,
    signal: new AbortController().signal,
  } as ToolContext;
  expect((await writeTool.execute({ path: "~/.ssh/config", content: "Host box\n" }, ctx)).isError).toBe(false);
  expect(readFileSync(join(own, ".ssh/config"), "utf-8")).toBe("Host box\n");
  expect(puts).toHaveLength(1);
  expect((await createReadTool().execute({ path: "~/.ssh/config" }, ctx)).content).toContain("Host box");
  expect((await globTool.execute({ pattern: "*", path: "~/.ssh" }, ctx)).content).toContain("config");
  // Where the agents share the daemon's user, `~/` is the daemon's HOME — outside these roots, as before.
  runAgentCommandsThrough(null);
  await expect(writeTool.execute({ path: "~/.ssh/config", content: "x" }, ctx)).rejects.toThrow("path escapes workspace");
});
