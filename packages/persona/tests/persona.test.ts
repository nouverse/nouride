import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMDefaultsSection } from "@nouride/shared";
import { ensureDir, removePath, writeTextFile } from "@nouride/runtime";
import { parseAgentConfig, parseMcpServers } from "../src/config.ts";
import { discoverAgents, loadAgent } from "../src/loader.ts";
import { parseFrontmatter } from "../src/skills.ts";
import { unknownPackKeys } from "../src/pack-keys.ts";

const DEFAULTS: LLMDefaultsSection = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  maxTokens: 8192,
  temperature: 0.7,
};

let agentsDir: string;

async function writeAgent(
  id: string,
  files: Record<string, string>,
  /** Defaults to the suite's shared directory. The workspace-root tests need their own. */
  root: string = agentsDir,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeTextFile(join(root, id, name), content);
  }
}

beforeAll(async () => {
  agentsDir = mkdtempSync(join(tmpdir(), "nouride-agents-"));

  await writeAgent("nox", {
    "IDENTITY.md": "# IDENTITY\n- Name: Nox\n",
    "SOUL.md": "Be terse.\n",
    // From before 0.7.0: still on disk, no longer read.
    "USER.md": "Works with Gading.\n",
    "AGENTS.md": "Nouva handles scheduling.\n",
    "MEMORY.md": "Prefers dark mode.\n",
    "config.toml": [
      "[agent]",
      'display_name = "Nox"',
      'emoji = "🦉"',
      "",
      "[llm]",
      'provider = "nougate-openai"',
      'model = "antigravity:claude-sonnet-4-6"',
      "max_tokens = 4096",
      "",
      "[channels]",
      '"discord:main" = ["1234567890123456789"]',
      "",
      "[tools]",
      'enabled = ["read", "exec"]',
      'blocked = ["rm"]',
      "",
      "[security]",
      'sender_allowlist = ["123"]',
    ].join("\n"),
    // One skill switched off, so the loader's filter is exercised by a real pack rather than only
    // by the toggle tool's own test.
    "skills.toml": "[skills]\ngithub = false\n",
  });

  // Minimal pack: IDENTITY.md and nothing else.
  await writeAgent("minimal", { "IDENTITY.md": "# IDENTITY\n- Name: Minimal\n" });

  // Broken pack: empty IDENTITY.md.
  await writeAgent("broken", { "IDENTITY.md": "   \n", "config.toml": "[agent]\n" });

  // Pack with an invalid provider.
  await writeAgent("badprovider", {
    "IDENTITY.md": "# IDENTITY\n",
    "config.toml": '[llm]\nprovider = "gemini"\n',
  });

  // The pool: `agents/skills/`, shared by every agent, on unless a pack says otherwise.
  await writeTextFile(
    join(agentsDir, "skills", "security-audit", "SKILL.md"),
    "---\nname: security-audit\ndescription: Audit a codebase for issues\n---\n\nBody here.\n",
  );
  await writeTextFile(
    join(agentsDir, "skills", "web-search", "SKILL.md"),
    "---\nname: web-search\ndescription: Search the web\nrequires: curl\n---\n",
  );
  await writeTextFile(
    join(agentsDir, "skills", "github", "SKILL.md"),
    "---\nname: github\ndescription: Talk to GitHub\n---\n",
  );
  ensureDir(join(agentsDir, ".hidden"));
});

afterAll(() => {
  removePath(agentsDir);
});

describe("parseFrontmatter", () => {
  test("extracts fields and strips the block from the body", () => {
    const { fields, body } = parseFrontmatter(
      "---\nname: audit\ndescription: Do a thing\n---\nThe body.\n",
    );
    expect(fields).toEqual({ name: "audit", description: "Do a thing" });
    expect(body).toBe("The body.\n");
  });

  test("keeps colons inside a value", () => {
    const { fields } = parseFrontmatter("---\ndescription: use at 10:30, not before\n---\n");
    expect(fields.description).toBe("use at 10:30, not before");
  });

  test("strips surrounding quotes", () => {
    const { fields } = parseFrontmatter('---\nname: "quoted"\n---\n');
    expect(fields.name).toBe("quoted");
  });

  test("returns the whole source when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just markdown\n")).toEqual({
      fields: {},
      body: "# Just markdown\n",
    });
  });
});

