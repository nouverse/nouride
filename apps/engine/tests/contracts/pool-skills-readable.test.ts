/**
 * A shared skill must be readable by the tool the prompt tells the agent to use.
 *
 * Found live, and the symptom is the reason this test exists rather than an assertion buried in a
 * bigger one: the agent asked `read` for the exact path the system prompt had named, was refused for
 * escaping the workspace, retried with `exec cat`, and answered correctly. Nothing looked broken.
 * A sandbox that refuses the file tools and permits a shell is a limit that exists on paper.
 *
 * The pool sits in `agents/skills/`, a sibling of every pack rather than inside one, so it is a read
 * root and nothing else. It is also the only place skills live now — there is no per-agent skills
 * folder to fall back on, which makes this the whole story rather than the awkward half of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { rootsFor } from "@/modules/tools/builtins/files.ts";
import { createReadTool, writeTool } from "@/modules/tools/builtins/files.ts";
import type { ToolContext } from "@nouride/shared";

const readTool = createReadTool();

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-shared-skills-"));
const AGENTS = join(DIR, "agents");
const PACK = join(AGENTS, "nouva");
const POOL = join(AGENTS, "skills");
/** `skills/` beside the executable — what `resolveBuiltinSkillsDir()` finds on an install. */
const BUILTIN = join(DIR, "install", "skills");

function context(): ToolContext {
  return {
    agentId: "nouva",
    sessionId: "s",
    chatId: "c",
    gateway: "telegram",
    gatewayId: "telegram:main",
    senderId: "u",
    workspaceDir: join(DIR, "workspace"),
    agentDir: PACK,
    // What the pipeline supplies: the pack is writable, the skill pool is not.
    workspaceRoots: [join(DIR, "workspace"), PACK],
    readOnlyRoots: [POOL, BUILTIN],
    signal: new AbortController().signal,
  } as ToolContext;
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(POOL, "infrastructure-ops"), { recursive: true });
  mkdirSync(join(BUILTIN, "document-reading"), { recursive: true });
  mkdirSync(join(DIR, "workspace"), { recursive: true });
  writeFileSync(join(POOL, "infrastructure-ops", "SKILL.md"), "---\nname: infrastructure-ops\n---\nSubnet is 192.168.1.x\n");
  writeFileSync(
    join(BUILTIN, "document-reading", "SKILL.md"),
    "---\nname: document-reading\n---\nConvert to a file, never into your reply.\n",
  );
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("a pooled skill", () => {
  test("can be read", async () => {
    const result = await readTool.execute(
      { path: join(POOL, "infrastructure-ops", "SKILL.md") },
      context(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("192.168.1.x");
  });

  test("cannot be written — it belongs to every agent, not the one holding the pen", async () => {
    // The file tools *throw* a `ToolError` on a sandbox refusal rather than returning `isError`; the
    // executor turns it into a tool result. Asserted as a rejection because that is what the code
    // does — a test written against the shape it ought to have would pass on a tool that returned
    // success, which is the failure this is guarding.
    await expect(
      writeTool.execute(
        { path: join(POOL, "infrastructure-ops", "SKILL.md"), content: "rewritten" },
        context(),
      ),
    ).rejects.toThrow(/escapes workspace|not writable/);
  });

  test("is in the read roots but not the write roots", () => {
    expect(rootsFor(context(), "read")).toContain(POOL);
    expect(rootsFor(context(), "write")).not.toContain(POOL);
  });
});

/**
 * The same bug, in a directory added after it was fixed.
 *
 * Skills that ship with the build live in `skills/` beside the executable, not under `agents/`. They are
 * advertised to the agent by absolute path in the SKILLS block exactly like a pooled one — and the read
 * sandbox knew about the pool and the project roots and not about this one. Watched live on the first
 * document that needed a skill: the agent asked `read` for the path the prompt had just named, was
 * refused in 2ms, and fell back to guessing at `pdftotext`. Which is the whole point of shipping the
 * skill, missed by one root.
 */
describe("a skill that ships with the build", () => {
  test("can be read, like a pooled one", async () => {
    const result = await readTool.execute(
      { path: join(BUILTIN, "document-reading", "SKILL.md") },
      context(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("never into your reply");
  });

  test("cannot be written — it belongs to the build, not to the agent", async () => {
    await expect(
      writeTool.execute(
        { path: join(BUILTIN, "document-reading", "SKILL.md"), content: "rewritten" },
        context(),
      ),
    ).rejects.toThrow(/escapes workspace|not writable/);
  });
});
