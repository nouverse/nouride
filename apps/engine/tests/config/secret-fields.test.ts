/**
 * What is said about a secret over the control API (0.8.19): fields listed with its name, given with a value, changed
 * on their own with the value untouched, and refused when one has a key's shape. And the store's lock beside the list,
 * where its key is but never the key. Over a real store, encrypted, so what is asserted is what a daemon does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { changeSecretFields, secretInventory, secretLock, setSecret } from "@/modules/config/settings/secrets.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";
import { registerSecretRoutes } from "@/modules/web/control/routes/secrets.ts";

const KEY = "q3m4XK8pX0n0m2gYk1y1Yd8rS2c0Hc3o0W0J8n5s7Vw=";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secret-fields-"));
});
afterEach(() => removePath(dir));

async function app(role: "admin" | "operator" = "admin") {
  const secrets = await SecretStore.open(dir, { NOURIDE_ENCRYPTION_KEY: KEY });
  const audited: { action: string; actor?: string; details?: unknown }[] = [];
  const deps = { secrets, config: structuredClone(DEFAULT_CONFIG), audit: { record: (row: { action: string; actor?: string; details?: unknown }) => void audited.push(row) }, packs: () => [] } as unknown as SettingsDeps;
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { username: role } });
    await next();
  });
  registerSecretRoutes(control as never, {
    ctx: { config: deps.config },
    settings: {
      secretInventory: () => secretInventory(deps),
      secretLock: () => secretLock(deps),
      secretShadowedByEnv: () => false,
      setSecret: (params: Parameters<typeof setSecret>[1]) => setSecret(deps, params),
      changeSecretFields: (params: Parameters<typeof changeSecretFields>[1]) => changeSecretFields(deps, params),
    },
  } as never);
  const send = (method: string, path: string, body?: unknown) =>
    control.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { secrets, audited, send };
}

describe("fields over the control API", () => {
  test("given with a value, listed with the name; the value is in no answer and no audit row", async () => {
    const { send, audited } = await app();
    const put = await send("PUT", "/secrets/github", { value: "ghp_stand_in_value", fields: { set: { domain: "github.com", username: "nouva-bot" } } });
    expect(put.status).toBe(200);
    const listed = (await (await send("GET", "/secrets")).json()) as { secrets: { name: string; fields: Record<string, string>; addedBy?: string }[] };
    expect(listed.secrets).toEqual([expect.objectContaining({ name: "github", origin: "store", fields: { domain: "github.com", username: "nouva-bot" }, addedBy: "admin" })]);
    expect(JSON.stringify(listed)).not.toContain("ghp_stand_in_value");
    expect(JSON.stringify(audited)).not.toContain("ghp_stand_in_value");
  });

  test("changed on their own: set and removed, the value as it was, audited by the names changed", async () => {
    const { send, secrets, audited } = await app();
    await send("PUT", "/secrets/github", { value: "ghp_stand_in_value", fields: { set: { domain: "github.com", note: "old" } } });
    const patched = await send("PATCH", "/secrets/github/fields", { set: { username: "nouva-bot" }, remove: ["note"] });
    expect(await patched.json()).toEqual({ ok: true, fields: { domain: "github.com", username: "nouva-bot" } });
    expect(secrets.resolve("github")).toBe("ghp_stand_in_value");
    expect(audited.at(-1)).toEqual({ action: "secret_fields_changed", actor: "admin", details: { name: "github", fields: ["username", "note"] } });
  });

  test("a field with a key's shape is refused naming it, and with a value nothing is stored", async () => {
    const { send, secrets } = await app();
    const put = await send("PUT", "/secrets/github", { value: "ghp_stand_in_value", fields: { set: { backup: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" } } });
    expect(put.status).toBe(400);
    const refused = (await put.json()) as { error: string; plain: string };
    expect(refused.error).toContain('field "backup" looks like a key or a password');
    // The page names the part of the form at fault, the details, not "what you entered" (0.8.23).
    expect(refused.plain).toBe("Nothing was saved. Check the details, and try again.");
    expect(secrets.has("github")).toBe(false);
  });

  test("an operator may list but not change; a body that is not a change, and a secret not stored, are refused", async () => {
    const admin = await app();
    await admin.send("PUT", "/secrets/github", { value: "ghp_stand_in_value" });
    expect((await (await app("operator")).send("PATCH", "/secrets/github/fields", { set: { a: "b" } })).status).toBe(403);
    expect((await admin.send("PATCH", "/secrets/github/fields", { set: ["not", "an", "object"] })).status).toBe(400);
    expect((await admin.send("PATCH", "/secrets/github/fields", {})).status).toBe(400);
    const missing = await admin.send("PATCH", "/secrets/nothing/fields", { set: { a: "b" } });
    expect(missing.status).toBe(400);
    const gone = (await missing.json()) as { error: string; plain: string };
    expect(gone.error).toContain('no stored secret "nothing"');
    // No field of the form is at fault: the words stay what they were.
    expect(gone.plain).toBe("Nothing was saved. Check what you entered, and try again.");
    const named = await admin.send("PATCH", "/secrets/github/fields", { set: { "1 not a name": "b" } });
    expect(((await named.json()) as { plain: string }).plain).toBe("Nothing was saved. Check the details, and try again.");
  });
});

describe("the store's lock beside the list", () => {
  test("encrypted, with where its key is and how far from the data; never the key", async () => {
    const { send } = await app();
    await send("PUT", "/secrets/github", { value: "ghp_stand_in_value" });
    const body = (await (await send("GET", "/secrets")).json()) as { lock: unknown };
    expect(body.lock).toEqual({ encrypted: true, key: { where: "the environment", level: "outside" } });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
