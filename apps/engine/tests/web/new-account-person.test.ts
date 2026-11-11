/**
 * A new account is someone in People: the person an admin names, or a new one named after the account — and each
 * account from before gets one of its own when the daemon starts (`boot/account-people.ts`). Whose chats an account
 * reads is read through its person (`web/control/whose.ts`), so an account with none would read nothing it said from
 * another app.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { personForEachAccount } from "@/boot/account-people.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { registerUserRoutes } from "@/modules/web/control/routes/users.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let settings: SettingsService;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-account-people-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "nouride"\n');
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  config.people = [];
  const secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({ config, configPath, secrets, providers: new ProviderRegistry(config.providers, secrets), gatewayStatus: () => new Map(), retireGateway: async () => ({ stopped: true, loggedOut: true }) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The route, as an admin asks it, over an accounts store that makes what it is asked. */
function accounts() {
  const made: { id: string; username: string }[] = [];
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role: "admin", user: { id: "u1", username: "gading" } });
    await next();
  });
  registerUserRoutes(control as never, {
    ctx: { config },
    settings,
    users: {
      count: () => made.length + 1,
      create: async (input: { username: string }) => {
        const user = { id: `u${made.length + 2}`, username: input.username, displayName: "", role: "operator" };
        made.push(user);
        return user;
      },
    },
  } as never);
  const add = async (body: Record<string, unknown>) => {
    const response = await control.request("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "a-long-enough-one", role: "operator", ...body }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { add, made };
}

describe("a new account", () => {
  test("naming somebody not in People is refused before anything is made, in every build", async () => {
    const h = accounts();
    const refused = await h.add({ username: "tamu", person: "nobody" });
    expect(refused.status).toBe(400);
    expect(refused.body.plain).toBe("That person is not in People any more. Pick again.");
    expect(h.made).toEqual([]);
  });
});

describe("an account's person", () => {
  // What `POST /users` and the boot both ask, past the multi-user plugin's yes, which this suite has no build to give.
  test("is a new person, named after the account, when nobody is named", async () => {
    const linked = await settings.linkAccount({ account: { id: "u2", username: "budi", displayName: "" } });
    expect(linked).toMatchObject({ ok: true, person: { key: "budi", name: "budi", ids: ["web:u2"] } });
    expect(readFileSync(configPath, "utf8")).toContain('key = "budi"');
  });

  test("is named as the account names itself, where it does", async () => {
    const linked = await settings.linkAccount({ account: { id: "u2", username: "budi@example.com", displayName: "Budi" } });
    expect(linked).toMatchObject({ ok: true, person: { name: "Budi", ids: ["web:u2"] } });
  });

  test("is the person named, beside the accounts they had", async () => {
    await settings.savePerson({ person: { key: "rina", name: "Rina", ids: ["telegram:555"] }, create: true });
    const linked = await settings.linkAccount({ account: { id: "u2", username: "rina", displayName: "" }, person: "rina" });
    expect(linked).toMatchObject({ ok: true, person: { key: "rina", ids: ["telegram:555", "web:u2"] } });
  });
});

describe("the accounts from before", () => {
  test("each with no person gets one of its own, named as it is; one already someone's stays theirs", async () => {
    await settings.savePerson({ person: { key: "rina", name: "Rina", ids: ["telegram:555"] }, create: true });
    await settings.savePerson({ person: { key: "gading", name: "Gading", ids: ["web:u1"] }, create: true });
    const link = (params: Parameters<SettingsService["linkAccount"]>[0]) => settings.linkAccount(params);
    const made = await personForEachAccount({
      accounts: [
        { id: "u1", username: "gading", displayName: "" },
        { id: "u2", username: "rina@example.com", displayName: "Rina" },
        { id: "u3", username: "tamu", displayName: "" },
      ],
      people: () => config.people,
      link,
    });
    expect(made).toEqual(["rina@example.com", "tamu"]);
    // None is linked by its name: the account called Rina is a new person, not the Rina People already has.
    expect(config.people.map((person) => `${person.key} ${person.name} ${person.ids?.join(",")}`)).toEqual([
      "rina Rina telegram:555",
      "gading Gading web:u1",
      "rina-2 Rina web:u2",
      "tamu tamu web:u3",
    ]);
    expect(await personForEachAccount({ accounts: [{ id: "u3", username: "tamu", displayName: "" }], people: () => config.people, link })).toEqual([]);
  });
});