describe("parseAgentConfig", () => {

  test("an agent can name its own compaction limit, and absent stays absent", () => {
    // Absent has to stay distinguishable from declared: the fallback is the operator's setting, then the
    // model's own figure, and a number written here would freeze the agent at whatever the default was.
    expect(parseAgentConfig("solo", null, { defaults: DEFAULTS }).llm.compactAtTokens).toBeUndefined();
    expect(parseAgentConfig("solo", { llm: { compact_at_tokens: 250_000 } }, { defaults: DEFAULTS }).llm.compactAtTokens).toBe(250_000);
    // Below a turn's worth is a typo, not a choice: every turn would compact down to its last message.
    expect(() => parseAgentConfig("solo", { llm: { compact_at_tokens: 5_000 } }, { defaults: DEFAULTS })).toThrow(/compact_at_tokens/);
  });

  test("an agent can name how long its model thinks; absent follows the daemon's; a level nobody knows is refused", () => {
    expect(parseAgentConfig("solo", null, { defaults: DEFAULTS }).llm.effort).toBeUndefined();
    expect(parseAgentConfig("solo", null, { defaults: { ...DEFAULTS, effort: "medium" } }).llm.effort).toBe("medium");
    expect(parseAgentConfig("solo", { llm: { effort: "low" } }, { defaults: { ...DEFAULTS, effort: "medium" } }).llm.effort).toBe("low");
    // Every request would carry it and every one would fail: refused at load, naming the levels.
    expect(() => parseAgentConfig("solo", { llm: { effort: "hgih" } }, { defaults: DEFAULTS })).toThrow(/\[llm\] effort must be one of low, medium, high, xhigh, max, got "hgih"/);
  });

  test("an agent names its fallbacks, each a provider and a model, in order — never its own model (SMART_AUTOMATION §3.1)", () => {
    const known = { defaults: DEFAULTS, knownProviders: [DEFAULTS.provider, "openrouter", "ollama-local"] };
    expect(parseAgentConfig("solo", null, known).llm.fallbacks).toBeUndefined();
    const pairs = [{ provider: "openrouter", model: " anthropic/claude-sonnet-4 " }, { provider: "ollama-local", model: "qwen3:8b" }];
    expect(parseAgentConfig("solo", { llm: { fallbacks: pairs } }, known).llm.fallbacks).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
      { provider: "ollama-local", model: "qwen3:8b" },
    ]);
    // A model's name means nothing without its provider, and a provider that is no profile fails at load.
    expect(() => parseAgentConfig("solo", { llm: { fallbacks: [{ model: "qwen3:8b" }] } }, known)).toThrow(/fallbacks\[0\] needs provider/);
    expect(() => parseAgentConfig("solo", { llm: { fallbacks: [{ provider: "openroute", model: "x" }] } }, known)).toThrow(/fallbacks\[0\] provider "openroute" is not a configured profile/);
    expect(() => parseAgentConfig("solo", { llm: { fallbacks: [{ provider: DEFAULTS.provider, model: DEFAULTS.model }] } }, known)).toThrow(/is the agent's own model/);
    expect(() => parseAgentConfig("solo", { llm: { fallbacks: [pairs[1], pairs[1]] } }, known)).toThrow(/fallbacks\[1\] repeats qwen3:8b on ollama-local/);
    expect(() => parseAgentConfig("solo", { llm: { fallbacks: [{ provider: "openrouter", model: "x", weight: 2 }] } }, known)).toThrow(/has weight/);
  });

  test("0.7's fallback_model is refused, naming the fallbacks line to write on the agent's own provider — never read", () => {
    // 0.8.0 rewrote it in every pack; one met now came back, and read as nothing the agent would lose its fallback.
    expect(() => parseAgentConfig("solo", { llm: { provider: "openrouter", model: "x/pro", fallback_model: " x/flash " } }, { defaults: DEFAULTS, knownProviders: ["openrouter"] })).toThrow(
      'agents/solo/config.toml [llm] fallback_model was replaced by fallbacks in 0.8.0: write fallbacks = [{ provider = "openrouter", model = "x/flash" }] in its place',
    );
    // The install's provider, for a pack that names none; and whatever it holds, it is not read.
    expect(() => parseAgentConfig("solo", { llm: { fallback_model: "m-0" } }, { defaults: DEFAULTS })).toThrow(`fallbacks = [{ provider = "${DEFAULTS.provider}", model = "m-0" }]`);
    for (const odd of ["  ", DEFAULTS.model, 7]) {
      expect(() => parseAgentConfig("solo", { llm: { fallback_model: odd } }, { defaults: DEFAULTS })).toThrow(/fallback_model was replaced by fallbacks in 0\.8\.0/);
    }
    // Beside fallbacks, the line is only to be taken out.
    expect(() => parseAgentConfig("solo", { llm: { fallback_model: "a", fallbacks: [] } }, { defaults: DEFAULTS })).toThrow(/or take the line out: fallbacks is there already/);
  });

  test("a pack that names no fallbacks takes the install's, less a pair that is its own model", () => {
    const defaults = { ...DEFAULTS, fallbacks: [{ provider: DEFAULTS.provider, model: DEFAULTS.model }, { provider: "openrouter", model: "x" }] };
    expect(parseAgentConfig("solo", null, { defaults }).llm.fallbacks).toEqual([{ provider: "openrouter", model: "x" }]);
    expect(parseAgentConfig("solo", { llm: { fallbacks: [] } }, { defaults }).llm.fallbacks).toBeUndefined();
  });

  test("derives displayName from the directory name", () => {
    expect(parseAgentConfig("night-owl", null, { defaults: DEFAULTS }).displayName).toBe("Night Owl");
  });

  test("treats an absent enabled flag as enabled", () => {
    // A directory someone created is one they meant to use; parking it is explicit.
    expect(parseAgentConfig("solo", {}, { defaults: DEFAULTS }).enabled).toBe(true);
    expect(parseAgentConfig("solo", { agent: { enabled: false } }, { defaults: DEFAULTS }).enabled).toBe(false);
  });

  test("a tool by its old name — memory_recent (0.5), task_plan (until 0.7.16) — is refused in every list, naming the new one", () => {
    // 0.7.x rewrote them in every pack. Read as nothing, the agent would lose the tool without a word — and in
    // `blocked`, an old name would unblock it.
    for (const list of ["enabled", "approval_required", "blocked"]) {
      expect(() => parseAgentConfig("solo", { tools: { [list]: ["read", "memory_recent"] } }, { defaults: DEFAULTS })).toThrow(
        `agents/solo/config.toml [tools] ${list} names memory_recent (renamed memory_search): write the new name`,
      );
      expect(() => parseAgentConfig("solo", { tools: { [list]: ["task_plan"] } }, { defaults: DEFAULTS })).toThrow("task_plan (renamed plan)");
    }
  });

  test("a pack's own [[mcp_servers]] is refused, naming the library — a git pull may bring one back", () => {
    expect(() => parseAgentConfig("solo", { mcp_servers: [{ name: "x", transport: "stdio", command: "x" }] }, { defaults: DEFAULTS })).toThrow(
      /agents\/solo\/config\.toml \[\[mcp_servers\]\] is gone from packs since 0\.7\.19\. The server belongs in the install's library, agents\/mcp\.toml/,
    );
  });

  test("a preset's old name in [agent] approvals is refused like any other word", () => {
    expect(() => parseAgentConfig("solo", { agent: { approvals: "risky" } }, { defaults: DEFAULTS })).toThrow(
      'agents/solo/config.toml [agent] approvals must be one of careful, balanced, trusted, per-person, got "risky"',
    );
  });

  test("defaults to read-only tools, with the daemon's own CLI the one exception", () => {
    const config = parseAgentConfig("solo", null, { defaults: DEFAULTS });

    // Everything that changes something on the machine is still absent by default.
    expect(config.tools.enabled).not.toContain("write");
    expect(config.tools.enabled).not.toContain("edit");
    expect(config.tools.enabled).not.toContain("session");

    /**
     * `exec` sat here for exactly one release and this assertion has now said three different things,
     * which is the history worth keeping.
     *
     * It was `not.toContain("exec")` — read-only by default. Moving `person_manage` to the CLI flipped
     * it, because the prompt's CLI block was gated on `exec` and a silent pack could not see the daemon's control surface at all.
     * That bought the CLI by handing every default agent a general shell, and it did not even work:
     * `resolveCwd` refuses the install directory as a `cwd`, so the block's own instruction was
     * unrunnable.
     *
     * Then the CLI became a tool of its own (`nouride`), so the shell is not the price of it any more.
     * `argv[0]` is fixed to this install's binary — the daemon, and nothing else on the machine.
     */
    expect(config.tools.enabled).toContain("nouride");
    expect(config.tools.enabled).not.toContain("exec");
    expect(config.tools.approvalRequired).toContain("nouride");
    expect(config.tools.approvalRequired).toContain("exec");
    expect(config.tools.approvalRequired).toContain("write");
  });

  test("a pack can still take the CLI away, and the sealed agent stays possible", () => {
    // The half that makes the entry above acceptable. Dropping it drops the prompt's CLI section too,
    // which is the correct pairing: an agent with no way to run the command should not be told about
    // commands.
    const config = parseAgentConfig("solo", { tools: { enabled: ["read", "glob", "grep"] } }, { defaults: DEFAULTS });
    expect(config.tools.enabled).not.toContain("nouride");
  });

  test("and `agent_enable` is gone from the gate list with the tool it named", () => {
    // A name on this list that no registry entry answers is a gate on nothing, and reads to the next
    // person as a tool that exists.
    const config = parseAgentConfig("solo", null, { defaults: DEFAULTS });
    expect(config.tools.approvalRequired).not.toContain("agent_enable");
  });

  test("an explicit empty tools list means no tools, not defaults", () => {
    const config = parseAgentConfig("solo", { tools: { enabled: [] } }, { defaults: DEFAULTS });
    expect(config.tools.enabled).toEqual([]);
  });

  test("rejects a provider that is not a configured profile", () => {
    // A profile name is only checkable against the daemon config, so the known list is passed
    // in — and a typo fails at load rather than on the agent's first message.
    expect(() =>
      parseAgentConfig(
        "solo",
        { llm: { provider: "anthropc" } },
        { defaults: DEFAULTS, knownProviders: ["anthropic", "openai"] },
      ),
    ).toThrow(/is not a configured profile \(known: anthropic, openai\)/);
  });

  test("accepts any provider name when the known list is not supplied", () => {
    expect(parseAgentConfig("solo", { llm: { provider: "whatever" } }, { defaults: DEFAULTS }).llm.provider)
      .toBe("whatever");
  });

  test("rejects a channel key that is not a gateway instance id", () => {
    expect(() =>
      parseAgentConfig("solo", { channels: { telegram: ["123"] } }, { defaults: DEFAULTS }),
    ).toThrow(/must be a gateway instance id like "telegram:nouva"/);
  });

  test("rejects a binding to a gateway that is not configured", () => {
    expect(() =>
      parseAgentConfig(
        "solo",
        { channels: { "telegram:ghost": ["123"] } },
        { defaults: DEFAULTS, knownGateways: ["telegram:nouva"] },
      ),
    ).toThrow(/is not a configured gateway/);
  });

  test("rejects a wrongly typed field with the field path", () => {
    expect(() => parseAgentConfig("solo", { llm: { max_tokens: "lots" } }, { defaults: DEFAULTS })).toThrow(
      /agents\/solo\/config\.toml \[llm\] max_tokens must be a number/,
    );
  });

  test("requires a command for a stdio MCP server", () => {
    expect(() =>
      parseMcpServers([{ name: "x", transport: "stdio" }], "agents/mcp.toml", "[[servers]]"),
    ).toThrow(/needs a command/);
  });

  test("requires a url for an sse MCP server", () => {
    expect(() =>
      parseMcpServers([{ name: "x", transport: "sse" }], "agents/mcp.toml", "[[servers]]"),
    ).toThrow(/needs a url/);
  });

  test("reads parallel_safe as a boolean or a list of names", () => {
    const server = (parallel_safe: unknown) =>
      parseMcpServers([{ name: "docs", transport: "stdio", command: "docs-mcp", parallel_safe }], "agents/mcp.toml", "[[servers]]")[0]!;

    expect(server(true).parallelSafe).toBe(true);
    expect(server(false).parallelSafe).toBe(false);
    expect(server(["search_*", "get_page"]).parallelSafe).toEqual(["search_*", "get_page"]);
    expect("parallelSafe" in server(undefined)).toBe(false);
  });

  test("refuses a parallel_safe it cannot read, at load", () => {
    // Fail at load, not at an agent's first message: a typo here would otherwise quietly mean "serial".
    for (const bad of ["yes", 1, ["ok", 2], [""]]) {
      expect(() =>
        parseMcpServers([{ name: "docs", transport: "stdio", command: "docs-mcp", parallel_safe: bad }], "agents/mcp.toml", "[[servers]]"),
      ).toThrow(/parallel_safe must be/);
    }
  });

  /**
   * Two servers whose tools would take one name are refused at load (G12), by the file and the entry.
   *
   * A server's tools are `<name>__<tool>`, and the agent's tool list was merged last-writer-wins: two servers of one
   * name, and the agent got whichever connected last — another server's `search` on another boot, with nothing said.
   */
  test("refuses a second server of one name, naming both entries", () => {
    const servers = [
      { name: "github", transport: "stdio", command: "gh-mcp" },
      { name: "docs", transport: "stdio", command: "docs-mcp" },
      { name: "github", transport: "streamable-http", url: "https://mcp.example.invalid/github" },
    ];
    expect(() => parseMcpServers(servers, "agents/mcp.toml", "[[servers]]")).toThrow('agents/mcp.toml [[servers]] #3 name "github" is #1\'s already');
  });

  test("refuses a name that holds the separator or ends in half of it — a shape that gives two servers one tool name", () => {
    // `a` with a tool `b__c` and `a__b` with a tool `c` are both `a__b__c`; so are `a` with `_c` and `a_` with `c`.
    for (const name of ["a__b", "docs_"]) {
      expect(() =>
        parseMcpServers([{ name, transport: "stdio", command: "x" }], "agents/mcp.toml", "[[servers]]"),
      ).toThrow(`agents/mcp.toml [[servers]] #1 name "${name}" may not hold "__" or end in "_"`);
    }
    // One underscore inside a name is a name.
    expect(parseMcpServers([{ name: "my_docs", transport: "stdio", command: "x" }], "agents/mcp.toml", "[[servers]]")[0]?.name).toBe("my_docs");
  });
});

