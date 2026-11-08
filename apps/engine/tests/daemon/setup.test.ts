/**
 * First-run setup.
 *
 * Two properties carry more weight than the rest. The API key must reach the secret store and never the
 * config file — this is the single most likely place in the codebase for a live credential to be
 * committed to git. And a provider that does not answer must be refused *before* it is saved, because
 * the alternative is a wizard that reports success and an agent that fails on its first message.
 */

import type { AutoApprovePort } from "@/modules/tools/auto-approve.store.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import { parseToml, readTextFile, readTextFileIfExists, writeTextFileAtomic } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { assertGatewayExecPosture } from "@/modules/config/global/index.ts";
import { SetupService, SETUP_PROFILE } from "@/modules/setup/service.ts";

/** The secret a profile the wizard makes names: the Models page's rule, one writer for both. */
const SETUP_SECRET = `${SETUP_PROFILE}_api_key`;
import { probeProvider } from "@/modules/setup/probe.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { everyBuiltinToolName } from "../helpers.ts";

const LIVE_KEY = "sk-live-do-not-commit-me";

let root: string;
let dataDir: string;
let agentsDir: string;
/**
 * At the install root, NOT inside `dataDir`.
 *
 * The service used to derive this as `<dataDir>/config.toml`, and a test that put the two in the same
 * place could not tell the difference — which is how the wizard came to write a file the loader no
 * longer reads once the paths under `.nouride/` became independently configurable.
 */
let configPath: string;

