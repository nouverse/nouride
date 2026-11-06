/**
 * `/people` over HTTP — what the People page and `nouride people` send.
 *
 * A person is their key since 0.7.0, and their accounts are optional: the page adds somebody by name
 * (the key made from it, or one the operator typed), and their account is attached when they pair. The
 * one rule the routes must not bend is that a key is one person's: a new person named with a key
 * somebody holds is refused — saving over them would hand a stranger their notes, accounts and memory.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseToml } from "@nouride/runtime";
import type { GlobalConfig, Person } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { removePerson, savePerson, writePersonMorning } from "@/modules/config/settings/people.ts";
import { registerPeopleRoutes } from "@/modules/web/control/routes/people.ts";

const root = mkdtempSync(join(tmpdir(), "nouride-people-routes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const configPath = join(root, "config.toml");
const people: Person[] = [];
/** Keys someone removed from People left memory under, as the daemon's `keyHeld` reports them. */
const held = new Set<string>();
const keyHeld = (key: string) => (held.has(key) ? `memory keeps a profile, people/${key}.md` : null);
const revoked: string[] = [];
const audited: string[] = [];
const config = { people, memory: DEFAULT_CONFIG.memory } as unknown as GlobalConfig;

const control = new Hono<{ Variables: { principal: unknown } }>();
control.use("*", async (c, next) => {
  c.set("principal", { kind: "user", actor: "admin", role: "admin", user: { username: "admin" } });
  await next();
});
registerPeopleRoutes(control as never, {
  ctx: { config },
  settings: {
    savePerson: (params: Parameters<typeof savePerson>[1]) => savePerson({ config, configPath, keyHeld }, params),
    removePerson: (params: Parameters<typeof removePerson>[1]) => removePerson({ config, configPath } as never, params),
    writePersonMorning: (key: string, line: { at: string | null; to?: string | null }, actor: string) => writePersonMorning({ config, configPath } as never, key, line, actor),
  },
  mcpTokens: { revokeFor: (person: string) => (revoked.push(person), person === "sam" ? ["tok_1", "tok_2"] : []) },
  audit: { record: (row: { action: string }) => void audited.push(row.action) },
} as never);