describe("loadAgent", () => {
  test("a USER.md left in a pack is not read: who somebody is lives in People since 0.7.0", async () => {
    // The nox pack still has one, as a pack from before would. Nothing of it reaches the persona.
    const agent = await loadAgent("nox", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });
    expect(JSON.stringify(agent.persona)).not.toContain("Works with Gading");
    expect(Object.keys(agent.persona).sort()).toEqual(["agents", "identity", "memory", "soul"]);
  });

  test("loads persona files, config and skills", async () => {
    const agent = await loadAgent("nox", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });

    expect(agent.config.id).toBe("nox");
    expect(agent.config.displayName).toBe("Nox");
    expect(agent.config.llm.provider).toBe("nougate-openai");
    expect(agent.config.llm.model).toBe("antigravity:claude-sonnet-4-6");
    // Unset in the pack, so it comes from the daemon defaults.
    expect(agent.config.llm.temperature).toBe(0.7);
    // Keyed by instance, not platform: chat 12345 on one bot is not chat 12345 on another.
    expect(agent.config.channels["discord:main"]).toEqual(["1234567890123456789"]);
    expect(agent.config.senderAllowlist).toEqual(["123"]);
    // A server is the library's since 0.7.19 (`agents/mcp.toml`); a pack declares none.
    expect(agent.config.mcpServers).toEqual([]);

    /**
     * All five slots, because "loads persona files" is what this test is named for and it was only
     * checking two of them. The line that used to sit here asserted `persona.heartbeat` was
     * undefined — a slot removed in 12290e7, so the assertion had outlived its field and passed by
     * describing something that could not exist. It was invisible because each package's own tests
     * were excluded from every tsconfig until the typecheck was widened.
     */
    expect(agent.persona.identity).toContain("Nox");
    expect(agent.persona.soul).toBe("Be terse.\n");
    expect(agent.persona.agents).toBe("Nouva handles scheduling.\n");
    expect(agent.persona.memory).toBe("Prefers dark mode.\n");
    expect(agent.loadedAt).toBeGreaterThan(0);
  });

  test("takes the whole pool except what skills.toml switches off", async () => {
    const agent = await loadAgent("nox", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });
    const names = agent.skills.map((s) => s.name).sort();

    // Default-on is the whole design: an agent is handed everything in `agents/skills/` and only a
    // decision in its own `skills.toml` takes one away.
    expect(names).toEqual(["security-audit", "web-search"]);
    expect(agent.skills.find((s) => s.name === "github")).toBeUndefined();
    expect(agent.config.skills).toEqual({ github: false });
    expect(agent.skills.find((s) => s.name === "web-search")?.scope).toBe("shared");
  });

  test("a pack with no skills.toml gets everything", async () => {
    // The upgrade case, and the common one: nobody has decided anything, so nothing is missing.
    const agent = await loadAgent("minimal", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });
    expect(agent.skills.map((s) => s.name).sort()).toEqual(["github", "security-audit", "web-search"]);
  });

  test("reads requires: from the frontmatter", async () => {
    const agent = await loadAgent("nox", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });
    expect(agent.skills.find((s) => s.name === "web-search")?.requires).toEqual(["curl"]);
    // Absent rather than an empty array, so a skill that needs nothing carries nothing.
    expect(agent.skills.find((s) => s.name === "security-audit")?.requires).toBeUndefined();
  });

  test("keeps skill bodies on disk, exposing only the path", async () => {
    const agent = await loadAgent("nox", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });
    const skill = agent.skills.find((s) => s.name === "security-audit");
    expect(skill?.description).toBe("Audit a codebase for issues");
    expect(skill?.path).toEndWith("skills/security-audit/SKILL.md");
  });

  test("loads a pack that has only IDENTITY.md", async () => {
    const agent = await loadAgent("minimal", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });
    expect(agent.config.enabled).toBe(true);
    expect(agent.config.llm).toEqual(DEFAULTS);
    expect(agent.config.skills).toEqual({});
  });

  test("refuses a pack with an empty IDENTITY.md", async () => {
    await expect(loadAgent("broken", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] })).rejects.toThrow(
      /IDENTITY\.md is missing or empty/,
    );
  });

  test("refuses a directory that does not exist", async () => {
    await expect(loadAgent("ghost", { agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] })).rejects.toThrow(
      /agent directory not found/,
    );
  });
});

