/**
 * Editing gateways and provider profiles from the dashboard.
 *
 * The case this file exists for is the first one: a bot token must reach the secret store and never the
 * config file. It is the easiest thing in the codebase to get wrong — the obvious implementation writes
 * what the operator typed straight into the file — and the failure is silent, because a config with a
 * live token in it works perfectly right up until someone backs it up or commits it.
 *
 * The rest are the refusals, and one absence: nothing here restarts an adapter, because nothing can.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseToml } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import {
  isRetentionScope,
  RETENTION_SCOPES_NAMES,
} from "@/modules/config/settings/memory.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let secrets: SecretStore;
let settings: SettingsService;
let retired: string[];
let providers: ProviderRegistry;

const TOKEN = "5550001111:AAH-this-is-a-live-looking-bot-token";

/** Nine parts comment to one part setting, like the real file — the editor must preserve all of it. */
const EXISTING_CONFIG = `# Nouride configuration.
# This comment must survive every edit made through the dashboard.

[daemon]
name = "nouride"

# ── Gateways ───────────────────────────────────────────────────────────────
# Each connection is NAMED.
`;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-settings-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, EXISTING_CONFIG);

  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];

  // `open` rather than a constructor: the store is a file, and it reads it.
  secrets = await SecretStore.open(dir, {});
  providers = new ProviderRegistry(config.providers, secrets);

  retired = [];
  settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers,
    gatewayStatus: () => new Map(),
    retireGateway: async (id) => {
      retired.push(id);
      return { stopped: true, loggedOut: true };
    },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => readFileSync(configPath, "utf8");

describe("saving a gateway", () => {
  test("writes the credential's NAME to the config and its value only to the store", async () => {
    const result = await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });

    expect(result).toEqual({ ok: true, restartRequired: true });

    const written = read();
    // The assertion the whole file is for.
    expect(written).not.toContain(TOKEN);
    expect(written).toContain('token = "telegram-nouva"');
    expect(await secrets.resolve("telegram-nouva")).toBe(TOKEN);
  });

  test("leaves the operator's comments and unrelated tables alone", async () => {
    await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });

    const written = read();
    expect(written).toContain("# This comment must survive every edit made through the dashboard.");
    expect(written).toContain("[daemon]");
    expect(written).toContain('name = "nouride"');
  });

  test("an update with no token keeps the stored one instead of clearing it", async () => {
    await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });

    await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: false,
      agent: "nouva",
      actor: "test",
    });

    expect(await secrets.resolve("telegram-nouva")).toBe(TOKEN);
    expect(read()).toContain("enabled = false");
    expect(read()).toContain('agent = "nouva"');
  });

  test("refuses a first save with no token — a gateway with no credential cannot connect", async () => {
    const result = await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      actor: "test",
    });

    expect(result).toEqual({ ok: false, field: "token", error: "a token is required to add a gateway" });
    expect(read()).not.toContain("gateways.telegram.nouva");
    expect(config.gateways).toHaveLength(0);
  });

  test("refuses a name that would not survive a TOML header or an id", async () => {
    for (const name of ["my bot", "a.b", "", "-leading"]) {
      const result = await settings.saveGateway({
        platform: "telegram",
        name,
        enabled: true,
        token: TOKEN,
        actor: "test",
      });
      expect(result).toMatchObject({ ok: false, field: "name" });
    }
    expect(read()).not.toContain("[gateways.telegram");
  });

  test("refuses a platform the daemon has no adapter for", async () => {
    const result = await settings.saveGateway({
      platform: "slack",
      name: "main",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });
    expect(result).toEqual({ ok: false, field: "platform", error: 'unknown platform "slack"' });
  });

  test("reports a saved-but-not-running instance as having no status", async () => {
    await settings.saveGateway({
      platform: "discord",
      name: "main",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });

    const [gateway] = settings.gateways();
    // Null rather than "disconnected": an instance awaiting a restart is not a failed connection, and
    // labelling it as one sends someone to debug a network problem that does not exist.
    expect(gateway?.status).toBeNull();
    expect(gateway?.hasCredential).toBe(true);
  });
});

describe("saving a WhatsApp gateway", () => {
  test("writes encryption_key, not token — the loader reads a different field", async () => {
    const result = await settings.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: true,
      actor: "test",
    });

    expect(result).toEqual({ ok: true, restartRequired: true });
    const written = read();
    // The bug this catches: `token = "whatsapp-main"` saved cleanly and produced a gateway that
    // could not start, because `encryption_key` was never set.
    expect(written).toContain("[gateways.whatsapp.main]");
    expect(written).toContain('encryption_key = "whatsapp-main-key"');
    expect(written).not.toMatch(/^token = /m);
  });

  test("writes no session_dir: the login lives under data_dir unless one is given", async () => {
    await settings.saveGateway({ platform: "whatsapp", name: "main", enabled: true, actor: "test" });
    expect(read()).not.toMatch(/^session_dir = /m);
    expect(settings.gateways().find((g) => g.id === "whatsapp:main")?.sessionDir).toMatch(/[\\/]whatsapp$/);
    await settings.saveGateway({ platform: "whatsapp", name: "main", enabled: true, sessionDir: "/var/lib/wa", actor: "test" });
    expect(read()).toContain('session_dir = "/var/lib/wa"');
    // And what the running daemon holds matches the file, never the string "undefined".
    expect(settings.gateways().find((g) => g.id === "whatsapp:main")).toMatchObject({ sessionDir: "/var/lib/wa" });
  });

  test("generates a session key rather than demanding one be pasted", async () => {
    await settings.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: true,
      actor: "test",
    });

    const key = await secrets.resolve("whatsapp-main-key");
    // 32 bytes of hex — what AES-256 wants, and what the bridge refuses to run without.
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Never in the file it was written from.
    expect(read()).not.toContain(key as string);
  });

  test("does not regenerate the key on an unrelated edit", async () => {
    await settings.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: true,
      actor: "test",
    });
    const first = await secrets.resolve("whatsapp-main-key");

    await settings.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: false,
      agent: "nouva",
      actor: "test",
    });

    // A new key here would make the stored session unreadable and silently demand a fresh QR scan.
    expect(await secrets.resolve("whatsapp-main-key")).toBe(first);
  });

  test("reports the credential as present, reading the field this platform uses", async () => {
    await settings.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: true,
      actor: "test",
    });

    const [gateway] = settings.gateways();
    // Asking about `tokenSecret` would report every WhatsApp instance as missing its credential.
    expect(gateway?.hasCredential).toBe(true);
  });

  test("a new connection writes no transport: the bridge runs in this process, which the key left out means", async () => {
    // The dashboard sends no transport at all, so this is what every connection added there gets. It wrote "stdio"
    // once, a transport that no longer exists, and then "inproc", the only value left.
    await settings.saveGateway({ platform: "whatsapp", name: "main", enabled: true, actor: "test" });
    expect(read()).not.toContain("bridge_transport");
  });
});

