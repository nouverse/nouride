/**
 * The Web Search page's settings: four choices written as the `[security.web]` keys that mean them,
 * a typed key that reaches the secret store and never the file, and the routes in front of both.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { openDatabase } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const KEY = "BSA-live-looking-brave-key-0123456789abcdef";
const TOKEN = "control-token-for-tests-0000000000";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let secrets: SecretStore;
let settings: SettingsService;
let app: Hono;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "web-search-settings-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, "# keep this comment\n\n[security.web]\n# and this one\nallow_private_urls = false\n");
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    gatewayStatus: () => new Map(),
  });

  const db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    secrets,
    settings,
    registry: { get: () => undefined, reload: async () => {} },
  } as unknown as ControlDeps);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => readFileSync(configPath, "utf8");
const call = (path: string, body?: unknown) =>
  app.request(
    `/api/control${path}`,
    body === undefined
      ? { headers: { "x-nouride-token": TOKEN } }
      : { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) },
    { clientAddress: "203.0.113.10" },
  );

describe("reading", () => {
  test("the stock config — a key name nobody set — reads as the free sources", () => {
    expect(settings.webSearchSettings()).toMatchObject({
      mode: "free",
      apiKeySecret: "brave_search_api_key",
      apiKeyOrigin: "missing",
      effective: "free",
    });
  });

  test("and as Brave once that name holds a key", async () => {
    await secrets.set("brave_search_api_key", KEY);
    expect(settings.webSearchSettings()).toMatchObject({ mode: "brave", apiKeyOrigin: "store", effective: "brave" });
  });
});

describe("saving", () => {
  test("a typed Brave key goes to the store; the file gets its name and keeps its comments", async () => {
    const result = await settings.setWebSearchSettings({ patch: { mode: "brave", apiKeyValue: KEY } });

    expect(result).toEqual({ ok: true, restartRequired: true });
    expect(secrets.resolve("brave_search_api_key")).toBe(KEY);
    expect(file()).not.toContain(KEY);
    expect(file()).toContain('search_api_key = "brave_search_api_key"');
    expect(file()).toContain("# keep this comment");
    expect(file()).toContain("# and this one");
    expect(config.security.web.searchApiKey).toBe("brave_search_api_key");
    expect(settings.webSearchSettings()).toMatchObject({ mode: "brave", effective: "brave" });
  });

  test("a key typed under another name is stored under that name", async () => {
    await settings.setWebSearchSettings({ patch: { mode: "brave", apiKeySecret: "brave_team", apiKeyValue: KEY } });
    expect(secrets.resolve("brave_team")).toBe(KEY);
    expect(file()).toContain('search_api_key = "brave_team"');
  });

  test("an existing secret can be picked instead of typing", async () => {
    await secrets.set("search_key", KEY);
    expect((await settings.setWebSearchSettings({ patch: { mode: "brave", apiKeySecret: "search_key" } })).ok).toBe(true);
    expect(file()).toContain('search_api_key = "search_key"');
  });

  test("SearXNG: kind and endpoint, no key", async () => {
    await settings.setWebSearchSettings({ patch: { mode: "searxng", endpoint: "http://searxng:8080/search", allowPrivateUrls: true } });
    expect(file()).toContain('search_kind = "searxng"');
    expect(file()).toContain('search_endpoint = "http://searxng:8080/search"');
    expect(file()).toContain('search_api_key = ""');
    expect(file()).toContain("allow_private_urls = true");
    expect(settings.webSearchSettings()).toMatchObject({ mode: "searxng", effective: "searxng" });
  });

  test("a custom endpoint is a Brave-compatible proxy, with or without a key", async () => {
    await settings.setWebSearchSettings({ patch: { mode: "custom", endpoint: "https://search.example/res/v1/web/search" } });
    expect(settings.webSearchSettings()).toMatchObject({ mode: "custom", effective: "brave", endpoint: "https://search.example/res/v1/web/search" });
  });

  test("free clears the endpoint and the key name, so a key in the environment does not quietly win", async () => {
    await settings.setWebSearchSettings({ patch: { mode: "searxng", endpoint: "http://searxng:8080/search" } });
    await settings.setWebSearchSettings({ patch: { mode: "free" } });
    expect(file()).toContain('search_kind = "brave"');
    expect(file()).toContain('search_endpoint = ""');
    expect(file()).toContain('search_api_key = ""');
    expect(settings.webSearchSettings().effective).toBe("free");
  });

  test("refuses what would not work, saying why, and writes nothing", async () => {
    const before = file();
    const refusals = await Promise.all([
      settings.setWebSearchSettings({ patch: { mode: "brave" } }),
      settings.setWebSearchSettings({ patch: { mode: "brave", apiKeySecret: "nobody_set_this" } }),
      settings.setWebSearchSettings({ patch: { mode: "searxng" } }),
      settings.setWebSearchSettings({ patch: { mode: "custom", endpoint: "not a url" } }),
      settings.setWebSearchSettings({ patch: { mode: "custom", endpoint: "ftp://x.example/" } }),
      // The key pasted into the name field.
      settings.setWebSearchSettings({ patch: { mode: "brave", apiKeySecret: "sk-live-0123456789abcdef0123456789abcdef", apiKeyValue: KEY } }),
    ]);
    expect(refusals.map((r) => (r.ok ? "ok" : r.error))).toEqual([
      expect.stringContaining("needs an API key"),
      expect.stringContaining('"nobody_set_this" is not set'),
      expect.stringContaining("address of your instance"),
      expect.stringContaining("is not a URL"),
      expect.stringContaining("http:// or https://"),
      expect.stringContaining("looks like a credential"),
    ]);
    // And the field each is about, which the page names (0.8.23).
    expect(refusals.map((r) => (r.ok ? "ok" : r.field))).toEqual(["key", "secret", "endpoint", "endpoint", "endpoint", "secret"]);
    expect(await settings.setWebSearchSettings({ patch: { mode: "gopher" as never } })).toMatchObject({ ok: false, field: "mode" });
    expect(file()).toBe(before);
  });
});

describe("the routes", () => {
  test("GET shows the settings, and that a save is waiting for a restart", async () => {
    expect(await (await call("/web-search")).json()).toMatchObject({ mode: "free", restartPending: false, editable: true });
    const saved = await (await call("/web-search", { mode: "brave", apiKeyValue: KEY })).json();
    expect(saved).toMatchObject({ ok: true, restartRequired: true, settings: { mode: "brave" } });
    expect(await (await call("/web-search")).json()).toMatchObject({ mode: "brave", restartPending: true });
  });

  test("the key never comes back in an answer", async () => {
    await call("/web-search", { mode: "brave", apiKeyValue: KEY });
    expect(JSON.stringify(await (await call("/web-search")).json())).not.toContain(KEY);
  });

  test("a save refused says which field on the page, and the server's own reason for the CLI", async () => {
    const refused = await call("/web-search", { mode: "searxng" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "SearXNG needs the address of your instance", plain: "Nothing was saved. Check the address, and try again." });
  });

  test("bad bodies are refused before the service sees them", async () => {
    expect((await call("/web-search", { mode: "brave", apiKeyValue: 42 })).status).toBe(400);
    expect((await call("/web-search", {})).status).toBe(400);
    expect((await call("/web-search", { mode: "gopher" })).status).toBe(400);
  });

  test("a test without what it needs says so instead of searching", async () => {
    expect(await (await call("/web-search/test", { mode: "searxng" })).json()).toMatchObject({ ok: false, error: "enter the endpoint first" });
    expect(await (await call("/web-search/test", { mode: "brave" })).json()).toMatchObject({ ok: false, error: expect.stringContaining("no API key") });
  });
});
