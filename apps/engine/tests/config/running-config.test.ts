/**
 * After any save, the running daemon's config is what the next boot would load from the file.
 *
 * Every setter used to mirror its own write into the config object by hand, and the mirrors drifted from the loader
 * with nothing to show it until a restart — a WhatsApp connection saved from the dashboard took Telegram's reconnect
 * timings and resolved a session directory without its `~`.
 * Now the running copy follows the loader's reading of the file
 * (`config/follow.ts`), and this walks every way the daemon's `config.toml` is written while it runs: write through
 * it, then the running config must be exactly what `loadGlobalConfig` — the boot's own entry — makes of the file, and
 * every section the daemon holds by reference must still be the object it holds.
 *
 * A writer added without a row here fails the first test, which reads every method of the settings service.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@nouride/persona";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { loadGlobalConfig } from "@/modules/config/global/index.ts";
import { configJsonSchema, describeConfig, findField, snakeCase } from "@/modules/config/schema.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { keyEveryone, updatePersonNotes } from "@/modules/config/settings/people.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { setOrchestrator } from "@/modules/setup/agent-access.ts";
import { FileService } from "@/modules/setup/files.ts";
import { SetupService } from "@/modules/setup/service.ts";

/** An install as somebody keeps one: comments, a provider with headers the form never shows, two connections, people. */
const START = `# Hand-written. Every save must leave this line where it is.

[daemon]
name = "nouride"

[dashboard]
public_url = "https://nouride.example.com"
password_login = false

[dashboard.oauth]
issuer = "https://id.example.com"
client_id = "nouride"
secret_name = "nouride_oauth"

[providers.local]
kind = "openai"
base_url = "http://127.0.0.1:11434/v1"
api_key = "local_key"
headers = { "x-team" = "ops" }

[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"
agent = "nouva"

[gateways.whatsapp.main]
enabled = false
encryption_key = "whatsapp-main-key"

[[people]]
key = "gading"
name = "Gading"
ids = ["telegram:814"]
notes = "Founder."

[skills]
off = ["old-skill"]
`;

/** Somebody written by hand without a key, as a 0.5 file and an operator both write them. */
const KEYLESS = `\n[[people]]\nname = "Sam"\nids = ["telegram:777"]\n`;

let root: string;
let previousConfigEnv: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-running-"));
  previousConfigEnv = process.env.NOURIDE_CONFIG;
});

afterAll(() => {
  if (previousConfigEnv === undefined) delete process.env.NOURIDE_CONFIG;
  else process.env.NOURIDE_CONFIG = previousConfigEnv;
  rmSync(root, { recursive: true, force: true });
});

let installs = 0;

/** An install loaded the way the daemon loads it, with everything that writes its config while it runs. */
async function install(text: string = START) {
  const dir = join(root, `install-${(installs += 1)}`);
  const configPath = join(dir, ".nouride", "config.toml");
  mkdirSync(join(dir, ".nouride"), { recursive: true });
  writeFileSync(configPath, text);
  // The loader's own first candidate: what boot reads, and what the next boot would.
  process.env.NOURIDE_CONFIG = configPath;
  const fresh = async (): Promise<GlobalConfig> => (await loadGlobalConfig(dir)).config;
  const config = await fresh();

  const secrets = await SecretStore.open(config.daemon.dataDir, {});
  await secrets.set("local_key", "a-local-key");
  await secrets.set("telegram-nouva", "5550001111:AAH-a-live-looking-token");
  const providers = new ProviderRegistry(config.providers, secrets);
  const settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers,
    gatewayStatus: () => new Map(),
    retireGateway: async () => ({ stopped: true, loggedOut: false }),
  });

  /** What other parts of the daemon are handed at boot and keep: each must still be the object they hold. */
  const held = {
    learning: config.skills.learning,
    cron: config.cron,
    exec: config.security.exec,
    access: config.security.access,
    web: config.security.web,
    limits: config.llm.limits,
    memory: config.memory,
    providers: config.providers,
    skillsOff: config.skills.off,
    gateways: config.gateways,
    people: config.people,
  };
  const holding = () => ({
    learning: config.skills.learning,
    cron: config.cron,
    exec: config.security.exec,
    access: config.security.access,
    web: config.security.web,
    limits: config.llm.limits,
    memory: config.memory,
    providers: config.providers,
    skillsOff: config.skills.off,
    gateways: config.gateways,
    people: config.people,
  });
  return { dir, configPath, config, initial: structuredClone(config), fresh, secrets, providers, settings, held, holding };
}