describe("discoverAgents", () => {
  test("loads the good packs and reports the bad ones without throwing", async () => {
    const { agents, failures } = await discoverAgents({ agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });

    // One broken pack must not take down the other agents or the dashboard you would
    // use to fix it.
    expect(agents.map((a) => a.config.id).sort()).toEqual(["minimal", "nox"]);
    expect(failures.map((f) => f.id).sort()).toEqual(["badprovider", "broken"]);
    expect(failures.find((f) => f.id === "badprovider")?.error).toMatch(/not a configured profile/);
  });

  test("skips the shared/ directory and dotfiles", async () => {
    const { agents, failures } = await discoverAgents({ agentsDir, llmDefaults: DEFAULTS, knownProviders: ["anthropic", "nougate-openai"], knownGateways: ["discord:main"] });
    const ids = [...agents.map((a) => a.config.id), ...failures.map((f) => f.id)];
    expect(ids).not.toContain("shared");
    expect(ids).not.toContain(".hidden");
  });
});

describe("workspace roots", () => {
  /**
   * Observed with a real config: `roots = ["~/nouride-test/project"]` left the tilde literal, so the
   * sandbox compared against a directory named `~`. The agent reported a file it had been pointed at as
   * missing while `ls` in that directory showed it sitting there. The sandbox was right; the root it was
   * given was nonsense.
   */
  test("expands a leading tilde", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-roots-"));
    await writeAgent(
      "tilde",
      { "IDENTITY.md": "# IDENTITY\\n- Name: X\\n", "config.toml": '[workspace]\nroots = ["~/some-project"]\n' },
      dir,
    );

    const pack = await loadAgent("tilde", { agentsDir: dir, llmDefaults: DEFAULTS });
    expect(pack.config.workspaceRoots[0]?.startsWith("~")).toBe(false);
    expect(pack.config.workspaceRoots[0]?.endsWith("/some-project")).toBe(true);
  });

  test("resolves a relative root against the pack's own directory", async () => {
    // Relative to the file the operator is looking at while writing it, not to wherever the daemon
    // happened to be started from.
    const dir = mkdtempSync(join(tmpdir(), "nouride-roots-"));
    await writeAgent(
      "rel",
      { "IDENTITY.md": "# IDENTITY\\n- Name: X\\n", "config.toml": '[workspace]\nroots = ["../shared-code"]\n' },
      dir,
    );

    const pack = await loadAgent("rel", { agentsDir: dir, llmDefaults: DEFAULTS });
    expect(pack.config.workspaceRoots[0]).toBe(join(dir, "shared-code"));
  });

  test("leaves an absolute root alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-roots-"));
    await writeAgent(
      "abs",
      { "IDENTITY.md": "# IDENTITY\\n- Name: X\\n", "config.toml": '[workspace]\nroots = ["/srv/project"]\n' },
      dir,
    );

    const pack = await loadAgent("abs", { agentsDir: dir, llmDefaults: DEFAULTS });
    expect(pack.config.workspaceRoots[0]).toBe("/srv/project");
  });
});

