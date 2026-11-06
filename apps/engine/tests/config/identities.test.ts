/**
 * Who an identity is: a dashboard account linked to a person, a sender approved as somebody — and the
 * first admin to say who they are becoming the owner, since nobody else can know.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { freeKey, refusePersonKey } from "@/modules/people/entry.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { findPerson } from "@/modules/people/match.ts";
import { registerAccessRoutes } from "@/modules/web/control/routes/access.ts";
import { registerPeopleRoutes } from "@/modules/web/control/routes/people.ts";
import { registerUserRoutes } from "@/modules/web/control/routes/users.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
let settings: SettingsService;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-identities-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, "[daemon]\nname = \"nouride\"\n");
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  config.people = [];
  const secrets = await SecretStore.open(dir, {});
  settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    gatewayStatus: () => new Map(),
    retireGateway: async () => ({ stopped: true, loggedOut: true }),
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("linking an identity", () => {
  test("a new person by name, with a key; a second of the same name gets one of their own", async () => {
    const first = await settings.linkIdentity({ identity: "web:usr_1", target: { name: "Gading" } });
    expect(first).toMatchObject({ ok: true, person: { key: "gading", ids: ["web:usr_1"], name: "Gading" } });
    expect(readFileSync(configPath, "utf8")).toContain('key = "gading"');
    expect(readFileSync(configPath, "utf8")).not.toContain("owners");

    const second = await settings.linkIdentity({ identity: "web:usr_2", target: { name: "Gading" } });
    expect(second).toMatchObject({ ok: true, person: { key: "gading-2" } });
  });

  test("a sender added to somebody known, so they are one person on every platform", async () => {
    await settings.linkIdentity({ identity: "web:usr_1", target: { name: "Gading" } });
    const linked = await settings.linkIdentity({ identity: "telegram:814", target: { person: "gading" } });
    expect(linked.ok).toBe(true);
    expect(findPerson(config.people, { gatewayId: "telegram:nero", senderId: "814" })?.name).toBe("Gading");
    expect(findPerson(config.people, { gatewayId: "web:dashboard", senderId: "usr_1" })?.name).toBe("Gading");
    expect(config.people).toHaveLength(1);
  });

  test("one identity, one person: linking it elsewhere moves it — even the last one somebody has", async () => {
    await settings.linkIdentity({ identity: "web:usr_1", target: { name: "Gading" } });
    await settings.linkIdentity({ identity: "telegram:814", target: { person: "gading" } });
    await settings.linkIdentity({ identity: "web:usr_9", target: { name: "Sam" } });

    expect((await settings.linkIdentity({ identity: "telegram:814", target: { person: "sam" } })).ok).toBe(true);
    expect(findPerson(config.people, { gatewayId: "telegram:nero", senderId: "814" })?.name).toBe("Sam");
    expect(findPerson(config.people, { gatewayId: "web:dashboard", senderId: "usr_1" })?.name).toBe("Gading");

    // Until 0.7.0 taking Ibu's one account was refused: a person was their first account, and one with
    // none could not be written. She is her key now, and keeps her name, notes and memory without one —
    // which is also what somebody added by name looks like until they pair.
    await settings.linkIdentity({ identity: "web:usr_7", target: { name: "Ibu" } });
    const moved = await settings.linkIdentity({ identity: "web:usr_7", target: { person: "gading" } });
    expect(moved).toMatchObject({ ok: true });
    expect(findPerson(config.people, { gatewayId: "web:dashboard", senderId: "usr_7" })?.name).toBe("Gading");
    expect(config.people.find((person) => person.key === "ibu")).toEqual({ key: "ibu", name: "Ibu" });
  });

  test("a dashboard account deleted is no longer one of the accounts of the person it was linked to", async () => {
    await settings.linkIdentity({ identity: "web:usr_7", target: { name: "Gading" } });
    await settings.savePerson({ person: { key: "gading", name: "Gading", ids: ["web:usr_7", "telegram:814"] } });
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "admin", role: "admin", user: { id: "usr_1", username: "admin" } });
      await next();
    });
    registerUserRoutes(control as never, { users: { delete: () => ({ ok: true }) }, settings } as never);
    expect((await control.request("/users/usr_7", { method: "DELETE" })).status).toBe(200);
    expect(config.people.find((person) => person.key === "gading")?.ids).toEqual(["telegram:814"]);
    expect(readFileSync(configPath, "utf8")).not.toContain("web:usr_7");
  });

  test("keys from names", () => {
    expect(freeKey([], "Kak Sam")).toBe("sam");
    expect(freeKey([{ key: "sam" }], "Sam")).toBe("sam-2");
    expect(freeKey([], "  ")).toBe("person");
    // `shared` is `shared.md`'s, so a person called Shared is not given it.
    expect(freeKey([], "Shared")).toBe("shared-2");
    // Words joined by "-", nothing else: no "_", no accents, no punctuation — it becomes a file name.
    expect(freeKey([], "Sam_Wijaya")).toBe("sam-wijaya");
    expect(freeKey([], "Kak Rénata O'Brien")).toBe("renata-o-brien");
    expect(freeKey([], "a".repeat(40))).toHaveLength(32);
  });

  test("a key someone removed from People left memory under is stepped around, and refused when named", () => {
    // A new Sam inherited the removed Sam's profile, conversations and MCP tokens under `sam`.
    const held = (key: string) => (key === "sam" ? "memory keeps a profile, people/sam.md" : null);
    expect(freeKey([], "Sam", held)).toBe("sam-2");
    expect(refusePersonKey("sam", [], held)).toContain('person key "sam" still belongs to someone removed from People: memory keeps a profile, people/sam.md');
    expect(refusePersonKey("sam", [])).toBeNull();
  });

  test("a person added by name, with no account, is attached to one when they are approved", async () => {
    await settings.savePerson({ person: { name: "Kak Sam" }, create: true });
    const linked = await settings.linkIdentity({ identity: "telegram:777", target: { person: "sam" } });
    expect(linked).toMatchObject({ ok: true, person: { key: "sam", ids: ["telegram:777"] } });
    expect(findPerson(config.people, { gatewayId: "telegram:nero", senderId: "777" })?.name).toBe("Kak Sam");
    expect(config.people).toHaveLength(1);
  });
});

describe("the routes", () => {
  function app(role: "operator" | "admin", userId = "usr_1") {
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "gading", role, user: { id: userId, role } });
      await next();
    });
    const pending = { gatewayId: "telegram:nero", senderId: "814", senderName: "Gading N", chatId: "814", status: "approved" };
    const deps = {
      settings,
      ctx: { config },
      users: { byId: (id: string) => (id === "usr_2" ? { id } : null) },
      access: { approveByCode: (code: string) => (code === "ABC" ? pending : null) },
      registry: { active: () => [] },
    } as never;
    registerPeopleRoutes(hono as never, deps);
    registerAccessRoutes(hono as never, deps);
    return hono;
  }
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("saying who you are is an admin's", async () => {
    expect((await app("operator").request("/people/me", post({ name: "Gading" }))).status).toBe(403);
    const me = await app("admin").request("/people/me", post({ name: "Gading" }));
    expect(await me.json()).toEqual({ person: expect.objectContaining({ key: "gading" }) });
    expect(await (await app("admin").request("/people/me")).json()).toEqual({ person: expect.objectContaining({ name: "Gading" }) });
  });

  test("approving is an admin's; 'it's me' links the sender to the approver, and needs them linked first", async () => {
    expect((await app("operator").request("/access/approve?code=ABC", { method: "POST" })).status).toBe(403);
    expect((await app("admin").request("/access/approve?code=ABC&as=me", { method: "POST" })).status).toBe(400);

    await app("admin").request("/people/me", post({ name: "Gading" }));
    const approved = await app("admin").request("/access/approve?code=ABC&as=me", { method: "POST" });
    expect(await approved.json()).toMatchObject({ ok: true, person: { name: "Gading" } });
    expect(findPerson(config.people, { gatewayId: "telegram:nouva", senderId: "814" })?.name).toBe("Gading");
  });

  test("revoking or denying somebody drops their 'stop asking me' with their access", async () => {
    // Left behind, it would come back the moment they were paired again — a decision nobody made twice.
    const forgotten: string[] = [];
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "gading", role: "admin", user: { id: "usr_1", role: "admin" } });
      await next();
    });
    registerAccessRoutes(hono as never, {
      access: { revoke: () => true, resolve: () => ({}) },
      autoApprove: { forget: (gatewayId: string, senderId: string) => forgotten.push(`${gatewayId} ${senderId}`) },
    } as never);

    expect((await hono.request("/access/revoke?gateway=telegram:nero&sender=814", { method: "POST" })).status).toBe(200);
    expect((await hono.request("/access/deny?gateway=telegram:nero&sender=815", { method: "POST" })).status).toBe(200);
    expect(forgotten).toEqual(["telegram:nero 814", "telegram:nero 815"]);
  });

  test("approving as somebody new, and a bad 'as'", async () => {
    const approved = await app("admin").request("/access/approve?code=ABC&as=new&name=Kak%20Sam", { method: "POST" });
    expect(await approved.json()).toMatchObject({ person: { name: "Kak Sam", key: "sam" } });
    expect((await app("admin").request("/access/approve?code=ABC&as=who", { method: "POST" })).status).toBe(400);
  });

  test("linking another account is an admin's", async () => {
    expect((await app("operator").request("/people/link", post({ user: "usr_2", name: "Sam" }))).status).toBe(403);
    const linked = await app("admin").request("/people/link", post({ user: "usr_2", name: "Sam" }));
    expect(linked.status).toBe(200);
    expect((await app("admin").request("/people/link", post({ user: "nobody", name: "X" }))).status).toBe(400);
  });
});