type Install = Awaited<ReturnType<typeof install>>;

interface Row {
  /** The `SettingsService` method this writes through, when it is one. */
  method?: keyof SettingsService;
  via: string;
  /** The file it starts from, when not `START`. */
  start?: string;
  /** False for a write the loader reads the same as before it. */
  changes?: boolean;
  write: (h: Install) => Promise<{ ok: boolean }>;
}

const actor = "walk";

const ROWS: Row[] = [
  // ── the settings service: the dashboard, the CLI through the control API, and an agent's `nouride` tool ──
  { method: "saveGateway", via: "a new Telegram connection", write: ({ settings }) => settings.saveGateway({ platform: "telegram", name: "nox", enabled: true, token: "5550002222:AAH-another-live-looking-token", agent: "nox", actor }) },
  { method: "saveGateway", via: "a new WhatsApp connection with its session under ~", write: ({ settings }) => settings.saveGateway({ platform: "whatsapp", name: "home", enabled: true, sessionDir: "~/wa-session", actor }) },
  { method: "saveGateway", via: "an edit to a WhatsApp connection that says nothing of its bridge", write: ({ settings }) => settings.saveGateway({ platform: "whatsapp", name: "main", enabled: true, agent: "nouva", actor }) },
  { method: "saveGateway", via: "a connection's own group context", write: ({ settings }) => settings.saveGateway({ platform: "telegram", name: "nouva", enabled: true, groupContextMessages: 5, actor }) },
  { method: "removeGateway", via: "removing a connection", write: ({ settings }) => settings.removeGateway("telegram:nouva", actor) },
  { method: "saveProvider", via: "a new provider profile", write: ({ settings }) => settings.saveProvider({ name: "gate", kind: "anthropic", baseUrl: "https://gate.example.com/v1", apiKey: "a-gate-key", actor }) },
  { method: "saveProvider", via: "an edit to a profile, its headers kept", write: ({ settings }) => settings.saveProvider({ name: "local", kind: "openai", baseUrl: "http://127.0.0.1:11435/v1", actor }) },
  { method: "removeProvider", via: "removing a profile", write: ({ settings }) => settings.removeProvider("local", actor, () => []) },
  { method: "setTurnSeconds", via: "the turn's wall clock", write: ({ settings }) => settings.setTurnSeconds({ seconds: 120, actor }) },
  { method: "setJobQuietMinutes", via: "a job's quiet wait", write: ({ settings }) => settings.setJobQuietMinutes({ minutes: 30, actor }) },
  { method: "setUpdateTrack", via: "the update track", write: ({ settings }) => settings.setUpdateTrack({ track: "lts", actor }) },
  { method: "setBackupSeal", via: "the backup passphrase", write: ({ settings }) => settings.setBackupSeal({ passphrase: "a long walk to the river", actor }) },
  { method: "setToolIterations", via: "the tool budget", write: ({ settings }) => settings.setToolIterations({ iterations: 40, actor }) },
  { method: "setAccessMode", via: "who may talk", write: ({ settings }) => settings.setAccessMode({ mode: "allowlist", actor }) },
  { method: "setSkillLearning", via: "skill learning", write: ({ settings }) => settings.setSkillLearning({ patch: { mode: "off" }, actor }) },
  { method: "setSkillOffGlobally", via: "a skill off for every agent", write: ({ settings }) => settings.setSkillOffGlobally({ name: "web-research", off: true, actor }) },
  { method: "setPasswordLogin", via: "password sign-in back on", write: ({ settings }) => settings.setPasswordLogin({ enabled: true, actor }) },
  { method: "setGroupContextMessages", via: "the daemon's group context", write: ({ settings }) => settings.setGroupContextMessages({ messages: 40, actor }) },
  { method: "setMcpServerEnabled", via: "the MCP server", write: ({ settings }) => settings.setMcpServerEnabled({ enabled: true, actor }) },
  { method: "setMemorySettings", via: "[memory]", write: ({ settings }) => settings.setMemorySettings({ patch: { promptRecent: 8, transcriptDays: 14 }, actor }) },
  { method: "setMemorySettings", via: "[memory.semantic], a table of its own", write: ({ settings }) => settings.setMemorySettings({ patch: { semantic: { model: "bge-m3", dimensions: 512 } }, actor }) },
  { method: "setPersonFacts", via: "one person's facts", write: ({ settings }) => settings.setPersonFacts({ key: "gading", facts: "ask", actor }) },
  { method: "setMemorySettings", via: "[memory] recall off", write: ({ settings }) => settings.setMemorySettings({ patch: { recall: false }, actor }) },
  { method: "setPersonRecall", via: "one person's recall", write: ({ settings }) => settings.setPersonRecall({ key: "gading", recall: false, actor }) },
  { method: "setRetentionDays", via: "the log window", write: ({ settings }) => settings.setRetentionDays({ scope: "log", days: 7, actor }) },
  { method: "setRetentionDays", via: "the audit window", write: ({ settings }) => settings.setRetentionDays({ scope: "audit", days: 90, actor }) },
  { method: "setRetentionDays", via: "the cron runs window, held by the scheduler", write: ({ settings }) => settings.setRetentionDays({ scope: "cronRuns", days: 21, actor }) },
  { method: "setRetentionDays", via: "the job logs window", write: ({ settings }) => settings.setRetentionDays({ scope: "jobLogs", days: 5, actor }) },
  { method: "setRetentionDays", via: "the conversations window", write: ({ settings }) => settings.setRetentionDays({ scope: "sessions", days: 45, actor }) },
  { method: "setWebSearchSettings", via: "web search", write: ({ settings }) => settings.setWebSearchSettings({ patch: { mode: "searxng", endpoint: "http://127.0.0.1:8888" }, actor }) },
  { method: "setMentionsEnabled", via: "agent mentions", write: ({ settings }) => settings.setMentionsEnabled({ enabled: false, actor }) },
  { method: "setMentionMaxHops", via: "the mention chain", write: ({ settings }) => settings.setMentionMaxHops({ maxHops: 8, actor }) },
  { method: "setDailyCostCap", via: "the spend cap", write: ({ settings }) => settings.setDailyCostCap({ usd: 12.5, actor }) },
  {
    method: "setMissionSettings",
    via: "every [missions] key",
    write: ({ settings }) => settings.setMissionSettings({ patch: { perAgent: 2, maxRunning: 3, limitHours: 1.5, limitTurns: 80, limitTokens: 2_000_000 }, agents: [undefined, undefined], actor }),
  },
  {
    method: "setModelTiers",
    via: "the model tiers, and a tier for every helper",
    write: ({ settings }) =>
      settings.setModelTiers({ patch: { smallModel: "m-small", highModel: "m-high", summaryModel: "small", passModel: "small", steerReplyModel: "small", imageModel: "high", learningModel: "small" }, actor }),
  },
  { method: "savePerson", via: "somebody new", write: ({ settings }) => settings.savePerson({ person: { name: "Kak Sam", ids: ["telegram:777"] }, create: true, actor }) },
  { method: "savePerson", via: "an edit to somebody", write: ({ settings }) => settings.savePerson({ person: { key: "gading", name: "Gading Nasution", notes: "Runs the homelab." }, actor }) },
  { method: "removePerson", via: "taking somebody out of People", write: ({ settings }) => settings.removePerson({ person: "gading", actor }) },
  { method: "writePersonMorning", via: "a morning line set (0.8.0)", write: ({ settings }) => settings.writePersonMorning("gading", { at: "07:00" }, actor) },
  { method: "linkIdentity", via: "a dashboard account linked to a person", write: ({ settings }) => settings.linkIdentity({ identity: "web:usr_1", target: { person: "gading" }, actor }) },
  { method: "unlinkIdentity", via: "an account unlinked", write: ({ settings }) => settings.unlinkIdentity({ identity: "telegram:814", actor }) },

  // ── the other writers of the same file ──
  {
    via: "setup: the first agent becomes the default",
    write: async (h) => {
      const registry = await AgentRegistry.create({ agentsDir: h.config.daemon.agentsDir, llmDefaults: h.config.llm.defaults, knownProviders: () => h.providers.names() });
      const setup = new SetupService({ config: h.config, configPath: h.configPath, dataDir: h.config.daemon.dataDir, agentsDir: h.config.daemon.agentsDir, secrets: h.secrets, providers: h.providers, registry, userCount: () => 1 });
      return await setup.createAgent({ id: "nouva", displayName: "Nouva", systemPrompt: "Brief.", model: "m-1", provider: "local", actor });
    },
  },
  {
    via: "setup: the wizard's provider",
    write: async (h) => {
      const setup = new SetupService({ config: h.config, configPath: h.configPath, dataDir: h.config.daemon.dataDir, agentsDir: h.config.daemon.agentsDir, secrets: h.secrets, providers: h.providers, registry: {} as AgentRegistry, userCount: () => 1 });
      return await setup.saveProvider({ kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "a-wizard-key", skipProbe: true, actor });
    },
  },
  {
    via: "the agents page: the default agent",
    write: (h) => setOrchestrator({ registry: { get: () => ({ config: {} }) } as unknown as AgentRegistry, config: h.config, configPath: h.configPath }, { agentId: "nox", actor }),
  },
  {
    via: "an agent's person_notes",
    write: (h) => updatePersonNotes({ config: h.config, configPath: h.configPath }, { key: "gading", edit: (notes) => ({ ok: true, notes: `${notes}\nPrefers mornings.` }), actor }),
  },
  {
    via: "boot: people written without a key given one",
    start: `${START}${KEYLESS}`,
    // Their key is the one the loader already made: the file changes, what it means does not.
    changes: false,
    write: async (h) => ({ ok: (await keyEveryone({ config: h.config, configPath: h.configPath })) === 1 }),
  },
];

