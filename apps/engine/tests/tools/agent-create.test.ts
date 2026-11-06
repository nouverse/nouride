/**
 * `agent_create` makes a pack, or leaves nothing: a directory with anything in it is somebody's and is not written
 * over, and a pack it made that does not load is removed whole — written around the one config write
 * (`config/config-file.ts`), so this is that pack's rollback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linksFor } from "@/modules/web/links.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "@nouride/persona";
import type { ToolContext } from "@nouride/shared";
import { parseToml } from "@nouride/runtime";
import { createAgentConfigureTool, createAgentCreateTool } from "@/modules/tools/builtins/harness.ts";

let agentsDir: string;
beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "nouride-agent-create-"));
});
afterEach(() => rmSync(agentsDir, { recursive: true, force: true }));

const ctx = { agentId: "nouva", senderId: "op" } as ToolContext;
/** An install with a default model, as most are: a pack that names none takes it. */
const LLM = { defaults: () => ({ provider: "local", model: "m-1" }), orchestrator: () => undefined };
const args = { id: "helper", headline: "Helps.", soul: "Be brief." };

function tool(reload: () => Promise<void>) {
  const registry = { get: () => undefined, reload } as unknown as AgentRegistry;
  return createAgentCreateTool({ registry, agentsDir, providers: () => [], llm: LLM });
}

describe("agent_create", () => {
  test("a directory with anything in it is not written over — a MEMORY.md with no IDENTITY.md is somebody's too", async () => {
    mkdirSync(join(agentsDir, "helper"));
    writeFileSync(join(agentsDir, "helper", "MEMORY.md"), "the only copy");
    const result = await tool(async () => {}).execute(args, ctx);
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining("already exists on disk") });
    expect(readFileSync(join(agentsDir, "helper", "MEMORY.md"), "utf8")).toBe("the only copy");
    expect(existsSync(join(agentsDir, "helper", "IDENTITY.md"))).toBe(false);
  });

  test("a pack it made that does not load is removed whole, so the id is free to try again", async () => {
    const result = await tool(async () => {
      throw new Error('no provider profile "nowhere"');
    }).execute(args, ctx);
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining("nothing was kept") });
    expect(existsSync(join(agentsDir, "helper"))).toBe(false);
  });

  test("one that loads stays", async () => {
    const result = await tool(async () => {}).execute(args, ctx);
    expect(result.isError).toBe(false);
    expect(readFileSync(join(agentsDir, "helper", "SOUL.md"), "utf8")).toContain("Be brief.");
    // Its headline is what its peers read about it (0.7.18).
    expect(readFileSync(join(agentsDir, "helper", "IDENTITY.md"), "utf8")).toContain("- **Headline:** Helps.");
  });

  test("its SOUL.md has one heading: a soul that brings its own keeps it, one without gets `# SOUL` (0.8.6)", async () => {
    // Kuro's soul came as "# SOUL …" and the file said `# SOUL` twice, which its CLI then read (the live box, 0.8.5).
    await tool(async () => {}).execute({ ...args, soul: "# SOUL\n\nYou are Kuro." }, ctx);
    expect(readFileSync(join(agentsDir, "helper", "SOUL.md"), "utf8")).toBe("# SOUL\n\nYou are Kuro.\n");
    await tool(async () => {}).execute({ ...args, id: "plain" }, ctx);
    expect(readFileSync(join(agentsDir, "plain", "SOUL.md"), "utf8")).toBe("# SOUL\n\nBe brief.\n");
  });

  test("a headline is one short line: longer than 150 characters is refused, and nothing is written", async () => {
    const result = await tool(async () => {}).execute({ ...args, headline: "x".repeat(151) }, ctx);
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining("150 characters") });
    expect(existsSync(join(agentsDir, "helper", "IDENTITY.md"))).toBe(false);
  });
});

/**
 * `agent_configure` writes the caller's own `[llm]` through the one editor every config write uses. Its own regex
 * found `model =` in any table, and missed an `[llm]` header with a comment after it — appending a second `[llm]`,
 * a file TOML refuses as defined twice.
 */