describe("[agent] access", () => {
  test("absent stays absent; follow, pair and allowlist are read as written", () => {
    expect(parseAgentConfig("solo", {}, { defaults: DEFAULTS }).access).toBeUndefined();
    for (const access of ["follow", "pair", "allowlist"] as const) expect(parseAgentConfig("solo", { agent: { access } }, { defaults: DEFAULTS }).access).toBe(access);
  });

  test("anything else — open included, which the daemon refuses for an agent with exec — fails at load", () => {
    for (const access of ["open", "paired", 1]) {
      expect(() => parseAgentConfig("solo", { agent: { access } }, { defaults: DEFAULTS })).toThrow(/\[agent\] access must be one of follow, pair, allowlist/);
    }
  });
});

describe("[jobs] quiet_after_minutes", () => {
  test("an agent's own wait is read, and absent stays absent so the daemon's applies", () => {
    expect(parseAgentConfig("solo", { jobs: { quiet_after_minutes: 15 } }, { defaults: DEFAULTS }).jobQuietAfterMinutes).toBe(15);
    expect(parseAgentConfig("solo", { jobs: { quiet_after_minutes: 0 } }, { defaults: DEFAULTS }).jobQuietAfterMinutes).toBe(0);
    expect("jobQuietAfterMinutes" in parseAgentConfig("solo", {}, { defaults: DEFAULTS })).toBe(false);
  });

  test("a negative wait is refused at load, not treated as a notice every minute", () => {
    expect(() => parseAgentConfig("solo", { jobs: { quiet_after_minutes: -1 } }, { defaults: DEFAULTS })).toThrow("quiet_after_minutes");
  });
});

