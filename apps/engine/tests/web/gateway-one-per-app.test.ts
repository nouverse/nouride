/**
 * An agent has one connection on each chat app, through `POST /gateways`: what `nouride gateway add` and `set` send,
 * and the dashboard's Connections page too.
 *
 * The page offered an agent only the apps it had none on, and the command line made a second bot or number on one all
 * the same. It is refused there too, and an install that already has two is left as it is. Held with the real settings
 * writer on a real `config.toml`: a refusal writes nothing and stores no key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { registerGatewayRoutes } from "@/modules/web/control/routes/gateways.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let secrets: SecretStore;
let control: Hono<{ Variables: { principal: unknown } }>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-one-per-app-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, `[daemon]\nname = "nouride"\ndata_dir = "${dir}"\n`);
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  secrets = await SecretStore.open(dir, {});
  const settings = new SettingsService({ config, configPath, secrets, providers: new ProviderRegistry(config.providers, secrets), gatewayStatus: () => new Map() });
  control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "admin", role: "admin", user: { id: "usr_admin", username: "admin" } });
    await next();
  });
  registerGatewayRoutes(control as never, { ctx: { config, gateways: new Map() }, settings } as never);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const post = async (body: Record<string, unknown>) => {
  const res = await control.request("/gateways", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, ...body }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const SAVED = { status: 200, body: { ok: true, restartRequired: true } };
const refusedFor = (agent: string, held: string) => ({
  status: 400,
  body: {
    error: `${agent} already has ${held}, and an agent has one connection on each chat app: change that one, or remove it first`,
    plain: "Nothing was saved. Check the chat app, and try again.",
  },
});
const BOT = "5550003333:AAH-a-live-looking-second-bot-token";

describe("a second connection on one chat app for one agent", () => {
  test("is refused on WhatsApp and on Telegram, naming the one it has: the file is as it was, and the bot's key is not kept", async () => {
    expect(await post({ platform: "whatsapp", name: "shop", agent: "nora" })).toEqual(SAVED);
    expect(await post({ platform: "telegram", name: "nora", agent: "nora", token: "5550001111:AAH-the-first-bot" })).toEqual(SAVED);
    const before = readFileSync(configPath, "utf8");

    expect(await post({ platform: "whatsapp", name: "shop2", agent: "nora" })).toEqual(refusedFor("nora", "whatsapp:shop"));
    expect(await post({ platform: "telegram", name: "nora2", agent: "nora", token: BOT })).toEqual(refusedFor("nora", "telegram:nora"));

    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(config.gateways.map((gateway) => gateway.id)).toEqual(["whatsapp:shop", "telegram:nora"]);
    expect(await secrets.resolve("telegram-nora2")).toBeUndefined();
    expect(await secrets.resolve("whatsapp-shop2-key")).toBeUndefined();
  });

  test("one switched off still holds its app", async () => {
    expect(await post({ platform: "whatsapp", name: "shop", agent: "nora", enabled: false })).toEqual(SAVED);
    expect(await post({ platform: "whatsapp", name: "shop2", agent: "nora" })).toEqual(refusedFor("nora", "whatsapp:shop"));
  });

  test("another agent's connection takes nothing from this one, and the agent's other apps are still its to add", async () => {
    expect(await post({ platform: "whatsapp", name: "main", agent: "nouva" })).toEqual(SAVED);
    expect(await post({ platform: "whatsapp", name: "shop", agent: "nora" })).toEqual(SAVED);
    expect(await post({ platform: "telegram", name: "nora", agent: "nora", token: BOT })).toEqual(SAVED);
    expect(await post({ platform: "discord", name: "nora", agent: "nora", token: "a-discord-bot-token" })).toEqual(SAVED);
    // A connection that is nobody's is no agent's second.
    expect(await post({ platform: "telegram", name: "spare", token: "5550004444:AAH-nobody's-bot" })).toEqual(SAVED);
    // Sorted: the list is in the file's order, each app's connections together.
    expect(config.gateways.map((gateway) => `${gateway.id} ${gateway.agent ?? "nobody"}`).sort()).toEqual([
      "discord:nora nora",
      "telegram:nora nora",
      "telegram:spare nobody",
      "whatsapp:main nouva",
      "whatsapp:shop nora",
    ]);
  });

  test("a connection given to an agent that has one on its app is refused; to one that has none, it goes", async () => {
    expect(await post({ platform: "whatsapp", name: "main", agent: "nouva" })).toEqual(SAVED);
    expect(await post({ platform: "whatsapp", name: "shop", agent: "nora" })).toEqual(SAVED);

    expect(await post({ platform: "whatsapp", name: "shop", agent: "nouva" })).toEqual(refusedFor("nouva", "whatsapp:main"));
    expect(config.gateways.find((gateway) => gateway.id === "whatsapp:shop")?.agent).toBe("nora");

    expect(await post({ platform: "whatsapp", name: "shop", agent: "nox" })).toEqual(SAVED);
    expect(config.gateways.find((gateway) => gateway.id === "whatsapp:shop")?.agent).toBe("nox");
    // Its own save, the agent said again, is no second connection.
    expect(await post({ platform: "whatsapp", name: "shop", agent: "nox", enabled: false })).toEqual(SAVED);
  });

  test("two sent at once for one agent on one app: one is saved and the other refused", async () => {
    // Both arrive before either is written: each read the list as it was, and both were saved, before the check took
    // the file's lock.
    const answers = await Promise.all([
      post({ platform: "whatsapp", name: "one", agent: "nora" }),
      post({ platform: "whatsapp", name: "two", agent: "nora" }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
    const file = readFileSync(configPath, "utf8");
    expect((file.match(/agent = "nora"/g) ?? []).length).toBe(1);
  });

  test("a connection written into the file since the start counts, though the running copy has not followed it", async () => {
    // The dashboard's whole-file editor saves for the next boot, and the running copy does not follow it.
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n[gateways.whatsapp.shop]\nenabled = true\nencryption_key = "whatsapp-shop-key"\nagent = "nora"\n`);
    expect(config.gateways).toEqual([]);
    expect(await post({ platform: "whatsapp", name: "shop2", agent: "nora" })).toEqual(refusedFor("nora", "whatsapp:shop"));
  });

  test("two written into the file by hand are left as they are: each is still saved", async () => {
    expect(await post({ platform: "whatsapp", name: "main", agent: "nora" })).toEqual(SAVED);
    // The second as a person writes it into the file, and as the next load reads it.
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n[gateways.whatsapp.second]\nenabled = true\nencryption_key = "whatsapp-second-key"\nagent = "nora"\n`);
    config.gateways.push({ id: "whatsapp:second", platform: "whatsapp", name: "second", enabled: true, tokenSecret: "whatsapp-second", encryptionKeySecret: "whatsapp-second-key", agent: "nora", sessionDir: join(dir, "whatsapp-second") });

    expect(await post({ platform: "whatsapp", name: "second", enabled: false })).toEqual(SAVED);
    expect(await post({ platform: "whatsapp", name: "main", agent: "nora", enabled: false })).toEqual(SAVED);
    const file = readFileSync(configPath, "utf8");
    expect(file).toContain('[gateways.whatsapp.second]\nenabled = false\nencryption_key = "whatsapp-second-key"\nagent = "nora"');
    expect(file).toContain('[gateways.whatsapp.main]\nenabled = false\nencryption_key = "whatsapp-main-key"\nagent = "nora"');
  });
});