describe("agent_configure", () => {
  const configure = (reload: () => Promise<void> = async () => {}) => {
    const registry = { get: () => undefined, reload } as unknown as AgentRegistry;
    return createAgentConfigureTool({
      registry,
      agentsDir,
      providers: () => [{ name: "local", kind: "openai", baseUrl: "http://127.0.0.1:1/v1", hasCredential: true }],
      llm: LLM,
    });
  };
  const pack = (text: string) => {
    mkdirSync(join(agentsDir, "nouva"), { recursive: true });
    writeFileSync(join(agentsDir, "nouva", "config.toml"), text);
    return join(agentsDir, "nouva", "config.toml");
  };

  test("an [llm] header with a comment after it is the table the model goes in", async () => {
    const path = pack('[agent]\nname = "Nouva"\nmodel = "not this one"\n\n[llm] # which endpoint\nprovider = "local"\n');
    const result = await configure().execute({ model: "m-2" }, ctx);
    expect(result.isError).toBe(false);
    const toml = parseToml<Record<string, Record<string, unknown>>>(readFileSync(path, "utf8"));
    expect(toml.llm).toEqual({ provider: "local", model: "m-2" });
    expect(toml.agent?.model).toBe("not this one");
    expect(readFileSync(path, "utf8")).toContain("[llm] # which endpoint");
  });

  test("its effort (0.8.7): set in [llm] beside the model, taken away by default — and only a level it knows", async () => {
    const path = pack('[llm]\nprovider = "local"\nmodel = "m-1"\n');
    expect((await configure().execute({ effort: "xhigh" }, ctx)).content).toContain("effort=xhigh");
    expect(parseToml<Record<string, Record<string, unknown>>>(readFileSync(path, "utf8")).llm).toEqual({ provider: "local", model: "m-1", effort: "xhigh" });
    expect((await configure().execute({ effort: "default" }, ctx)).isError).toBe(false);
    expect(parseToml<Record<string, Record<string, unknown>>>(readFileSync(path, "utf8")).llm).toEqual({ provider: "local", model: "m-1" });
    const refused = await configure().execute({ effort: "huge" }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("low, medium, high, xhigh, max, default");
    expect(readFileSync(path, "utf8")).toBe('[llm]\nprovider = "local"\nmodel = "m-1"\n');
  });

  test("a coding CLI's agent sets its effort, and never [llm]'s model: `model` is its CLI's, refused here with no list of its own (0.8.8)", async () => {
    const path = pack('[llm]\nprovider = "local"\nmodel = "m-1"\n\n[external]\ncli = "claude-code"\n');
    const registry = { get: () => ({ config: { id: "nouva", external: { cli: "claude-code" } } }), reload: async () => {} } as unknown as AgentRegistry;
    const tool = createAgentConfigureTool({ registry, agentsDir, providers: () => [{ name: "local", kind: "openai", baseUrl: "http://127.0.0.1:1/v1", hasCredential: true }], llm: LLM });
    const model = await tool.execute({ model: "opus" }, ctx);
    expect(model.isError).toBe(true);
    expect(model.content).toContain("claude-code has not said which models it offers");
    expect((await tool.execute({ effort: "max" }, ctx)).isError).toBe(false);
    expect(parseToml<Record<string, Record<string, unknown>>>(readFileSync(path, "utf8")).llm).toEqual({ provider: "local", model: "m-1", effort: "max" });
  });

  test("a change the agent cannot load with is put back", async () => {
    const path = pack('[llm]\nprovider = "local"\nmodel = "m-1"\n');
    const result = await configure(async () => {
      if (readFileSync(path, "utf8").includes("m-broken")) throw new Error("no such model");
    }).execute({ model: "m-broken" }, ctx);
    expect(result.isError).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('[llm]\nprovider = "local"\nmodel = "m-1"\n');
  });
});

describe("on the fixed list", () => {
  /** A `config.toml` written is asked at `balanced` too (SIMPLIFY RFC §1, item 1): what decides what an agent may do. */
  test("creating an agent and changing one's own model are both a config written — never a standing grant", () => {
    const options = { registry: {} as AgentRegistry, agentsDir: "/nowhere", providers: () => [], llm: LLM };
    for (const made of [createAgentCreateTool(options), createAgentConfigureTool(options)]) {
      expect(made.fixedList?.({}, {} as ToolContext)).toMatchObject({ class: "config", reason: expect.stringContaining("config.toml") });
    }
  });
});

describe("agent_create, an external agent or a look (0.8.1)", () => {
  const clis = async () => [
    { id: "claude-code", name: "Claude Code", installed: true, install: "npm i -g @agentclientprotocol/claude-agent-acp" },
    { id: "codex", name: "Codex", installed: false, install: "npm i -g @agentclientprotocol/codex-acp" },
  ];
  const make = (llm: Parameters<typeof createAgentCreateTool>[0]["llm"] = LLM) =>
    createAgentCreateTool({ registry: { get: () => undefined, reload: async () => {} } as unknown as AgentRegistry, agentsDir, providers: () => [], clis, linkFor: linksFor({ dashboard: () => ({ publicUrl: "https://agents.example.com/" }), hasAccount: () => true }), llm });
  const config = () => parseToml(readFileSync(join(agentsDir, "helper", "config.toml"), "utf8")) as Record<string, Record<string, unknown>>;

  test("on a CLI installed here: its [external], and the way to its sign-in — the Brain tab, never the code in a chat", async () => {
    const result = await make().execute({ ...args, external: { cli: "claude-code", profile: "work" } }, ctx);
    expect(result.isError).toBe(false);
    expect(config().external).toEqual({ cli: "claude-code", profile: "work" });
    expect(result.content).toContain('answers with Claude Code on the account "work"');
    expect(result.content).toContain("https://agents.example.com/dashboard/agents/helper/cli");
    expect(result.content).toContain("never ask for the code in a chat");
  });

  test("on a CLI not installed here: refused with how to install it, and nothing written", async () => {
    const result = await make().execute({ ...args, external: { cli: "codex" } }, ctx);
    const said = String(result.content);
    expect(result.isError).toBe(true);
    expect(said).toContain("Codex is not installed on this machine");
    expect(said).toContain("npm i -g @agentclientprotocol/codex-acp");
    expect(said).toContain("the orchestrator can, through `nouride tools run`");
    expect(existsSync(join(agentsDir, "helper"))).toBe(false);
    const unknown = await make().execute({ ...args, external: { cli: "cursor" } }, ctx);
    expect([unknown.isError, String(unknown.content).includes("claude-code, codex")]).toEqual([true, true]);
  });

  test("on an install with no default model, Nouride's own for it is the orchestrator's; the CLI's model is its [external] (0.8.1)", async () => {
    // On the live box — no default model — the orchestrator passed the CLI's model as `model`: it went into [llm] with no
    // provider, and the pack did not load (`[llm] provider ""`); from the dashboard, the same agent was refused outright.
    const none = { defaults: () => ({ provider: "", model: "" }), orchestrator: () => ({ provider: "nougate-anthropic", model: "gemini-x" }) };
    const result = await make(none).execute({ ...args, external: { cli: "claude-code", profile: "work", model: "sonnet" } }, ctx);
    expect(result.isError).toBe(false);
    expect(config().llm).toEqual({ provider: "nougate-anthropic", model: "gemini-x" });
    expect(config().external).toEqual({ cli: "claude-code", profile: "work", model: "sonnet" });
  });

  test("a model with no provider where the install has none, or no model at all, is said before anything is written", async () => {
    const none = { defaults: () => ({ provider: "", model: "" }), orchestrator: () => undefined };
    const unnamed = await make(none).execute({ ...args, model: "gpt-5.6-luna", external: { cli: "claude-code" } }, ctx);
    expect([unnamed.isError, String(unnamed.content).includes("This install has no default provider: give `provider` with `model`")]).toEqual([true, true]);
    const nothing = await make(none).execute(args, ctx);
    expect([nothing.isError, String(nothing.content).includes("This install has no default model")]).toEqual([true, true]);
    expect(existsSync(join(agentsDir, "helper"))).toBe(false);
  });

  test("a look's word not on its part's list is refused with the list, and nothing written (0.8.1)", async () => {
    // The loader refused "solid", then "yellow", one part a try, after each pack was written and removed again.
    const refused = await make().execute({ ...args, look: { fur: "black", pattern: "solid" } }, ctx);
    expect([refused.isError, String(refused.content)]).toEqual([true, 'look\'s pattern is one of plain, tabby, not "solid".']);
    expect(existsSync(join(agentsDir, "helper"))).toBe(false);
    const look = (make().definition.parameters as { properties: { look: { properties: Record<string, { enum: string[] }> } } }).properties.look;
    expect(look.properties.eyes!.enum).toEqual(["round", "sleepy", "sparkly"]);
  });

  test("a look is its [look] by the pack's keys; a part it does not know is refused, and nothing written", async () => {
    const refused = await make().execute({ ...args, look: { fur: "white", ears: "big" } }, ctx);
    expect([refused.isError, String(refused.content).includes('"ears" is not a part of a look')]).toEqual([true, true]);
    expect(existsSync(join(agentsDir, "helper"))).toBe(false);
    expect((await make().execute({ ...args, look: { fur: "white", outfit_color: "lime", hat: "headphones" } }, ctx)).isError).toBe(false);
    expect(config().look).toEqual({ fur: "white", outfit_color: "lime", hat: "headphones" });
  });
});