describe("[security] exec_secrets (S6)", () => {
  const parse = (exec_secrets: unknown) => parseAgentConfig("nox", { security: { exec_secrets } }, { defaults: DEFAULTS }).execSecrets;

  test("a table binds each secret to the commands that need it, written as the command line starts", () => {
    expect(parse({ pypi_token: ["twine upload", "  python3   scripts/publish_pypi.py "], status_token: ["*"] })).toEqual([
      { name: "pypi_token", commands: ["twine upload", "python3 scripts/publish_pypi.py"] },
      { name: "status_token", commands: ["*"] },
    ]);
  });

  test("the old list (until 0.7.4, every command) is refused, naming the table — 0.7.22 rewrote it in every pack", () => {
    expect(() => parse(["pypi_token"])).toThrow(/is a list, the form before 0\.7\.4\. Write it as a table: \[security\.exec_secrets\]/);
    expect(parse(undefined)).toEqual([]);
  });

  test("a credential pasted where a secret's name goes is refused at load — and the message holds no part of it", () => {
    const pasted = ["ghp_0123456789abcdefghijABCDEFGHIJ012345", "sk-ant-api03-abcdefghijklmnopqrstuv"];
    for (const value of pasted) {
      let message = "";
      try {
        parse({ [value]: ["twine upload"] });
      } catch (err) {
        message = String(err);
      }
      expect(message).toContain("looks like a credential, not a name");
      expect(message).not.toContain(value.slice(0, 6));
      // The old list form is refused before any name in it is read: its message holds none either.
      expect(() => parse([value])).toThrow(/is a list, the form before 0\.7\.4/);
      try {
        parse([value]);
      } catch (err) {
        expect(String(err)).not.toContain(value.slice(0, 6));
      }
    }
    const mcp = (auth_secret: string) => parseMcpServers([{ name: "gh", transport: "streamable-http", url: "https://x.invalid/mcp", auth_secret }], "agents/mcp.toml", "[[servers]]");
    expect(() => mcp(pasted[0]!)).toThrow("auth_secret looks like a credential, not a name");
    expect(mcp("github_token")[0]?.authSecret).toBe("github_token");
  });

  test("a binding that names nothing, or `*` beside commands, is refused at load", () => {
    expect(() => parse({ pypi_token: [] })).toThrow("exec_secrets.pypi_token must name at least one command");
    expect(() => parse({ pypi_token: [" "] })).toThrow("must name at least one command");
    expect(() => parse({ pypi_token: ["*", "twine upload"] })).toThrow('"*" is every command already');
    expect(() => parse({ pypi_token: "twine upload" })).toThrow("exec_secrets.pypi_token must be an array of strings");
    expect(() => parse("pypi_token")).toThrow("must be a table");
  });
});