/**
 * The settings service's methods that write nothing of the daemon's `config.toml`, and where what they do write goes.
 * Every other method is a row above.
 */
const ELSEWHERE: Partial<Record<keyof SettingsService, string>> = {
  hasSecret: "reads",
  secretInventory: "reads",
  secretShadowedByEnv: "reads",
  groupContextDefault: "reads",
  gateways: "reads",
  providerProfiles: "reads",
  memorySettings: "reads",
  retentionWindows: "reads",
  webSearchSettings: "reads",
  missionSettings: "reads",
  setSecret: "the secret store",
  changeSecretFields: "the secret store: what is said about a secret, its value untouched",
  secretLock: "reads",
  deleteSecret: "the secret store, and every pack whose exec_secrets name it",
  saveAgentModel: "an agent's pack",
  saveAgentFallbacks: "an agent's pack",
  saveAgentTiers: "an agent's pack",
  modelTiers: "reads",
  saveAgentToolIterations: "an agent's pack",
  saveAgentTurnSeconds: "an agent's pack",
  saveAgentJobQuietMinutes: "an agent's pack",
  saveAgentMaxBackground: "an agent's pack",
  saveAgentMissionsPerAgent: "an agent's pack",
  setAgentApprovals: "an agent's pack",
  setAgentSharedTools: "an agent's pack",
  setAgentModelGuard: "an agent's pack",
  setAgentEnabled: "an agent's pack",
  saveAgentSkills: "an agent's pack",
  saveLibraryServer: "the MCP library (agents/mcp.toml), and the packs it is switched on in",
  removeLibraryServer: "the MCP library, and every pack that named it",
  setAgentMcp: "an agent's mcp.toml",
};

