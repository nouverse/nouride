/**
 * An agent's MEMORY.md as its next prompt reads it. The file is the one part of a pack the agent writes itself, and a
 * pack was read only as it loaded: what an agent wrote was on disk at once and in no prompt until a restart or a
 * reload. The registry now hands out the file as it is, without a reload's listeners.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMDefaultsSection } from "@nouride/shared";
import { writeTextFile } from "@nouride/runtime";
import { AgentRegistry } from "../src/registry.ts";

const DEFAULTS: LLMDefaultsSection = { provider: "anthropic", model: "claude-sonnet-4-20250514", maxTokens: 8192, temperature: 0.7 };

let agentsDir: string;
const memoryOf = (id: string) => join(agentsDir, id, "MEMORY.md");

beforeEach(async () => {
  agentsDir = mkdtempSync(join(tmpdir(), "nouride-memory-fresh-"));
  await writeTextFile(join(agentsDir, "nova", "IDENTITY.md"), "# IDENTITY\n- Name: nova\n");
  await writeTextFile(join(agentsDir, "nero", "IDENTITY.md"), "# IDENTITY\n- Name: nero\n");
});

afterEach(() => rmSync(agentsDir, { recursive: true, force: true }));

test("what is written to MEMORY.md after the pack loaded is what the agent holds next, with no reload", async () => {
  await writeTextFile(memoryOf("nova"), "# Memory\n\nThe old line.\n");
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULTS });
  const reloaded: string[] = [];
  registry.onReloaded((agent) => reloaded.push(agent.config.id));
  expect(registry.get("nova")!.persona.memory).toContain("The old line.");

  await writeTextFile(memoryOf("nova"), "# Memory\n\nThe old line.\n\nA standing request, written a moment ago.\n");

  expect(registry.get("nova")!.persona.memory).toContain("A standing request, written a moment ago.");
  // The rest of the pack is the same pack: a reload's listeners reconnect MCP servers, and a note is no reason to.
  expect(reloaded).toEqual([]);
  expect(registry.get("nova")!.persona.identity).toContain("nova");
});

test("a list of agents holds the file as it is too, asked before anyone asked for the one agent", async () => {
  // A message is matched against the list of agents, and the turn runs with the agent found there: a list that kept
  // the loaded text was a prompt that did, whatever `get` handed out.
  for (const list of ["all", "enabled", "active"] as const) {
    await writeTextFile(memoryOf("nova"), "The old line.\n");
    const registry = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULTS });
    await writeTextFile(memoryOf("nova"), `Kept later, read through ${list}.\n`);
    expect(registry[list]().find((agent) => agent.config.id === "nova")!.persona.memory).toBe(`Kept later, read through ${list}.\n`);
  }
});

test("a file that did not change hands out the same agent, and another agent's file is not this one's", async () => {
  await writeTextFile(memoryOf("nova"), "Nova's own note.\n");
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULTS });
  const first = registry.get("nova");
  expect(registry.get("nova")).toBe(first);

  await writeTextFile(memoryOf("nero"), "Nero's note, written later.\n");
  expect(registry.get("nova")).toBe(first);
  expect(registry.get("nero")!.persona.memory).toBe("Nero's note, written later.\n");
  expect(registry.get("nova")!.persona.memory).toBe("Nova's own note.\n");
});

test("a MEMORY.md made after the pack loaded is read, and one emptied or deleted is no longer held", async () => {
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULTS });
  expect(registry.get("nova")!.persona.memory).toBeUndefined();

  await writeTextFile(memoryOf("nova"), "The first thing kept.\n");
  expect(registry.get("nova")!.persona.memory).toBe("The first thing kept.\n");

  await writeTextFile(memoryOf("nova"), "");
  expect(registry.get("nova")!.persona.memory).toBeUndefined();

  await writeTextFile(memoryOf("nova"), "Kept again.\n");
  expect(registry.get("nova")!.persona.memory).toBe("Kept again.\n");
  rmSync(memoryOf("nova"));
  expect(registry.get("nova")!.persona.memory).toBeUndefined();
});

test("a reload still reads the whole pack, and the file read after it is the file", async () => {
  await writeTextFile(memoryOf("nova"), "Before the reload.\n");
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: DEFAULTS });
  await writeTextFile(memoryOf("nova"), "After the reload.\n");

  const agent = await registry.reload("nova");

  expect(agent.persona.memory).toBe("After the reload.\n");
  expect(registry.get("nova")!.persona.memory).toBe("After the reload.\n");
});