/** The ssh-agent socket is the pack's to ask for (S11): every command of every agent held it until 0.7.9. */
describe("[security] ssh_agent", () => {
  const parse = (security: Record<string, unknown>) => parseAgentConfig("ops", { security }, { defaults: DEFAULTS });

  test("on when the pack says so; off when it says false — and absent stays absent, a pack that has not decided", () => {
    expect(parse({ ssh_agent: true }).sshAgent).toBe(true);
    expect(parse({ ssh_agent: false }).sshAgent).toBe(false);
    expect("sshAgent" in parse({})).toBe(false);
  });

  test("anything but true or false is refused at load, by its file and field", () => {
    expect(() => parse({ ssh_agent: "yes" })).toThrow("agents/ops/config.toml [security] ssh_agent must be true or false");
  });
});

/** Whether the agent's own user reads the credentials directory (0.8.0): the pack may turn it off. */
describe("[security] credentials", () => {
  const parse = (security: Record<string, unknown>) => parseAgentConfig("ops", { security }, { defaults: DEFAULTS });

  test("off only when the pack says false; absent stays absent, and means on", () => {
    expect(parse({ credentials: false }).credentials).toBe(false);
    expect(parse({ credentials: true }).credentials).toBe(true);
    expect("credentials" in parse({})).toBe(false);
  });

  test("anything but true or false is refused at load, by its file and field", () => {
    expect(() => parse({ credentials: "no" })).toThrow("agents/ops/config.toml [security] credentials must be true or false");
  });
});