describe("every writer of the daemon's config.toml", () => {
  test("is walked here, or named as writing somewhere else", () => {
    const methods = Object.getOwnPropertyNames(SettingsService.prototype).filter((name) => name !== "constructor");
    const walked = new Set(ROWS.flatMap((row) => (row.method ? [row.method as string] : [])));
    const unaccounted = methods.filter((name) => !walked.has(name) && !(name in ELSEWHERE));
    expect(unaccounted).toEqual([]);
    // And nothing listed that is not a method any more, or listed twice over.
    expect([...walked, ...Object.keys(ELSEWHERE)].filter((name) => !methods.includes(name))).toEqual([]);
    expect([...walked].filter((name) => name in ELSEWHERE)).toEqual([]);
  });

  for (const row of ROWS) {
    test(`${row.method ? `${row.method}: ` : ""}${row.via} — the running config is what the next boot loads`, async () => {
      const h = await install(row.start);
      const result = await row.write(h);
      expect(result.ok).toBe(true);

      const next = await h.fresh();
      // A row that changed nothing would pass whatever the running copy did.
      if (row.changes !== false) expect(next).not.toStrictEqual(h.initial);
      expect(h.config).toStrictEqual(next);
      // Changed where they are held, never replaced: the reflection engine, the exec tool, the scheduler, the
      // provider registry and the agent registry each keep the object they were handed at boot.
      const now = h.holding();
      for (const [name, object] of Object.entries(h.held)) expect({ name, same: now[name as keyof typeof now] === object }).toEqual({ name, same: true });
      expect(readFileSync(h.configPath, "utf8")).toStartWith("# Hand-written. Every save must leave this line where it is.");
    });
  }
});

