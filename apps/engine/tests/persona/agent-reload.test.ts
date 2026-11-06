/**
 * Reloading a pack has to tell the subsystems that read it.
 *
 * `[[mcp_servers]]` is in an agent's `config.toml`, and connections were opened once at boot and never
 * revisited — so editing a server's command and reloading left the daemon talking to the old one while
 * reporting success. The failure shape is the worst kind: the change appears to apply, and the only
 * evidence is behaviour that belongs to a config nobody can see any more.
 *
 * Found by moving a server's checkout on a live box and watching its child process keep running with
 * its working directory pointing at the deleted path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LoadedAgent } from "@nouride/shared";
import { removePath, writeTextFile } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { tempDir, writeAgentPack } from "../helpers.ts";

let agentsDir: string;

const DEFAULTS = { provider: "test", model: "test-model", maxTokens: 1000, temperature: 0.5 };

beforeEach(() => {
  agentsDir = tempDir("agents-reload");
});

afterEach(() => {
  removePath(agentsDir);
});

async function registry(): Promise<AgentRegistry> {
  await writeAgentPack(agentsDir, {
    id: "nouva",
    configToml: '[llm]\nprovider = "test"\n',
  });
  return await AgentRegistry.create({
    agentsDir,
    llmDefaults: DEFAULTS,
    knownProviders: ["test"],
  });
}

describe("onReloaded", () => {
  test("fires for one pack reloaded in place, carrying the freshly read config", async () => {
    const reg = await registry();
    const seen: LoadedAgent[] = [];
    reg.onReloaded((agent) => seen.push(agent));

    // The edit a reload is supposed to pick up.
    await writeTextFile(join(agentsDir, "nouva", "config.toml"), '[llm]\nprovider = "test"\nmodel = "fresh-model"\n\n[tools]\nenabled = ["read", "plan"]\n');

    await reg.reload("nouva");

    expect(seen).toHaveLength(1);
    // The *new* config, not the one the registry booted with. A listener handed the stale pack would
    // keep exactly what the reload was meant to replace.
    expect(seen[0]?.config.llm.model).toBe("fresh-model");
    expect(seen[0]?.config.tools.enabled).toEqual(["read", "plan"]);
  });

  test("fires for every pack on reloadAll", async () => {
    const reg = await registry();
    await writeAgentPack(agentsDir, { id: "nox", configToml: '[llm]\nprovider = "test"\n' });

    const seen: string[] = [];
    reg.onReloaded((agent) => seen.push(agent.config.id));
    await reg.reloadAll();

    expect(seen.sort()).toEqual(["nouva", "nox"]);
  });

  test("a listener that throws fails neither the reload nor the listeners after it", async () => {
    // `/reset` calls reload and reports the result to the user. A subsystem failing to reconnect is
    // worth a log line, not an error message for work that did land.
    const reg = await registry();
    const seen: string[] = [];
    reg.onReloaded(() => {
      throw new Error("first one exploded");
    });
    reg.onReloaded((agent) => seen.push(agent.config.id));

    await reg.reload("nouva");
    expect(seen).toEqual(["nouva"]);
  });

  test("nothing is announced before anyone is listening", async () => {
    // `AgentRegistry.create` reloads before a caller can subscribe, and at boot the MCP manager does
    // not exist yet. Registering must not depend on having been there for the first load.
    const seen: string[] = [];
    const reg = await registry();
    reg.onReloaded((agent) => seen.push(agent.config.id));
    expect(seen).toEqual([]);
  });
});