/** Whether the orchestrator installs the programs every agent runs (0.8.0): on unless its pack says false. */
describe("[security] shared_tools", () => {
  const parse = (security: Record<string, unknown>) => parseAgentConfig("ops", { security }, { defaults: DEFAULTS });

  test("off only when the pack says false; absent stays absent, and means on", () => {
    expect(parse({ shared_tools: false }).sharedTools).toBe(false);
    expect("sharedTools" in parse({})).toBe(false);
    expect(() => parse({ shared_tools: "no" })).toThrow("agents/ops/config.toml [security] shared_tools must be true or false");
  });
});

/** This agent's second look (0.8.0): off, a tier or a model id; absent follows the daemon's; a switch's word is refused. */
describe("[security] model_guard", () => {
  const parse = (security: Record<string, unknown>) => parseAgentConfig("ops", { security }, { defaults: DEFAULTS });

  test("kept as written; absent or empty stays absent; a value none of the three refuses the pack, naming it", () => {
    expect(parse({ model_guard: "off" }).modelGuard).toBe("off");
    expect(parse({ model_guard: " high " }).modelGuard).toBe("high");
    expect("modelGuard" in parse({})).toBe(false);
    expect("modelGuard" in parse({ model_guard: "" })).toBe(false);
    expect(() => parse({ model_guard: "yes" })).toThrow('agents/ops/config.toml [security] model_guard = "yes" is none of off, a tier');
    expect(() => parse({ model_guard: true })).toThrow("agents/ops/config.toml [security] model_guard takes a string");
  });
});

/** `[security] secret_guard` went into the approval levels in 0.8.0: the guard asks at every level but `trusted`. */
describe("[security] secret_guard", () => {
  test("is no longer read: a pack that still says it loads, nothing on the agent says it, and the key is named", () => {
    const parsed = parseAgentConfig("ops", { security: { secret_guard: false } } as never, { defaults: DEFAULTS });
    expect("secretGuard" in parsed).toBe(false);
    expect(unknownPackKeys({ security: { secret_guard: false } })).toEqual(["[security] secret_guard"]);
  });
});