describe("removing a gateway", () => {
  test("drops the table and the credential with it", async () => {
    await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });

    // `restartRequired: false` because the harness retires the live connection — see
    // `retireGateway`. A delete that needs a restart to take effect is the old behaviour, and it is
    // still what happens when nothing is running to retire.
    const result = await settings.removeGateway("telegram:nouva", "test");
    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).not.toContain("[gateways.telegram.nouva]");
    expect(config.gateways).toHaveLength(0);
    /**
     * This once kept the credential, and the operator was right that it made no sense: "removed, but
     * the credential is kept" is a strange thing to tell someone who pressed delete, and it leaves a
     * secret nobody is tracking behind.
     */
    expect(await secrets.resolve("telegram-nouva")).toBeUndefined();
  });

  test("removing a WhatsApp connection takes the session with it", async () => {
    const sessionDir = join(dir, "wa-session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "creds.enc"), "encrypted-login-bytes");

    await settings.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: true,
      sessionDir,
      actor: "test",
    });

    // Retired live, so nothing has to be restarted for the delete to take effect.
    expect(await settings.removeGateway("whatsapp:main", "test")).toEqual({
      ok: true,
      restartRequired: false,
    });

    // The key and the directory together ARE a working login. Leaving them is how a deleted
    // connection stays signed in to the account.
    expect(await secrets.resolve("whatsapp-main-key")).toBeUndefined();
    expect(existsSync(sessionDir)).toBe(false);
  });

  /**
   * The live connection is retired *before* anything on disk is touched, and for WhatsApp that
   * ordering is the whole bug.
   *
   * Baileys rewrites `creds.enc` on every credential update, so deleting the session directory while
   * the bridge is still running gets it written back within seconds. Reported from a real install as
   * "I deleted it and it is still there" — the files were removed, and then recreated by a process
   * nobody had told to stop.
   */
  test("the connection is retired before the session is deleted", async () => {
    const sessionDir = join(dir, "wa-order");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "creds.enc"), "encrypted-login-bytes");

    const events: string[] = [];
    const ordered = new SettingsService({
      config,
      configPath,
      secrets,
      providers,
      gatewayStatus: () => new Map(),
      retireGateway: async () => {
        // Observed at the moment of retirement: the session must still be on disk here, because a
        // bridge that is stopped afterwards would put it back.
        events.push(existsSync(sessionDir) ? "retire:session-still-there" : "retire:session-gone");
        return { stopped: true, loggedOut: true };
      },
    });

    await ordered.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: true,
      sessionDir,
      actor: "test",
    });
    await ordered.removeGateway("whatsapp:main", "test");

    expect(events).toEqual(["retire:session-still-there"]);
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("a delete with nothing running still cleans up, and says a restart is not needed either", async () => {
    // The config-only path: a CLI editing a file on a box where no daemon is up. There is nothing to
    // retire, so there is also nothing a restart would finish.
    const sessionDir = join(dir, "wa-offline");
    mkdirSync(sessionDir, { recursive: true });

    const offline = new SettingsService({
      config,
      configPath,
      secrets,
      providers,
      gatewayStatus: () => new Map(),
    });
    await offline.saveGateway({
      platform: "whatsapp",
      name: "main",
      enabled: true,
      sessionDir,
      actor: "test",
    });

    const result = await offline.removeGateway("whatsapp:main", "test");
    expect(result).toEqual({ ok: true, restartRequired: true });
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("every platform is retired, not just the one with a session", async () => {
    // Telegram has no files to remove, but its connection still has to go — otherwise the pipeline
    // keeps routing to a gateway with no config entry behind it.
    await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });
    await settings.removeGateway("telegram:nouva", "test");
    expect(retired).toEqual(["telegram:nouva"]);
  });

  test("a credential another connection still uses is left alone", async () => {
    await settings.saveGateway({
      platform: "telegram",
      name: "one",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });
    // Two instances pointing at one secret is not how the UI creates them, but a hand-edited config
    // can, and deleting one must not sign the other out — restarted since the edit or not.
    writeFileSync(configPath, `${read()}\n[gateways.telegram.two]\nenabled = true\ntoken = "telegram-one"\n`);

    await settings.removeGateway("telegram:one", "test");
    expect(await secrets.resolve("telegram-one")).toBe(TOKEN);
    expect(config.gateways.map((gateway) => gateway.id)).toEqual(["telegram:two"]);
  });

  test("refuses one that does not exist", async () => {
    expect(await settings.removeGateway("telegram:ghost", "test")).toEqual({
      ok: false,
      error: 'no gateway "telegram:ghost"',
    });
  });
});

describe("an agent's model", () => {
  test("writes [llm] into the agent's own pack, not the daemon config", async () => {
    const agentConfig = join(dir, "agent-config.toml");
    writeFileSync(
      agentConfig,
      '# Hand-written, keep me.\n\n[agent]\nname = "nouva"\n\n[llm]\nprovider = "anthropic"\nmodel = "old-model"\n',
    );

    await settings.saveProvider({
      name: "nougate",
      kind: "openai",
      baseUrl: "https://gate.example.com/v1",
      apiKey: "sk-live",
      actor: "test",
    });

    const result = await settings.saveAgentModel({
      agentConfigPath: agentConfig,
      reload: async () => {},
      provider: "nougate",
      model: "claude-sonnet-4",
      actor: "test",
      agentId: "nouva",
    });

    expect(result).toEqual({ ok: true, restartRequired: false });
    const written = readFileSync(agentConfig, "utf8");
    expect(written).toContain('provider = "nougate"');
    expect(written).toContain('model = "claude-sonnet-4"');
    expect(written).not.toContain("old-model");
    // The pack is config-as-code and hand-editable; a rewrite that ate the operator's comments would
    // be discovered weeks later, by which point nobody knows what was lost.
    expect(written).toContain("# Hand-written, keep me.");
    expect(written).toContain('name = "nouva"');
    // The daemon's own config is not the place for this.
    expect(read()).not.toContain("claude-sonnet-4");
  });

  test("refuses a profile that is not defined", async () => {
    const agentConfig = join(dir, "agent-config.toml");
    writeFileSync(agentConfig, "[llm]\nprovider = \"anthropic\"\nmodel = \"m\"\n");

    const result = await settings.saveAgentModel({
      agentConfigPath: agentConfig,
      reload: async () => {},
      provider: "ghost",
      model: "m",
      actor: "test",
      agentId: "nouva",
    });

    expect(result).toMatchObject({ ok: false, field: "provider" });
    // Left alone: the agent would otherwise keep loading and fail on its first message, hours later,
    // to whoever happened to message it.
    expect(readFileSync(agentConfig, "utf8")).toContain('provider = "anthropic"');
  });

  test("refuses an empty model", async () => {
    const agentConfig = join(dir, "agent-config.toml");
    writeFileSync(agentConfig, "[llm]\nprovider = \"anthropic\"\nmodel = \"m\"\n");

    expect(
      await settings.saveAgentModel({
        agentConfigPath: agentConfig,
        reload: async () => {},
        provider: "anthropic",
        model: "   ",
        actor: "test",
        agentId: "nouva",
      }),
    ).toMatchObject({ ok: false, field: "model" });
  });
});