describe("what a save puts in the running config", () => {
  test("is only what it changed: a hand edit to the file waits for the restart it always needed", async () => {
    const h = await install();
    // Edited on disk under the running daemon: a data directory the open database is not in, and a live setting.
    writeFileSync(h.configPath, readFileSync(h.configPath, "utf8").replace('name = "nouride"', 'name = "nouride"\ndata_dir = "./elsewhere"\n\n[agents]\nmentions_enabled = false'));
    expect((await h.settings.setDailyCostCap({ usd: 3, actor })).ok).toBe(true);

    expect(h.config.llm.limits.maxDailyCostUsd).toBe(3);
    expect(h.config.daemon.dataDir).toBe(h.initial.daemon.dataDir);
    expect(h.config.agents.mentionsEnabled).toBe(true);
    // The next boot reads all of it.
    const next = await h.fresh();
    expect(next.daemon.dataDir).toBe(join(h.dir, "elsewhere"));
    expect(next.agents.mentionsEnabled).toBe(false);
  });

  test("is all of the file when the file did not load before the save", async () => {
    const h = await install();
    // Out of range by hand: the next boot would refuse it, and the save that fixes it leaves nothing to tell its own
    // change from the rest.
    writeFileSync(h.configPath, `${readFileSync(h.configPath, "utf8")}\n[llm.limits]\nmax_tool_iterations = 0\n\n[agents]\nmention_max_hops = 7\n`);
    expect((await h.settings.setToolIterations({ iterations: 40, actor })).ok).toBe(true);
    expect(h.config).toStrictEqual(await h.fresh());
    expect(h.config.agents.mentionMaxHops).toBe(7);
  });

  test("is nothing, from the dashboard's whole-file editor: a whole file is the next boot's", async () => {
    const h = await install();
    const files = new FileService({ agentsDir: h.config.daemon.agentsDir, configPath: h.configPath, registry: {} as AgentRegistry, config: h.config });
    const text = readFileSync(h.configPath, "utf8");
    expect(await files.writeDaemonConfig(text.replace('name = "nouride"', 'name = "renamed"'), actor, text)).toMatchObject({ ok: true, restartRequired: true });
    expect(h.config).toStrictEqual(h.initial);
    expect((await h.fresh()).daemon.name).toBe("renamed");
  });

  test("a saved profile is the next call's: the client built from the old endpoint and key goes", async () => {
    const h = await install();
    const built = h.providers.get("local");
    await h.settings.saveProvider({ name: "local", kind: "openai", baseUrl: "http://127.0.0.1:11435/v1", apiKey: "a-new-key", actor });
    expect(h.providers.get("local")).not.toBe(built);
    expect(h.providers.endpointFor("local")).toEqual({ kind: "openai", baseUrl: "http://127.0.0.1:11435/v1", apiKey: "a-new-key", headers: { "x-team": "ops" } });
  });

  test("a removed profile is not answered from the client built for it", async () => {
    const h = await install();
    h.providers.get("local");
    await h.settings.removeProvider("local", actor, () => []);
    expect(() => h.providers.get("local")).toThrow(/not defined/);
  });

  test("names a WhatsApp session under ~ where the loader does", async () => {
    // Two of the drifts the hand-written mirror had, said plainly rather than only through the walk.
    const h = await install();
    await h.settings.saveGateway({ platform: "whatsapp", name: "home", enabled: true, sessionDir: "~/wa-session", actor });
    const home = h.config.gateways.find((gateway) => gateway.id === "whatsapp:home");
    expect(home?.sessionDir).toBe(join(homedir(), "wa-session"));
  });
});