const post = async (body: unknown) => {
  const response = await control.request("/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as { error?: string; person?: Person } };
};
const file = () => parseToml<{ people?: Record<string, unknown>[] }>(readFileSync(configPath, "utf8")).people ?? [];

beforeEach(() => {
  people.length = 0;
  held.clear();
  revoked.length = 0;
  audited.length = 0;
  writeFileSync(configPath, '[daemon]\nname = "nouride"\n');
});

describe("adding somebody from the People page", () => {
  test("by name alone: a key made from it, no account, no notes", async () => {
    const added = await post({ name: "Kak Nadia", create: true });
    expect(added).toEqual({ status: 200, body: expect.objectContaining({ person: { key: "nadia", name: "Kak Nadia" } }) });
    expect(file()).toEqual([{ key: "nadia", name: "Kak Nadia" }]);
  });

  test("with a key the operator typed", async () => {
    expect((await post({ name: "Kak Nadia", key: "kak-nadia", create: true })).body.person?.key).toBe("kak-nadia");
  });

  test("never with a key somebody holds — the second is refused, the first untouched", async () => {
    await post({ name: "Nadia", key: "nadia", notes: "Alex's sister.", create: true });

    const second = await post({ name: "Nadia Wijaya", key: "nadia", create: true });

    expect(second.status).toBe(400);
    expect(second.body.error).toContain(`"nadia" is already Nadia's`);
    expect(file()).toEqual([{ key: "nadia", name: "Nadia", notes: "Alex's sister." }]);
  });

  test("never with a key that is not lowercase letters and digits joined by '-'", async () => {
    for (const key of ["Nadia", "nadia wijaya", "nadia_w", "nadia!", "../nadia", "shared"]) {
      const refused = await post({ name: "Nadia", key, create: true });
      expect(refused.status, key).toBe(400);
    }
    expect(file()).toEqual([]);
  });

  test("a key made from a name skips one somebody holds", async () => {
    await post({ name: "Nadia", create: true });
    expect((await post({ name: "Kak Nadia", create: true })).body.person?.key).toBe("nadia-2");
  });
});

describe("changing and removing somebody", () => {
  test("found by key: name changed, accounts attached later, notes kept", async () => {
    await post({ name: "Nadia", notes: "Alex's sister.", create: true });

    const changed = await post({ key: "nadia", name: "Kak Nadia", ids: ["whatsapp:628111000002@s.whatsapp.net"] });

    expect(changed.status).toBe(200);
    expect(file()).toEqual([{ key: "nadia", name: "Kak Nadia", ids: ["whatsapp:628111000002@s.whatsapp.net"], notes: "Alex's sister." }]);
  });

  test("an account named the way `nouride people set` does finds whoever holds it", async () => {
    await post({ key: "nadia", name: "Nadia", ids: ["telegram:777"], create: true });
    expect((await post({ id: "telegram:bot:777", name: "Kak Nadia" })).body.person).toMatchObject({ key: "nadia", name: "Kak Nadia" });
    expect(people).toHaveLength(1);
  });

  test("removed by key, or by an account they hold", async () => {
    await post({ key: "nadia", name: "Nadia", ids: ["telegram:777"], create: true });
    await post({ name: "Sam", create: true });

    expect((await control.request("/people?key=sam", { method: "DELETE" })).status).toBe(200);
    expect((await control.request("/people?id=telegram:777", { method: "DELETE" })).status).toBe(200);
    expect(file()).toEqual([]);
    expect((await control.request("/people?key=nobody", { method: "DELETE" })).status).toBe(400);
  });
});

describe("a key someone removed left memory under", () => {
  test("removing somebody revokes their MCP tokens, which answered again for whoever got the key next", async () => {
    await post({ name: "Sam", create: true });
    const response = await control.request("/people?key=sam", { method: "DELETE" });
    expect(((await response.json()) as { tokensRevoked: number }).tokensRevoked).toBe(2);
    expect(revoked).toEqual(["sam"]);
    expect(audited.filter((action) => action === "mcp_token_revoked")).toHaveLength(2);
  });

  test("is not given to somebody new by their name, and named, is refused unless re-attached on purpose", async () => {
    held.add("sam");
    expect((await post({ name: "Sam", create: true })).body.person?.key).toBe("sam-2");
    const named = await post({ name: "Sam", key: "sam", create: true });
    expect(named.status).toBe(400);
    expect(named.body.error).toContain("--reattach");
    expect((await post({ name: "Sam", key: "sam", create: true, reattach: true })).body.person?.key).toBe("sam");
  });
});

describe("a person's morning line (0.8.0)", () => {
  const morning = async (key: string, body: unknown) => {
    const response = await control.request(`/people/${key}/morning`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as { error?: string; at?: string | null; to?: string | null } };
  };

  test("a time of day into their entry, null for none; anything else is refused", async () => {
    await post({ name: "Mira", key: "mira", create: true });
    expect(await morning("mira", { at: "07:00" })).toEqual({ status: 200, body: { ok: true, at: "07:00", to: null } as never });
    expect(file()).toEqual([{ key: "mira", name: "Mira", morning: "07:00" }]);
    expect((await morning("mira", { at: 7 })).status).toBe(400);
    expect((await morning("mira", { at: "seven" })).status).toBe(400);
    expect(await morning("mira", { at: null })).toEqual({ status: 200, body: { ok: true, at: null, to: null } as never });
    expect(file()).toEqual([{ key: "mira", name: "Mira" }]);
  });

  test("where it goes: one of their chat accounts — not a dashboard one, nor somebody else's; off takes it with it", async () => {
    await post({ key: "nadia", name: "Nadia", ids: ["telegram:777", "discord:214", "web:usr_1"], create: true });
    expect(await morning("nadia", { at: "07:00", to: "discord:214" })).toEqual({ status: 200, body: { ok: true, at: "07:00", to: "discord:214" } as never });
    expect(file()[0]).toMatchObject({ morning: "07:00", morning_to: "discord:214" });
    // A new time keeps where it goes.
    expect(await morning("nadia", { at: "06:30" })).toEqual({ status: 200, body: { ok: true, at: "06:30", to: "discord:214" } as never });
    expect((await morning("nadia", { at: "07:00", to: "web:usr_1" })).body.error).toContain("not one of Nadia's chat accounts");
    expect((await morning("nadia", { at: "07:00", to: "telegram:999" })).status).toBe(400);
    expect((await morning("nadia", { at: "07:00", to: 5 })).status).toBe(400);
    expect(await morning("nadia", { at: "07:00", to: null })).toEqual({ status: 200, body: { ok: true, at: "07:00", to: null } as never });
    expect(file()[0]?.morning_to).toBeUndefined();
    await morning("nadia", { at: "07:00", to: "telegram:777" });
    await morning("nadia", { at: null });
    expect(file()[0]).not.toHaveProperty("morning_to");
  });
});