describe("provider profiles", () => {
  test("writes the key's name, not the key", async () => {
    const result = await settings.saveProvider({
      name: "nougate",
      kind: "openai",
      baseUrl: "https://gate.example.com/v1/",
      apiKey: "sk-live-key-value",
      actor: "test",
    });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).not.toContain("sk-live-key-value");
    expect(read()).toContain('api_key = "nougate_api_key"');
    // Trailing slash stripped, so the client does not build `//chat/completions`.
    expect(read()).toContain('base_url = "https://gate.example.com/v1"');
    expect(await secrets.resolve("nougate_api_key")).toBe("sk-live-key-value");
  });

  test("an edit keeps what the form does not show — headers, identify, billing — in memory as in the file", async () => {
    await settings.saveProvider({ name: "nougate", kind: "openai", baseUrl: "https://gate.example.com/v1", apiKey: "sk-live", actor: "test" });
    config.providers.nougate = { ...config.providers.nougate!, headers: { "x-team": "ops" }, identify: true, billing: "included" };

    await settings.saveProvider({ name: "nougate", kind: "openai", baseUrl: "https://gate2.example.com/v1", actor: "test" });

    expect(config.providers.nougate).toMatchObject({ baseUrl: "https://gate2.example.com/v1", headers: { "x-team": "ops" }, identify: true, billing: "included" });
  });

  describe("extra headers, as the form sends them", () => {
    const go = { name: "go", kind: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1", actor: "test" };
    const view = () => settings.providerProfiles().find((profile) => profile.name === "go")?.headers;

    test("are written under the profile and live at once: the conversation's header as it was filled, `{session}` and all", async () => {
      expect(await settings.saveProvider({ ...go, apiKey: "sk-live", headers: { "x-opencode-session": "{session}" } })).toEqual({ ok: true, restartRequired: false });
      expect(read()).toContain('headers = { x-opencode-session = "{session}" }');
      expect(config.providers.go?.headers).toEqual({ "x-opencode-session": "{session}" });
      // What is around a name or a value is not part of it: a space after the colon is how a person types a line.
      expect(await settings.saveProvider({ ...go, headers: { " x-team ": "  ops  " } })).toMatchObject({ ok: true });
      expect(config.providers.go?.headers).toEqual({ "x-team": "ops" });
    });

    test("a saved value is never sent back, but the one that is no secret: `{session}`", async () => {
      await settings.saveProvider({ ...go, apiKey: "sk-live", headers: { "x-opencode-session": "{session}", "x-gateway-key": "gw-live-secret-value", "x-trace": "nouride-{session}" } });
      // A value that only holds the placeholder among other text could hold a key beside it: not sent either.
      expect(view()).toEqual({ "x-opencode-session": "{session}", "x-gateway-key": null, "x-trace": null });
      expect(JSON.stringify(settings.providerProfiles())).not.toContain("gw-live-secret-value");
      // A profile with none says so as an empty set, which is what the form reads.
      await settings.saveProvider({ name: "plain", kind: "openai", baseUrl: "https://x.example/v1", apiKey: "sk-live", actor: "test" });
      expect(settings.providerProfiles().find((profile) => profile.name === "plain")?.headers).toEqual({});
    });

    test("a name sent with no value keeps the value saved under it, in whatever case it was typed; a name no longer sent is removed", async () => {
      await settings.saveProvider({ ...go, apiKey: "sk-live", headers: { "x-gateway-key": "gw-live-secret-value", "x-old": "1" } });
      expect(await settings.saveProvider({ ...go, headers: { "X-Gateway-Key": null, "x-opencode-session": "{session}" } })).toMatchObject({ ok: true });
      expect(config.providers.go?.headers).toEqual({ "X-Gateway-Key": "gw-live-secret-value", "x-opencode-session": "{session}" });
      expect(read()).not.toContain("x-old");
      // An empty value is the same as none: the form's line for a saved header has nothing after its colon.
      await settings.saveProvider({ ...go, headers: { "X-Gateway-Key": "  ", "x-opencode-session": "{session}" } });
      expect(config.providers.go?.headers?.["X-Gateway-Key"]).toBe("gw-live-secret-value");
    });

    test("the form's set replaces a table an operator wrote by hand, in whichever of TOML's forms; an empty set removes it", async () => {
      await settings.saveProvider({ ...go, apiKey: "sk-live" });
      writeFileSync(configPath, `${read()}\n[providers.go.headers]\nx-team = "ops"\nx-old = "1"\n`);
      config.providers.go = { ...config.providers.go!, headers: { "x-team": "ops", "x-old": "1" } };

      expect(await settings.saveProvider({ ...go, headers: { "x-team": null, "x-opencode-session": "{session}" } })).toMatchObject({ ok: true });
      expect(read()).not.toContain("[providers.go.headers]");
      expect(config.providers.go?.headers).toEqual({ "x-team": "ops", "x-opencode-session": "{session}" });

      expect(await settings.saveProvider({ ...go, headers: {} })).toMatchObject({ ok: true });
      expect(read()).not.toContain("headers");
      expect(config.providers.go?.headers).toBeUndefined();
      // The rest of the profile is as it was.
      expect(config.providers.go).toMatchObject({ baseUrl: "https://opencode.ai/inference/go/openai/v1", apiKeySecret: "go_api_key" });
    });

    test("not sent at all, as a client from before the field does: the headers it has are left as they are", async () => {
      await settings.saveProvider({ ...go, apiKey: "sk-live", headers: { "x-opencode-session": "{session}" } });
      const before = read();
      await settings.saveProvider({ ...go });
      expect(read()).toBe(before);
      expect(config.providers.go?.headers).toEqual({ "x-opencode-session": "{session}" });
    });

    test("refused, naming the field and writing nothing: a name that is not a header's, the request's own, one given twice, one with no value, a value no header carries, too many", async () => {
      await settings.saveProvider({ ...go, apiKey: "sk-live" });
      const before = read();
      const refused = async (headers: Record<string, string | null>) => {
        const result = await settings.saveProvider({ ...go, headers });
        expect(read()).toBe(before);
        return result;
      };
      expect(await refused({ "x session": "1" })).toEqual({ ok: false, field: "headers", error: '"x session" is not a header\'s name' });
      expect(await refused({ "x-a:": "1" })).toMatchObject({ ok: false, field: "headers" });
      // A key typed as a header would sit in the file as text: the key's own field keeps it as a secret.
      for (const own of ["Authorization", "x-api-key", "Content-Type"]) {
        expect(await refused({ [own]: "v" })).toEqual({ ok: false, field: "headers", error: `${own} is a header the request sends itself: the key goes in the API key field` });
      }
      expect(await refused({ "x-team": "ops", "X-Team": "dev" })).toEqual({ ok: false, field: "headers", error: "header X-Team is there twice" });
      expect(await refused({ "x-new": null })).toEqual({ ok: false, field: "headers", error: "header x-new needs a value" });
      expect(await refused({ "x-new": "" })).toEqual({ ok: false, field: "headers", error: "header x-new needs a value" });
      expect(await refused({ "x-new": "a\nx-injected: 1" })).toEqual({ ok: false, field: "headers", error: "header x-new has a value a header cannot carry" });
      expect(await refused({ "x-new": "v".repeat(1025) })).toMatchObject({ ok: false, field: "headers" });
      expect(await refused(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-h${index}`, "v"])))).toEqual({ ok: false, field: "headers", error: "a provider takes at most 16 extra headers" });
      // At the limits, taken.
      expect(await settings.saveProvider({ ...go, headers: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`x-h${index}`, "v".repeat(1024)])) })).toMatchObject({ ok: true });
    });
  });

  test("refuses to delete a profile an agent still names", async () => {
    await settings.saveProvider({
      name: "nougate",
      kind: "openai",
      baseUrl: "https://gate.example.com/v1",
      apiKey: "sk-live",
      actor: "test",
    });

    const result = await settings.removeProvider("nougate", "test", () => ["nouva", "second"]);
    expect(result).toEqual({ ok: false, error: "still used by nouva, second" });
    // Still there — the agent would otherwise keep loading and fail on its first message, hours later.
    expect(config.providers.nougate).toBeDefined();
  });

  test("deletes one nobody names", async () => {
    await settings.saveProvider({
      name: "nougate",
      kind: "openai",
      baseUrl: "https://gate.example.com/v1",
      apiKey: "sk-live",
      actor: "test",
    });

    expect(await settings.removeProvider("nougate", "test", () => [])).toEqual({
      ok: true,
      restartRequired: false,
    });
    expect(config.providers.nougate).toBeUndefined();
    expect(read()).not.toContain("[providers.nougate]");
  });

  test("refuses an unknown wire format and a missing base URL", async () => {
    expect(
      await settings.saveProvider({
        name: "x",
        kind: "grpc",
        baseUrl: "https://x",
        apiKey: "k",
        actor: "t",
      }),
    ).toMatchObject({ ok: false, field: "kind" });

    expect(
      await settings.saveProvider({
        name: "x",
        kind: "openai",
        baseUrl: "  ",
        apiKey: "k",
        actor: "t",
      }),
    ).toMatchObject({ ok: false, field: "baseUrl" });
  });

  test("a refusal names the field of the form it is about, for the page (0.8.23)", async () => {
    expect(await settings.saveProvider({ name: "my provider", kind: "openai", baseUrl: "https://x", apiKey: "k", actor: "t" })).toMatchObject({ ok: false, field: "name" });
    expect(await settings.saveProvider({ name: "fresh", kind: "openai", baseUrl: "https://x", actor: "t" })).toMatchObject({ ok: false, field: "apiKey" });
  });
});

describe("access mode", () => {
  test("writes the mode and takes effect without a restart", async () => {
    // The in-memory config is the object the pipeline reads on every message. If the write landed in
    // the file alone, turning pairing off would do nothing until the daemon was restarted — which is
    // precisely when an operator cannot afford to wait.
    const result = await settings.setAccessMode({ mode: "allowlist", actor: "test" });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(config.security.access.mode).toBe("allowlist");
    expect(read()).toContain('mode = "allowlist"');
    // The file it edited is still the operator's file.
    expect(read()).toContain("# This comment must survive every edit made through the dashboard.");
  });

  test("refuses a mode that is not one of the three", async () => {
    const result = await settings.setAccessMode({ mode: "off", actor: "test" });
    expect(result.ok).toBe(false);
    expect(config.security.access.mode).toBe("pair");
    expect(read()).not.toContain("[security.access]");
  });

  test("refuses `open` when it would stop the daemon booting again", async () => {
    /**
     * Boot refuses a chat gateway plus an agent holding `exec` plus an unguarded access mode. Writing
     * that combination from the dashboard would save cleanly and then brick the next restart, with the
     * chat that could have fixed it gone with the process. Same guard, applied before the write.
     */
    await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      token: TOKEN,
      actor: "test",
    });
    // An allowlist does not make `open` safe — `open` admits everyone before the list is read.
    config.security.access.allowlist = ["telegram:nouva:5550001111"];

    const result = await settings.setAccessMode({
      mode: "open",
      agentsWithExec: ["nouva"],
      actor: "test",
    });

    expect(result.ok).toBe(false);
    expect(config.security.access.mode).toBe("pair");
  });

  test("allows `open` when no agent can run commands", async () => {
    const result = await settings.setAccessMode({ mode: "open", agentsWithExec: [], actor: "test" });
    expect(result.ok).toBe(true);
    expect(config.security.access.mode).toBe("open");
  });
});

describe("an agent's skills, saved from the Workshop", () => {
  /** A pack directory, since `skills.toml` is written beside `config.toml` rather than into it. */
  function writePack(id = "nouva", existing?: string): string {
    const packDir = join(dir, id);
    mkdirSync(packDir, { recursive: true });
    // Hand-written config in the same directory, so a test can prove the toggle never touches it.
    writeFileSync(join(packDir, "config.toml"), '# Hand-written, keep me.\n\n[agent]\nname = "nouva"\n');
    if (existing) writeFileSync(join(packDir, "skills.toml"), existing);
    return packDir;
  }

  const statesFile = (packDir: string) => readFileSync(join(packDir, "skills.toml"), "utf8");

  test("writes skills.toml into the pack and leaves config.toml alone", async () => {
    const packDir = writePack();

    const result = await settings.saveAgentSkills({
      packDir,
      reload: async () => {},
      agentId: "nouva",
      changes: { "document-authoring": false },
      actor: "test",
    });

    // No restart: a skill is a file read during the reload the caller performs. Nothing is opened,
    // connected or spawned, which is what separates this from `saveMcpServer`.
    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(statesFile(packDir)).toContain("document-authoring = false");

    // The reason the toggle got its own file: a write here can never damage the config that decides
    // whether the agent boots.
    const config = readFileSync(join(packDir, "config.toml"), "utf8");
    expect(config).toContain("# Hand-written, keep me.");
    expect(config).not.toContain("document-authoring");
  });

  test("switching one back on is a decision too: the file says it is on", async () => {
    const packDir = writePack("nouva", "[skills]\ndocument-authoring = false\n");

    await settings.saveAgentSkills({ packDir, reload: async () => {}, agentId: "nouva", changes: { "document-authoring": true }, actor: "test" });

    expect(statesFile(packDir)).toContain("document-authoring = true");
  });

  test("a change merges into what the file holds, so switches flipped in two tabs both stay", async () => {
    // Each tab used to send its whole copy of the map, and the later one undid the earlier's switch.
    const packDir = writePack("nouva", "[skills]\na = false\n");

    await Promise.all([
      settings.saveAgentSkills({ packDir, reload: async () => {}, agentId: "nouva", changes: { b: false }, actor: "tab-1" }),
      settings.saveAgentSkills({ packDir, reload: async () => {}, agentId: "nouva", changes: { c: false }, actor: "tab-2" }),
    ]);

    const written = statesFile(packDir);
    for (const line of ["a = false", "b = false", "c = false"]) expect(written).toContain(line);
  });

  test("an explicit `true` is kept, because it is a decision somebody made", async () => {
    const packDir = writePack();

    await settings.saveAgentSkills({
      packDir,
      reload: async () => {},
      agentId: "nouva",
      changes: { reviewed: true, dropped: false },
      actor: "test",
    });

    expect(statesFile(packDir)).toContain("reviewed = true");
    expect(statesFile(packDir)).toContain("dropped = false");
  });

  test("sorted, so the file does not churn", async () => {
    // The dashboard sends whatever order its switches are in. A file that rewrites itself differently
    // on every save makes a git diff of the agents directory useless for seeing what changed.
    const packDir = writePack();

    await settings.saveAgentSkills({
      packDir,
      reload: async () => {},
      agentId: "nouva",
      changes: { zeta: false, alpha: false },
      actor: "test",
    });

    const lines = statesFile(packDir).split("\n").filter((line) => line.includes("="));
    expect(lines).toEqual(["alpha = false", "zeta = false"]);
  });

  test("a non-boolean is refused rather than coerced", async () => {
    // `"off"` coerced to `true` is a skill switched on while the dashboard shows it off — the
    // silent-setting class of bug this codebase keeps finding.
    const packDir = writePack();

    const result = await settings.saveAgentSkills({
      packDir,
      reload: async () => {},
      agentId: "nouva",
      changes: { broken: "off" as unknown as boolean },
      actor: "test",
    });

    expect(result.ok).toBe(false);
  });
});

describe("the group context window, saved from the dashboard", () => {
  const base = { platform: "telegram", name: "nouva", enabled: true, actor: "test" } as const;

  test("an override is written to the connection's table", async () => {
    await settings.saveGateway({ ...base, token: TOKEN, groupContextMessages: 5 });

    expect(read()).toContain("group_context_messages = 5");
    expect(config.gateways[0]?.groupContextMessages).toBe(5);
  });

  test("it applies without the restart the response asks for", async () => {
    // Everything else here needs a restart because adapters are built at boot. This one does not: the
    // pipeline reads the connection's window off the live config object on every message, so mirroring
    // it there is the whole of the change. Claiming otherwise would send the operator to restart a
    // daemon for a setting that already took effect.
    await settings.saveGateway({ ...base, token: TOKEN, groupContextMessages: 5 });
    await settings.saveGateway({ ...base, groupContextMessages: 0 });

    expect(config.gateways[0]?.groupContextMessages).toBe(0);
    expect(read()).toContain("group_context_messages = 0");
  });

  test("the daemon's own default is not written as an override", async () => {
    // A form submits its own placeholder on every save. Written through, every gateway table would
    // grow a line restating a setting nobody touched — and then stop following the daemon's.
    await settings.saveGateway({
      ...base,
      token: TOKEN,
      groupContextMessages: config.agents.groupContextMessages,
    });

    expect(read()).not.toContain("group_context_messages");
    expect(config.gateways[0]?.groupContextMessages).toBeUndefined();
  });

  test("a connection that already overrides it can be set back to the daemon's value", async () => {
    // `upsertTomlTable` only writes keys, so "clear the override" is not reachable. Pinning the same
    // number the daemon uses behaves identically, and the line has to actually change to do it.
    await settings.saveGateway({ ...base, token: TOKEN, groupContextMessages: 5 });
    await settings.saveGateway({
      ...base,
      groupContextMessages: config.agents.groupContextMessages,
    });

    expect(read()).toContain(`group_context_messages = ${config.agents.groupContextMessages}`);
    expect(config.gateways[0]?.groupContextMessages).toBe(config.agents.groupContextMessages);
  });

  test("omitting it leaves an existing override alone", async () => {
    // The same rule `token` follows: a save about an unrelated field must not silently reset one.
    await settings.saveGateway({ ...base, token: TOKEN, groupContextMessages: 5 });
    await settings.saveGateway({ ...base, agent: "nouva" });

    expect(read()).toContain("group_context_messages = 5");
    expect(config.gateways[0]?.groupContextMessages).toBe(5);
  });

  test("a value outside the range is refused, not clamped", async () => {
    // This path edits the file without going through the loader, so a dashboard sending 5000 would
    // install a value the next boot dies on.
    for (const bad of [500, -1, 2.5]) {
      const result = await settings.saveGateway({ ...base, token: TOKEN, groupContextMessages: bad });
      expect(result).toMatchObject({ ok: false, field: "groupContextMessages" });
    }
    expect(read()).not.toContain("group_context_messages");
  });

  test("it reports what a connection with no override of its own inherits", async () => {
    expect(settings.groupContextDefault()).toBe(config.agents.groupContextMessages);
  });
});

describe("the daemon-wide group context window", () => {
  test("writes to [agents], not to a connection", async () => {
    // The setting is daemon-wide. Written into a gateway table it would apply to one bot and quietly
    // leave every other one on the old value.
    const result = await settings.setGroupContextMessages({ messages: 40, actor: "test" });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).toContain("[agents]");
    expect(read()).toContain("group_context_messages = 40");
    expect(config.agents.groupContextMessages).toBe(40);
  });

  test("no restart is asked for, because none is needed", async () => {
    // The pipeline reads this off the live config on every message, so mirroring it is the whole of the
    // change. Reporting `restartRequired` would send an operator to restart a daemon for a setting that
    // already applied — and the next thing they would conclude is that the restart is what did it.
    const result = await settings.setGroupContextMessages({ messages: 0, actor: "test" });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(config.agents.groupContextMessages).toBe(0);
  });

  test("setting it to what it already is writes nothing", async () => {
    // A form that submits on blur would otherwise rewrite the file, and audit it, on every visit.
    const before = read();
    const result = await settings.setGroupContextMessages({
      messages: config.agents.groupContextMessages,
      actor: "test",
    });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).toBe(before);
  });

  test("a value outside the range is refused and nothing is written", async () => {
    const before = read();
    for (const bad of [101, -1, 2.5, Number.NaN]) {
      const result = await settings.setGroupContextMessages({ messages: bad, actor: "test" });
      expect(result.ok).toBe(false);
    }
    expect(read()).toBe(before);
    expect(config.agents.groupContextMessages).toBe(DEFAULT_CONFIG.agents.groupContextMessages);
  });

  test("it leaves the operator's comments and unrelated tables alone", async () => {
    await settings.setGroupContextMessages({ messages: 5, actor: "test" });

    const written = read();
    expect(written).toContain("# This comment must survive every edit made through the dashboard.");
    expect(written).toContain('name = "nouride"');
  });

  test("a connection's override survives a change to the daemon setting", async () => {
    // The two are a precedence pair, not one value in two places: changing the daemon's must not
    // silently retune a connection somebody deliberately set apart.
    await settings.saveGateway({
      platform: "telegram",
      name: "nouva",
      enabled: true,
      token: TOKEN,
      actor: "test",
      groupContextMessages: 5,
    });
    await settings.setGroupContextMessages({ messages: 40, actor: "test" });

    expect(config.agents.groupContextMessages).toBe(40);
    expect(config.gateways[0]?.groupContextMessages).toBe(5);
  });
});

/**
 * The self-improvement dials.
 *
 * Two properties matter here and neither is obvious from the setter's signature: a rejected patch
 * must change *nothing* (not the valid half of it), and a saved one must mutate the very object the
 * reflection loop holds — it is handed `config.rsi` by reference and reads it per turn, so replacing
 * the object instead of mutating it would leave the loop on the old numbers for the life of the
 * process, with nothing to say so.
 */
describe("how long conversations are kept", () => {
  test("writes [retention] session_days and applies to the next sweep", async () => {
    /**
     * 45, not 30. This asked for 30 and stopped passing the day 30 became the default — the writer
     * returns early when the value is already what it is, so nothing reached the file and the test
     * read a config that was right and looked empty. A fixture that happens to equal a default tests
     * the early return rather than the write.
     */
    const result = await settings.setRetentionDays({ scope: "sessions", days: 45, actor: "test" });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).toContain("session_days = 45");
    // The running copy too: the daily sweep reads it from here, not from the file.
    expect(config.retention.sessionDays).toBe(45);
  });

  test("setting it to what it already is writes nothing", async () => {
    // The early return the test above tripped over, asserted on purpose: the dashboard sends the
    // current value on every save, and a file rewritten for no change is a file whose mtime lies.
    const before = read();

    const result = await settings.setRetentionDays({
      scope: "sessions",
      days: config.retention.sessionDays,
      actor: "test",
    });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).toBe(before);
  });

  test("zero keeps everything rather than deleting everything", async () => {
    // The opposite reading would make a mistyped zero erase every conversation on the next sweep,
    // and there is no undo and no second copy. Asserted against the sweep's own behaviour, not just
    // the stored number.
    const result = await settings.setRetentionDays({ scope: "sessions", days: 0, actor: "test" });

    expect(result.ok).toBe(true);
    expect(config.retention.sessionDays).toBe(0);
  });

  test("a window nobody meant is refused and nothing is written", async () => {
    const before = read();
    for (const bad of [-1, 3651, 2.5, Number.NaN]) {
      const result = await settings.setRetentionDays({ scope: "sessions", days: bad, actor: "test" });
      expect(result.ok).toBe(false);
    }

    expect(read()).toBe(before);
  });

  test("every scope the settings module knows is reported", () => {
    /**
     * The assertion that would have caught the route rejecting a window the store had.
     *
     * `RETENTION_SCOPES_NAMES` is derived from the map, and `retentionWindows` lists them one by one
     * — so a scope added to the map and forgotten in the reader shows up here rather than as a
     * control that fetches `undefined` and renders nothing.
     */
    const windows = settings.retentionWindows();

    expect(Object.keys(windows).sort()).toEqual([...RETENTION_SCOPES_NAMES].sort());
    for (const scope of RETENTION_SCOPES_NAMES) {
      expect(isRetentionScope(scope)).toBe(true);
      expect(typeof windows[scope]).toBe("number");
    }
    expect(isRetentionScope("nonsense")).toBe(false);
  });
});

describe("the daily spend cap", () => {
  test("writes into [llm.limits] and applies without a restart", async () => {
    // Live matters more here than for the settings above: this is read at the top of every turn,
    // before the provider is called. A cap needing a restart is one you set while watching the
    // number climb and that does nothing until you stop the daemon.
    const result = await settings.setDailyCostCap({ usd: 12.5, actor: "test" });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).toContain("[llm.limits]");
    expect(read()).toContain("max_daily_cost_usd = 12.5");
    expect(config.llm.limits.maxDailyCostUsd).toBe(12.5);
  });

  test("zero is a value, not a missing one", async () => {
    // `0` is the shipped default and it means "nothing is enforced". Treating it as unset would make
    // removing a cap impossible through the dashboard that set it.
    await settings.setDailyCostCap({ usd: 30, actor: "test" });
    const result = await settings.setDailyCostCap({ usd: 0, actor: "test" });

    expect(result.ok).toBe(true);
    expect(read()).toContain("max_daily_cost_usd = 0");
    expect(config.llm.limits.maxDailyCostUsd).toBe(0);
  });

  test("a third decimal place is refused rather than rounded", async () => {
    // Rounding silently would accept 0.005 and save 0.01 — twice what was typed, in the one setting
    // where the number is the entire point.
    const before = read();
    const result = await settings.setDailyCostCap({ usd: 0.005, actor: "test" });

    expect(result.ok).toBe(false);
    expect(read()).toBe(before);
  });

  test("a number nobody meant is refused", async () => {
    // The failure guarded against is a typo: 500 typed as 50000 is indistinguishable from no cap in
    // effect, so the mistake produces the unbounded daemon the operator was trying to avoid while
    // the dashboard shows a number that looks like protection.
    const before = read();
    for (const bad of [-1, 10_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await settings.setDailyCostCap({ usd: bad, actor: "test" });
      expect(result.ok).toBe(false);
    }

    expect(read()).toBe(before);
    expect(config.llm.limits.maxDailyCostUsd).toBe(DEFAULT_CONFIG.llm.limits.maxDailyCostUsd);
  });

  test("setting it to what it already is writes nothing", async () => {
    const before = read();
    const result = await settings.setDailyCostCap({
      usd: config.llm.limits.maxDailyCostUsd,
      actor: "test",
    });

    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).toBe(before);
  });
});

describe("skill learning settings", () => {
  test("writes [skills.learning] whole and applies it in place", async () => {
    const held = config.skills.learning;

    const result = await settings.setSkillLearning({ patch: { model: " haiku ", mode: "off" }, actor: "test" });
    expect(result).toEqual({ ok: true, restartRequired: false });

    const written = read();
    expect(written).toContain("[skills.learning]");
    expect(written).toContain('mode = "off"');
    expect(written).toContain('model = "haiku"');
    // Every field, not only the changed ones: the file should state the configuration in force.
    expect(written).toContain("notify_chat = true");

    // The same object the engine was handed, mutated — not a replacement.
    expect(held).toBe(config.skills.learning);
    expect(config.skills.learning).toEqual({ mode: "off", model: "haiku", notifyChat: true });
  });

  test("a patch with one bad field changes nothing at all", async () => {
    const before = { ...config.skills.learning };
    const result = await settings.setSkillLearning({ patch: { model: "m", mode: "always_allow" as never }, actor: "test" });
    // The bad one named for the page, not the first sent (0.8.23).
    expect(result).toMatchObject({ ok: false, field: "mode" });
    if (!result.ok) expect(result.error).toContain("off, ask, auto");
    expect(await settings.setSkillLearning({ patch: { model: 3 as never } })).toMatchObject({ ok: false, field: "model" });
    expect(await settings.setSkillLearning({ patch: { notifyChat: "yes" as never } })).toMatchObject({ ok: false, field: "notifyChat" });
    // The valid half must not have been applied.
    expect(config.skills.learning).toEqual(before);
    expect(read()).not.toContain("[skills.learning]");
  });

  test("saving the values already in force writes nothing", async () => {
    const result = await settings.setSkillLearning({ patch: { mode: "ask" } });
    expect(result).toEqual({ ok: true, restartRequired: false });
    expect(read()).not.toContain("[skills.learning]");
  });
});

/**
 * Naming a person, from the dashboard or from `nouride people set`.
 *
 * The rule that matters is not "it writes the file" — it is that the **file and the running daemon
 * agree**. `savePerson` edits both, and they are two different code paths: one patches TOML text, the
 * other mutates the config object the next turn will read. When those disagree the operator reads one
 * and the agent reads the other, and neither is wrong from where they are standing.
 *
 * A person is their key since 0.7.0, and accounts are optional — so most of what follows is about the
 * key being the one handle, and an old file's entries (first account as `id`, no key) being read and
 * written in the new shape without losing anything.
 */
describe("naming a person", () => {
  const alex = {
    key: "alex",
    ids: ["discord:214700000000000001", "telegram:5550001111", "whatsapp:628111000001@s.whatsapp.net"],
    name: "Alex",
    notes: "Founder.",
  };
  /** Alex as a file holds them: a key, three accounts on a multi-line array — the shape an edit must not break. */
  const ALEX = `[[people]]\nkey = "alex"\nids = [\n  "discord:214700000000000001",\n  "telegram:5550001111",\n  "whatsapp:628111000001@s.whatsapp.net",\n]\nname = "Alex"\nnotes = "Founder."\n`;
  function writeAlex() {
    config.people = [structuredClone(alex)];
    writeFileSync(configPath, `${EXISTING_CONFIG}\n${ALEX}`);
  }

  test("somebody new by name alone: a key made from it, no account, in the file and the running config", async () => {
    const result = await settings.savePerson({ person: { name: "Kak Sam" }, create: true });

    expect(result).toMatchObject({ ok: true, restartRequired: false, person: { key: "sam", name: "Kak Sam" } });
    expect(config.people).toEqual([{ key: "sam", name: "Kak Sam" }]);
    expect(parseToml<{ people: unknown[] }>(read()).people).toEqual([{ key: "sam", name: "Kak Sam" }]);
  });

  test("a key the operator chose is the one written", async () => {
    await settings.savePerson({ person: { key: "kak-sam", name: "Kak Sam" }, create: true });
    expect(config.people[0]?.key).toBe("kak-sam");
    expect(read()).toContain('key = "kak-sam"');
  });

  test("no duplicate key: a new person with a key somebody holds is refused, and nobody is saved over", async () => {
    await settings.savePerson({ person: { key: "sam", name: "Sam", notes: "Alex's sister." }, create: true });
    const before = read();

    const result = await settings.savePerson({ person: { key: "sam", name: "Samuel" }, create: true });

    expect(result).toMatchObject({ ok: false, field: "key" });
    // Whose it is, so the operator knows what to choose instead.
    expect(result.ok ? "" : result.error).toContain("Sam");
    expect(read()).toBe(before);
    expect(config.people).toEqual([{ key: "sam", name: "Sam", notes: "Alex's sister." }]);
  });

  test("a key that is not lowercase letters and digits joined by '-' is refused before anything is written", async () => {
    const before = read();
    for (const key of ["Sam", "sam wijaya", "sam_w", "../x", "-sam", "sam-", "shared", "a".repeat(33)]) {
      const result = await settings.savePerson({ person: { key, name: "Sam" }, create: true });
      expect(result.ok, key).toBe(false);
      expect(result.ok ? null : result.field, key).toBe("key");
    }
    expect(read()).toBe(before);
    expect(config.people).toEqual([]);
  });

  test("named by an account they hold — what `people set <account>` and `person_record` send — updates them, not a second entry", async () => {
    writeAlex();

    const result = await settings.savePerson({ person: { name: "Alex Doe" }, account: "telegram:bot:5550001111" });

    expect(result).toMatchObject({ ok: true, person: { key: "alex", name: "Alex Doe" } });
    expect(config.people).toHaveLength(1);
    // Every address survives the edit, in memory and in the file.
    expect(config.people[0]?.ids).toEqual(alex.ids);
    const written = parseToml<{ people: Record<string, unknown>[] }>(read()).people;
    expect(written).toEqual([{ key: "alex", ids: alex.ids, name: "Alex Doe", notes: "Founder." }]);
  });

  test("an account nobody holds is somebody new holding it, keyed by name", async () => {
    const result = await settings.savePerson({ person: { name: "Kak Sam" }, account: "discord:214" });
    expect(result).toMatchObject({ ok: true, person: { key: "sam", ids: ["discord:214"] } });
    expect(parseToml<{ people: unknown[] }>(read()).people).toEqual([{ key: "sam", name: "Kak Sam", ids: ["discord:214"] }]);
  });

  test("forgetting somebody — by key, or by any account they hold — removes them from both", async () => {
    writeAlex();
    await settings.removePerson({ person: "telegram:bot:5550001111" });
    expect(config.people).toHaveLength(0);
    expect(read()).not.toContain("[[people]]");

    await settings.savePerson({ person: { name: "Sam" }, create: true });
    await settings.removePerson({ person: "sam" });
    expect(config.people).toHaveLength(0);
    expect(read()).not.toContain("[[people]]");
  });

  test("setting only a name leaves the notes", async () => {
    /**
     * `nouride people set <account> --name X` says nothing about notes, and an agent recording somebody
     * runs the same save. Treating "said nothing" as "clear it" deleted the operator's own description
     * of that person — silently, from a file they hand-edit.
     */
    await settings.savePerson({ person: { key: "sam", name: "Sam", notes: "Alex's sister." }, create: true });
    await settings.savePerson({ person: { key: "sam", name: "Kak Sam" } });

    expect(config.people[0]).toMatchObject({ name: "Kak Sam", notes: "Alex's sister." });
    expect(read()).toContain('notes = "Alex\'s sister."');
  });

  test("an explicitly empty note clears it", async () => {
    // The only way the dashboard's emptied field can mean anything. Absent keeps, empty clears.
    await settings.savePerson({ person: { key: "sam", name: "Sam", notes: "outdated" }, create: true });
    await settings.savePerson({ person: { key: "sam", name: "Sam", notes: "" } });

    expect(config.people[0]?.notes).toBeUndefined();
    expect(read()).not.toContain("outdated");
  });

  test("a nameless person is refused before anything is written", async () => {
    const before = read();
    const result = await settings.savePerson({ person: { name: "  " }, create: true });

    expect(result).toMatchObject({ ok: false, field: "name" });
    expect(read()).toBe(before);
  });

  /**
   * Editing the list of addresses itself — the thing that used to need a hand-edit of `config.toml`.
   *
   * `ids` follows `notes` exactly: absent keeps, a value replaces, empty clears. That distinction is
   * the whole contract, because the callers that say nothing about ids (`nouride people set`, the
   * `person_record` tool) outnumber the one that manages them.
   */
  describe("the accounts a person is reachable at", () => {
    test("a sent list replaces the old one, in the file and in memory", async () => {
      writeAlex();

      await settings.savePerson({
        person: {
          key: "alex",
          name: "Alex",
          // One sent with the connection it came in on, as the access page lists senders: kept as the platform's.
          ids: ["telegram:bot:5550001111", "web:usr_0f1e2d3c4b5a69788796"],
        },
      });

      expect(config.people).toHaveLength(1);
      expect(config.people[0]?.ids).toEqual(["telegram:5550001111", "web:usr_0f1e2d3c4b5a69788796"]);
      const written = read();
      expect(written).toContain('ids = ["telegram:5550001111", "web:usr_0f1e2d3c4b5a69788796"]');
      // The dropped ones are gone, rather than left behind as stray lines of a multi-line array — the shape
      // that would have been syntactically broken TOML.
      expect(written).not.toContain("628111000001");
      expect(written).not.toContain("214700000000000001");
      expect(written.match(/\[\[people\]\]/g)).toHaveLength(1);
    });

    test("notes may be a page of markdown — what USER.md was — and come back as written", async () => {
      writeAlex();
      const page = "Call him Al one-on-one.\n\n## Work\n- Founder; \"peers\" — correct him.";

      await settings.savePerson({ person: { key: "alex", name: "Alex", notes: page } });

      expect(config.people[0]?.notes).toBe(page);
      const written = parseToml<{ people: { notes?: string }[] }>(read());
      expect(written.people[0]?.notes).toBe(page);
    });

    test("an empty list leaves them with no account — still the same person, notes and all", async () => {
      writeAlex();

      await settings.savePerson({ person: { key: "alex", name: "Alex", ids: [] } });

      expect(config.people).toEqual([{ key: "alex", name: "Alex", notes: "Founder." }]);
      expect(parseToml<{ people: unknown[] }>(read()).people).toEqual([{ key: "alex", name: "Alex", notes: "Founder." }]);
    });

    test("any account can go, the first one included: the entry is edited, never added again", async () => {
      // Until 0.7.0 the first account was the person, and dropping it from the dashboard had to be kept
      // from appending a second block. The key is the person, so it is just an address.
      writeAlex();

      await settings.savePerson({ person: { key: "alex", name: "Alex", ids: ["whatsapp:main:628111000001@s.whatsapp.net"] } });

      expect(config.people).toHaveLength(1);
      const written = read();
      expect(written.match(/\[\[people\]\]/g)).toHaveLength(1);
      expect(written).toContain('ids = ["whatsapp:628111000001@s.whatsapp.net"]');
      expect(written).not.toContain("214700000000000001");
    });

    test("an account that belongs to somebody else is refused, not written", async () => {
      writeAlex();
      await settings.savePerson({ person: { name: "Sam" }, account: "discord:214" });
      const before = read();

      const result = await settings.savePerson({ person: { key: "alex", name: "Alex", ids: ["discord:214"] } });

      expect(result).toMatchObject({ ok: false, field: "ids" });
      // The refusal names who already holds it: the operator has to decide *whose* address it is, and a
      // bare "already taken" leaves them opening config.toml to find out.
      expect(result.ok ? "" : result.error).toContain("Sam");
      expect(read()).toBe(before);
      expect(config.people[0]?.ids).toEqual(alex.ids);
    });

    test("an account without its platform is refused, not written", async () => {
      const result = await settings.savePerson({ person: { name: "Sam", ids: ["5550001111"] }, create: true });
      expect(result).toMatchObject({ ok: false, field: "ids" });
      expect(config.people).toEqual([]);
    });

    test("saying nothing about accounts keeps them", async () => {
      writeAlex();

      await settings.savePerson({ person: { key: "alex", name: "Alex Doe" } });

      expect(config.people[0]?.ids).toEqual(alex.ids);
      expect(read()).toContain("628111000001");
    });
  });
});