/** The schema's path for each value that differs between two configs — an open section's (`gateways`) for anything in one. */
function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  const open = ["gateways", "providers", "people"].find((section) => prefix === section || prefix.startsWith(`${section}.`));
  if (open) return JSON.stringify(before) === JSON.stringify(after) ? [] : [open];
  const table = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!table(before) || !table(after)) return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  return [...keys].flatMap((key) =>
    changedPaths((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], prefix ? `${prefix}.${snakeCase(key)}` : snakeCase(key)),
  );
}

describe("each key's `live` flag (config-restart-ux)", () => {
  /** Every walked write: what it changed, and what it answered — `restartRequired` where its writer says it. */
  const outcomes: { via: string; paths: string[]; restartRequired: boolean | undefined }[] = [];

  /** The rest of `[memory]` and `[skills.learning]`, which the walk above reaches only a key or two of. */
  const SEMANTIC_ON = `${START}\n[memory.semantic]\nenabled = true\nprovider = "local"\nmodel = "bge-m3"\n`;
  const MORE: Row[] = [
    { via: "the rest of [memory]", write: ({ settings }) => settings.setMemorySettings({ patch: { pass: true, passAt: "02:30", passPerNight: 7, passMaxTokens: 400_000, passProvider: "local", passModel: "m-small", maxAttempts: 5, facts: "ask", proposeShared: true, archive: false }, actor }) },
    { via: "[memory.semantic] switched off", start: SEMANTIC_ON, write: ({ settings }) => settings.setMemorySettings({ patch: { semantic: { enabled: false, provider: "", dimensions: 256 } }, actor }) },
    { via: "the rest of [skills.learning]", write: ({ settings }) => settings.setSkillLearning({ patch: { model: "m-reflect", notifyChat: false }, actor }) },
  ];

  beforeAll(async () => {
    for (const row of [...ROWS, ...MORE]) {
      const h = await install(row.start);
      const result = (await row.write(h)) as { ok: boolean; restartRequired?: boolean };
      outcomes.push({ via: row.via, paths: [...new Set(changedPaths(h.initial, await h.fresh()))], restartRequired: result.restartRequired });
    }
  }, 60_000);

  test("is what the setter that wrote the key answered: live when no restart is required, and not when one is", () => {
    // The fail-open shape: rows that changed nothing or said nothing would pass whatever the flags said.
    expect(outcomes.filter((outcome) => outcome.restartRequired !== undefined && outcome.paths.length > 0).length).toBeGreaterThan(25);
    const wrong = outcomes.flatMap(({ via, paths, restartRequired }) =>
      // The one save that can go either way: a connection the daemon could take down itself is gone at once, which says
      // nothing about saving one — a socket opened at boot, so `gateways` is not live. Its answer is held in
      // settings-service.test.ts.
      restartRequired === undefined || via === "removing a connection" ? [] : paths.filter((path) => findField(path)?.live !== !restartRequired).map((path) => `${via}: ${path} is live=${findField(path)?.live} but the save answered restartRequired=${restartRequired}`),
    );
    expect(wrong).toEqual([]);
  });

  test("is only on a key some save applies at once — a key nothing applies waits for a restart, whatever it is", () => {
    const applied = new Set(outcomes.filter((outcome) => outcome.restartRequired !== true).flatMap((outcome) => outcome.paths));
    const claimed = describeConfig().filter((field) => field.live).map((field) => field.path);
    expect(claimed.length).toBeGreaterThan(30);
    expect(claimed.filter((path) => !applied.has(path))).toEqual([]);
  });

  test("is on every key, true or false, and in the JSON schema as x-live", () => {
    expect(describeConfig().filter((field) => typeof field.live !== "boolean").map((field) => field.path)).toEqual([]);
    const web = configJsonSchema("security.web").properties as Record<string, Record<string, unknown>>;
    expect(web.search_kind?.["x-live"]).toBe(false);
    expect((configJsonSchema("security.access").properties as Record<string, Record<string, unknown>>).mode?.["x-live"]).toBe(true);
  });
});

describe("the defaults every config is copied from", () => {
  test("cannot be changed in place by a save into a config that shares them", () => {
    expect(() => {
      (DEFAULT_CONFIG.memory.semantic as { model: string }).model = "leaked";
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.memory.semantic.model).not.toBe("leaked");
  });
});