/** A fetch that answers a model listing, so nothing here touches the network. */
function fakeFetch(status = 200, body: unknown = { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function service(fetchImpl: typeof fetch = fakeFetch(), autoApprove?: Pick<AutoApprovePort, "enable">) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dataDir;
  config.daemon.agentsDir = agentsDir;
  config.daemon.orchestrator = "";
  config.providers = {};

  const secrets = await SecretStore.open(dataDir, {});
  const providers = new ProviderRegistry(config.providers, secrets);
  const registry = await AgentRegistry.create({
    agentsDir,
    llmDefaults: config.llm.defaults,
    // A function, exactly as `index.ts` wires it. A fixed array here would pass while the daemon
    // failed — the profile list changes under a running registry, which is the whole reason this
    // option takes a callback.
    knownProviders: () => providers.names(),
  });

  return {
    config,
    secrets,
    providers,
    registry,
    setup: new SetupService({
      config,
      configPath,
      dataDir,
      agentsDir,
      secrets,
      providers,
      registry,
      userCount: () => 1,
      fetchImpl,
      // Only `enable` is what setup calls.
      ...(autoApprove ? { autoApprove: autoApprove as AutoApprovePort } : {}),
    }),
  };
}

beforeEach(() => {
  root = join(tmpdir(), `nouride-setup-${Math.floor(performance.now() * 1000)}`);
  dataDir = join(root, "data");
  agentsDir = join(root, "agents");
  configPath = join(root, "config.toml");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("probeProvider", () => {
  test("reports the models an endpoint lists", async () => {
    const result = await probeProvider({
      kind: "openai",
      baseUrl: "https://x.example/v1",
      apiKey: "k",
      fetchImpl: fakeFetch(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  test("a rejected key says so, rather than reporting a network problem", async () => {
    const result = await probeProvider({
      kind: "openai",
      baseUrl: "https://x.example/v1",
      apiKey: "bad",
      fetchImpl: fakeFetch(401, {}),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("API key");
  });

  test("a 404 points at the base URL, which is what is actually wrong", async () => {
    const result = await probeProvider({
      kind: "openai",
      baseUrl: "https://x.example",
      apiKey: "k",
      fetchImpl: fakeFetch(404, {}),
    });
    expect(result.error).toContain("/v1");
  });

  test("a malformed URL is caught before anything is dialled", async () => {
    let called = false;
    const result = await probeProvider({
      kind: "openai",
      baseUrl: "not a url",
      apiKey: "k",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("a working key with an unrecognisable listing is still a working key", async () => {
    // A proxy may answer something close to but not exactly the OpenAI shape. The credential is what
    // was being tested, and an unfamiliar body is not something the operator can act on.
    const result = await probeProvider({
      kind: "openai",
      baseUrl: "https://x.example/v1",
      apiKey: "k",
      fetchImpl: fakeFetch(200, { models: ["a"] }),
    });
    expect(result).toMatchObject({ ok: true, models: [] });
  });

  test("anthropic is asked with the header its API requires", async () => {
    let headers: Headers | undefined;
    await probeProvider({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        headers = new Headers(init.headers);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(headers?.get("x-api-key")).toBe("k");
    expect(headers?.get("anthropic-version")).toBeTruthy();
  });
});

describe("saveProvider", () => {
  test("writes the secret NAME to config.toml and the value to the secret store", async () => {
    const { setup, secrets } = await service();

    const result = await setup.saveProvider({
      kind: "openai",
      baseUrl: "https://nougate.example/v1",
      apiKey: LIVE_KEY,
      actor: "test",
    });
    expect(result).toMatchObject({ ok: true });

    const written = await readTextFile(configPath);
    // The property this whole indirection exists for.
    expect(written).not.toContain(LIVE_KEY);
    expect(written).toContain(SETUP_SECRET);

    const parsed = parseToml<any>(written);
    expect(parsed.providers[SETUP_PROFILE]).toMatchObject({
      kind: "openai",
      base_url: "https://nougate.example/v1",
      api_key: SETUP_SECRET,
    });
    expect(secrets.resolve(SETUP_SECRET)).toBe(LIVE_KEY);

    // And the store is the only place it lives, encrypted (0.8.19): no file holds it as text.
    expect(await readTextFileIfExists(join(dataDir, "secrets.json"))).toBeNull();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dataDir, "secrets.enc")).toString("latin1")).not.toContain(LIVE_KEY);
  });

  test("a new install starts careful: the first write sets the level, a later one leaves it as it is", async () => {
    // An install whose file exists keeps what it says — one that never set a level is `balanced`.
    const { setup, config } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x.example/v1", apiKey: LIVE_KEY, actor: "t" });
    const security = async () => parseToml<{ security?: unknown }>(await readTextFile(configPath)).security;
    expect(await security()).toEqual({ approvals: "careful" });
    expect(config.security.approvals).toBe("careful");

    await writeTextFileAtomic(configPath, (await readTextFile(configPath)).replace('approvals = "careful"', 'approvals = "balanced"'));
    await setup.saveProvider({ kind: "anthropic", name: "second", baseUrl: "https://y.example", apiKey: LIVE_KEY, actor: "t" });
    expect(await security()).toEqual({ approvals: "balanced" });
  });

  test("applies the profile live, so no restart is needed", async () => {
    const { setup, providers, config } = await service();
    expect(providers.available()).toHaveLength(0);

    await setup.saveProvider({
      kind: "openai",
      baseUrl: "https://x.example/v1",
      apiKey: LIVE_KEY,
      actor: "test",
    });

    expect(providers.available()).toMatchObject([{ name: SETUP_PROFILE, hasCredential: true }]);
    expect(config.providers[SETUP_PROFILE]?.baseUrl).toBe("https://x.example/v1");
  });

  test("a rejected endpoint is not saved at all", async () => {
    // Half-saving — key stored, config not written, or the reverse — is worse than refusing, because
    // the next screen then reports a state that does not exist.
    const { setup, secrets } = await service(fakeFetch(401, {}));

    const result = await setup.saveProvider({
      kind: "openai",
      baseUrl: "https://x.example/v1",
      apiKey: LIVE_KEY,
      actor: "test",
    });

    expect(result.ok).toBe(false);
    expect(secrets.resolve(SETUP_SECRET)).toBeUndefined();
    expect(await readTextFileIfExists(configPath)).toBeNull();
  });

  test("an empty key or URL is refused before anything is dialled", async () => {
    const { setup } = await service();
    expect(await setup.saveProvider({ kind: "openai", baseUrl: "", apiKey: "k", actor: "t" })).toMatchObject({ ok: false });
    expect(
      await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: "  ", actor: "t" }),
    ).toMatchObject({ ok: false });
  });

  test("saving twice updates in place rather than stacking profiles", async () => {
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://a/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.saveProvider({ kind: "anthropic", baseUrl: "https://b", apiKey: LIVE_KEY, actor: "t" });

    const parsed = parseToml<any>(await readTextFile(configPath));
    expect(Object.keys(parsed.providers)).toEqual([SETUP_PROFILE]);
    expect(parsed.providers[SETUP_PROFILE].kind).toBe("anthropic");
  });

  test("a custom name creates a profile under that name, not 'default'", async () => {
    const { setup, providers } = await service();
    const result = await setup.saveProvider({
      kind: "openai",
      name: "nougate",
      baseUrl: "https://gate.example.com/v1",
      apiKey: LIVE_KEY,
      actor: "t",
    });
    expect(result).toMatchObject({ ok: true });

    const parsed = parseToml<any>(await readTextFile(configPath));
    expect(parsed.providers.nougate).toBeDefined();
    expect(parsed.providers.nougate.kind).toBe("openai");
    // Named the way the Models page names one: a single writer, so one rule for the secret a profile names.
    expect(parsed.providers.nougate.api_key).toBe("nougate_api_key");
    // The default profile should not exist
    expect(parsed.providers[SETUP_PROFILE]).toBeUndefined();

    expect(providers.available().some((p) => p.name === "nougate")).toBe(true);
  });
});

describe("listModels", () => {
  test("a provider that stops answering is an error, not an empty picker", async () => {
    // Saved while it answered, refused since: the agent step must say why, not offer no models.
    let status = 200;
    const flaky = (async (...args: Parameters<typeof fetch>) =>
      fakeFetch(status, status === 200 ? undefined : {})(...args)) as unknown as typeof fetch;
    const { setup } = await service(flaky);
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });

    status = 401;
    const result = await setup.listModels();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("API key");
  });

  test("fails when no provider is configured", async () => {
    const { setup } = await service();
    const result = await setup.listModels();
    expect(result).toMatchObject({ ok: false });
  });

  test("returns models from a custom-named profile", async () => {
    const { setup } = await service();
    await setup.saveProvider({
      kind: "openai",
      name: "mygateway",
      baseUrl: "https://gate.example.com/v1",
      apiKey: LIVE_KEY,
      actor: "t",
    });

    const result = await setup.listModels();
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    }
  });
});

describe("createAgent", () => {
  const agentInput = {
    id: "nouva",
    displayName: "Nouva",
    systemPrompt: "You are precise and brief.",
    model: "gpt-4o",
    actor: "test",
  };

  /**
   * A pack that ships with only `IDENTITY.md` and `SOUL.md` looks like a runtime that supports only
   * those two. The loader reads five, but a slot with no file is indistinguishable from a slot that
   * does not exist — an operator ran an agent for weeks without knowing `AGENTS.md` was read at all,
   * and asked for it to be "added to the code" when it had always been there.
   */
  test("stops asking whoever writes from the dashboard's connection without naming themselves: the terminal", async () => {
    const enabled: string[] = [];
    const { setup } = await service(fakeFetch(), { enable: (gatewayId, senderId) => (enabled.push(`${gatewayId} ${senderId}`), true) });
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    expect(await setup.createAgent(agentInput)).toMatchObject({ ok: true, id: "nouva" });
    expect(enabled).toEqual(["web:dashboard terminal", "web terminal"]);
  });

  test("writes its headline into IDENTITY.md — the preset's when none is given — and refuses one too long before writing anything", async () => {
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    expect(await setup.createAgent({ ...agentInput, headline: "Infra:  servers,\n deploys" })).toMatchObject({ ok: true });
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "IDENTITY.md"))).toContain("- **Headline:** Infra: servers, deploys\n");
    expect(await setup.createAgent({ ...agentInput, id: "lyra", preset: "researcher" })).toMatchObject({ ok: true });
    expect(await readTextFileIfExists(join(agentsDir, "lyra", "IDENTITY.md"))).toContain("- **Headline:** Research: searches the web");
    expect(await setup.createAgent({ ...agentInput, id: "long", headline: "x".repeat(151) })).toMatchObject({ ok: false, error: expect.stringContaining("150") });
    expect(await readTextFileIfExists(join(agentsDir, "long", "IDENTITY.md"))).toBeNull();
  });

  test("writes AGENTS.md and MEMORY.md, not just identity and soul", async () => {
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    expect(await setup.createAgent(agentInput)).toMatchObject({ ok: true, id: "nouva" });

    const dir = join(agentsDir, "nouva");
    for (const file of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "MEMORY.md", "config.toml"]) {
      expect(await readTextFileIfExists(join(dir, file))).toBeTruthy();
    }
  });

  test.each(["skills", "shared"])("refuses to create an agent called %s", async (id) => {
    // Both are directories under `agents/` that are not packs — `skills` is the pool every agent draws
    // from — and `discoverAgents` skips them. Without this guard the wizard writes a pack that can
    // never load, and reports success.
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });

    const result = await setup.createAgent({ ...agentInput, id });
    expect(result).toMatchObject({ ok: false });
    expect(await readTextFileIfExists(join(agentsDir, id, "IDENTITY.md"))).toBeNull();
  });

  test("the scaffolded pack does not configure skills, and says where they are", async () => {
    // A fresh pack must not carry a `[skills]` table: skills are opt-**out** now, one pool for every
    // agent, and a generated allow list would be a dead setting a new operator would try to edit.
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    const config = await readTextFile(join(agentsDir, "nouva", "config.toml"));
    expect(config).not.toContain("[skills]");
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "skills.toml"))).toBeNull();

    // The README is the one place a new operator reads about them, so it has to name the right path.
    const readme = await readTextFile(join(agentsDir, "nouva", "README.md"));
    expect(readme).toContain("agents/skills/");
    expect(readme).not.toContain("agents/shared/skills");
  });

  test("the scaffolded AGENTS.md carries the rule it exists for", async () => {
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    // An empty file would satisfy "the slot exists" and teach the agent nothing. This section is never
    // trimmed from the prompt, so it is paid for on every turn either way.
    // Whitespace folded: the file is hard-wrapped prose, and where a line breaks is not the rule.
    const agents = (await readTextFile(join(agentsDir, "nouva", "AGENTS.md"))).toLowerCase().replace(/\s+/g, " ");
    expect(agents).toContain("chain");
    expect(agents).toContain("do not ask twice");
    expect(agents).toContain("never write credentials");
  });

  test("MEMORY.md says what belongs in it, and warns about the repository", async () => {
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    const memory = (await readTextFile(join(agentsDir, "nouva", "MEMORY.md"))).toLowerCase();
    expect(memory).toContain("durable facts only");
    // The pack is git-tracked; a credential written here is a credential committed.
    expect(memory).toContain("no credentials");
  });

  test("leaves a groups_require_mention the file already says alone", async () => {
    writeFileSync(configPath, "[agents]\ngroups_require_mention = false\n");
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    expect(await setup.createAgent(agentInput)).toMatchObject({ ok: true });
    const written = parseToml<{ daemon: { orchestrator?: string }; agents: { groups_require_mention?: boolean } }>(await readTextFile(configPath));
    expect(written.agents.groups_require_mention).toBe(false);
    expect(written.daemon.orchestrator).toBe("nouva");
  });

  test("writes a pack that loads, and makes it the orchestrator", async () => {
    const { setup, registry, config } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });

    expect(await setup.createAgent(agentInput)).toMatchObject({ ok: true, id: "nouva" });

    const agent = registry.get("nouva");
    expect(agent?.config.displayName).toBe("Nouva");
    expect(agent?.config.llm.model).toBe("gpt-4o");
    // A first agent nobody has to mention: without an orchestrator, a message with no @ reaches nobody.
    expect(config.daemon.orchestrator).toBe("nouva");
    type Written = { daemon: { orchestrator?: string }; agents: { groups_require_mention?: boolean } };
    const written = parseToml<Written>(await readTextFile(configPath));
    expect(written.daemon.orchestrator).toBe("nouva");
    // A new install asks for a mention in groups, said in the file (0.7.18): a line that is absent still reads as off.
    expect(written.agents.groups_require_mention).toBe(true);
    // The second agent is made with the first already the orchestrator: nothing about either is written again.
    expect(await setup.createAgent({ ...agentInput, id: "lyra" })).toMatchObject({ ok: true });
    expect(parseToml<Written>(await readTextFile(configPath)).daemon.orchestrator).toBe("nouva");

    expect(await readTextFile(join(agentsDir, "nouva", "SOUL.md"))).toContain("precise and brief");
    // No USER.md since 0.7.0: who somebody is lives in People, said only when they are speaking.
    expect(await readTextFileIfExists(join(agentsDir, "nouva", "USER.md"))).toBeNull();
  });

  test("refuses an id the loader or the router would fight over", async () => {
    const { setup } = await service();
    for (const id of ["", "A", "1abc", "shared", "default", "has space", "x"]) {
      expect(await setup.createAgent({ ...agentInput, id })).toMatchObject({ ok: false });
    }
  });

  test("refuses to overwrite a pack that exists but failed to load", async () => {
    // Overwriting would destroy whatever is there — including a MEMORY.md that exists nowhere else —
    // while looking to the operator like a clean create.
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    mkdirSync(join(agentsDir, "nouva"), { recursive: true });
    await writeTextFileAtomic(join(agentsDir, "nouva", "IDENTITY.md"), "# broken");

    const result = await setup.createAgent(agentInput);
    expect(result).toMatchObject({ ok: false });
    expect(await readTextFile(join(agentsDir, "nouva", "IDENTITY.md"))).toBe("# broken");
  });

  test("and a directory with anything else in it: a MEMORY.md with no IDENTITY.md is somebody's too", async () => {
    // Only a directory this call made is one it may remove again when the pack does not load. A provider is set up
    // first, so the refusal is the guard's and not the missing credential's.
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    mkdirSync(join(agentsDir, "nouva"), { recursive: true });
    await writeTextFileAtomic(join(agentsDir, "nouva", "MEMORY.md"), "the only copy");

    expect(await setup.createAgent(agentInput)).toMatchObject({ ok: false });
    expect(await readTextFile(join(agentsDir, "nouva", "MEMORY.md"))).toBe("the only copy");
  });

  test("the agent it creates can actually write, and asks before it does", async () => {
    // Reported on the operator's first run: he asked the new agent to make a project and it answered
    // that it had no file-writing tools. The pack said nothing about tools, so the loader's read-only
    // default applied — correct for a pack that is silent, wrong for one a wizard just created.
    const { setup, registry } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    const tools = registry.get("nouva")?.config.tools;
    expect(tools?.enabled).toContain("write");
    expect(tools?.enabled).toContain("edit");
    // Still gated. Widening what it can do is only safe because each change is a decision a human makes.
    expect(tools?.approvalRequired).toContain("write");
    expect(tools?.approvalRequired).toContain("edit");
  });

  test("the boot guard that withholding exec was meant to avoid is satisfied by the default", () => {
    /**
     * The argument for the flag, tested instead of repeated.
     *
     * `exec` sat behind `--allow-exec` because running commands reaches the host rather than a file.
     * True, and not something a toolset list holds back: `exec` is on `DEFAULT_APPROVAL_REQUIRED`
     * either way, and the default `[security.exec]` is `mode = "full"` with `ask = "on-miss"`.
     *
     * The one thing that *does* refuse is this: a chat gateway beside an agent with `exec` and no way
     * to stop strangers. The default `[security.access] mode = "pair"` is such a way, so a fresh
     * install boots — and the flag was buying nothing while costing the agent nine tools.
     */
    const exec = { mode: "full", ask: "on-miss", askFallback: "deny", sensitivePaths: "ask", allowlist: [], blocked: [] } as never;
    const posture = { gatewaysEnabled: true, agentsWithExec: ["nouva"], senderAllowlist: [], exec };

    expect(() => assertGatewayExecPosture({ ...posture, accessMode: "pair" })).not.toThrow();
    // And it still refuses the shape it exists for: pairing turned off and nobody named.
    expect(() => assertGatewayExecPosture({ ...posture, accessMode: "open" })).toThrow(/exec tool/);
  });

  /**
   * A switch that decides nothing is worse than no switch.
   *
   * `--allow-exec` was removed from the CLI wizard on a good argument, recorded in the test above:
   * `exec` is approval-gated either way, the boot guard is satisfied by `mode = "pair"`, and the
   * flag cost the first agent nine tools for nothing. What did not happen is the other half — both
   * dashboards kept sending `allow_exec`, the route stopped reading it, and the signature kept the
   * doc comment with no field under it. So "Allow Terminal Command Execution", sitting off by
   * default under the words "For security, chat gateways require a sender allowlist when enabled",
   * produced an agent with a shell.
   *
   * The wizard's argument does not carry to this screen. It was about a *first* agent, where a
   * crippled one is a bad first impression; this is the second and later ones, which is exactly when
   * somebody wants an agent that reads and writes and cannot reach the host. And "gated anyway"
   * holds only while the gate is on — an install running `ask = "off"` has no such thing.
   */
  test("an agent created with the switch off has no shell, and still has everything else", async () => {
    const { setup, registry } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent({ ...agentInput, allowExec: false });

    const tools = registry.get("nouva")?.config.tools.enabled ?? [];
    expect(tools).not.toContain("exec");
    // `session` is `exec` for a program that asks something back. Withholding one and not the other
    // hands the same capability over through the door with the longer doc comment.
    expect(tools).not.toContain("session");
    // The rest is untouched — the removed CLI flag cost nine tools, and that was the fair complaint.
    for (const kept of ["read", "write", "edit", "web_search", "memory_write", "person_record"]) {
      expect({ kept, present: tools.includes(kept) }).toEqual({ kept, present: true });
    }
    // And the daemon's own control surface stays: withholding a shell is not withholding that.
    expect(tools).toContain("nouride");
  });

  test("and absent still means yes, because the CLI wizard never says", async () => {
    // The compatibility half. `nouride setup` does not pass the field, and a default of "no" would
    // quietly take the shell away from every first agent created at a terminal.
    const { setup, registry } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    expect(registry.get("nouva")?.config.tools.enabled).toContain("exec");
  });

  test("the pack gets an orientation file the prompt never pays for", async () => {
    // The guidance an operator needs is exactly the guidance the model does not: which file is for
    // what, and what each one costs. In `AGENTS.md` it would be carried on every turn forever, which
    // is the first mistake it warns about. The loader reads five filenames; a sixth is free.
    const { setup, registry } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    const readme = await readTextFileIfExists(join(agentsDir, "nouva", "README.md"));
    expect(readme).toContain("ignored by the daemon");
    expect(readme).toContain("nouride agent reload");

    // And it stays out of the prompt, which is the only reason it can afford to be this long.
    const persona = registry.get("nouva")?.persona ?? {};
    for (const section of Object.values(persona)) {
      expect(String(section)).not.toContain("ignored by the daemon");
    }
  });

  /**
   * Every builtin the daemon can construct, with each optional dependency supplied.
   *
   * The wizard's list is compared against the shared helper rather than a copy of itself. The memory
   * tools and `nouride` are the ones the daemon builds conditionally — on memory being wired and on
   * the binary being installed — and they are in `DEFAULT_TOOLS` too, so naming them in a pack is the
   * established shape and the boot warning is the accepted cost of it.
   */
  test("a wizard agent gets every tool the daemon can offer", async () => {
    /**
     * This assertion has moved three times and the path is the argument.
     *
     * It named `cron_manage` — a free tool call for a reminder. Moving cron to the CLI deleted that tool, and the CLI
     * that replaced it needed a shell the wizard withheld on purpose, so the agent could take no
     * reminder at all. Then the CLI became a tool of its own and was put here. Then the list was read
     * properly and it was withholding **nine**: `exec` and `session` behind a flag, and `web_search`,
     * `send_file`, `memory_recent`, `skill_create`, `skill_toggle`, `agent_create`,
     * `agent_configure` behind nothing but never having been added.
     *
     * Compared against the registry rather than a copy, because a hand-kept list is exactly how nine
     * went missing without anyone noticing.
     */
    const { setup, registry } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    const enabled = registry.get("nouva")?.config.tools.enabled ?? [];
    // The shared helper, not a second copy. The copy that used to live in this file omitted
    // `reflection`, so `skill_improve` was missing from both sides of this assertion and it passed
    // while the wizard was withholding it.
    const offered = everyBuiltinToolName().filter((name: string) => name !== "ask_agent");
    expect(enabled).toEqual(expect.arrayContaining(offered));
    // Written as `"*"`, so a tool a later release adds reaches it too — a list spelled out here froze the
    // agent at its setup's release, and a box set up before `skill_search` existed never had it.
    expect(registry.get("nouva")?.config.tools.everyTool).toBe(true);
    expect(await readTextFile(join(agentsDir, "nouva", "config.toml"))).toContain('enabled = ["*"]');
  });

  test("and the shell it now includes is still gated, not granted", async () => {
    // The reason withholding `exec` bought nothing: it is on the approval list either way, and the
    // boot guard that refuses a chat gateway beside it is satisfied by the default `access` mode.
    const { setup, registry } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    await setup.createAgent(agentInput);

    const cfg = registry.get("nouva")?.config;
    expect(cfg?.tools.enabled).toContain("exec");
    expect(cfg?.tools.approvalRequired).toContain("exec");
  });

  test("a model is required", async () => {
    const { setup } = await service();
    expect(await setup.createAgent({ ...agentInput, model: "  " })).toMatchObject({ ok: false });
  });

  test("names the provider that already exists when the wizard skipped that step", async () => {
    // Reported from the operator's own install, on the first agent he created. His `config.toml`
    // already had `nougate-anthropic` with a working key, so `hasProvider` was true and the provider
    // step never ran — and the wizard wrote `provider = "default"` for a profile nothing had created.
    // The pack failed to load, and the error named his configuration for a choice this code made.
    const { setup, config, registry, secrets } = await service();
    await secrets.set("nougate", "a-real-key");
    // The registry reads the running config's own profiles.
    config.providers["nougate-anthropic"] = {
      kind: "anthropic",
      baseUrl: "https://nougate.example/anthropic/v1",
      apiKeySecret: "nougate",
    };

    const result = await setup.createAgent(agentInput);

    expect(result).toMatchObject({ ok: true, provider: "nougate-anthropic" });
    expect(registry.get("nouva")?.config.llm.provider).toBe("nougate-anthropic");
  });

  test("prefers the wizard's own profile when both exist", async () => {
    const { setup, config, secrets } = await service();
    await secrets.set("nougate", "a-real-key");
    config.providers["nougate-anthropic"] = {
      kind: "anthropic",
      baseUrl: "https://nougate.example/anthropic/v1",
      apiKeySecret: "nougate",
    };
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });

    expect(await setup.createAgent(agentInput)).toMatchObject({ provider: SETUP_PROFILE });
  });

  test("a profile with no credential is not chosen", async () => {
    // Naming one writes a pack that loads and then fails on its first message, which is the harder
    // failure of the two to trace back here.
    const { setup, config } = await service();
    config.providers.orphan = { kind: "openai", baseUrl: "https://x/v1", apiKeySecret: "never_set" };

    expect(await setup.createAgent(agentInput)).toMatchObject({ ok: false });
  });

  test("an explicit provider is honoured, and an unknown one is refused by name", async () => {
    const { setup } = await service();
    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });

    expect(await setup.createAgent({ ...agentInput, provider: "nope" })).toMatchObject({ ok: false });
    expect(await setup.createAgent({ ...agentInput, provider: SETUP_PROFILE })).toMatchObject({
      ok: true,
    });
  });

});

describe("state", () => {
  test("tracks each step and only reports complete when all three are done", async () => {
    const { setup } = await service();
    expect(setup.state()).toMatchObject({ hasProvider: false, hasAgent: false, complete: false });

    await setup.saveProvider({ kind: "openai", baseUrl: "https://x/v1", apiKey: LIVE_KEY, actor: "t" });
    expect(setup.state()).toMatchObject({ hasProvider: true, hasAgent: false, complete: false });

    await setup.createAgent({
      id: "nouva",
      displayName: "Nouva",
      systemPrompt: "hi",
      model: "gpt-4o",
      actor: "t",
    });
    expect(setup.state()).toMatchObject({ hasProvider: true, hasAgent: true, complete: true });
  });

  test("a provider profile with no credential does not count as configured", async () => {
    // The state a half-finished setup leaves behind. Reporting it as done sends the operator to a chat
    // window that fails on the first message.
    const { config, setup } = await service();
    config.providers.orphan = {
      kind: "openai",
      baseUrl: "https://x/v1",
      apiKeySecret: "never_set",
    };
    expect(setup.state().hasProvider).toBe(false);
  });
});
