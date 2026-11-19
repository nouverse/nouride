/**
 * Device tokens: a Home app on the daemon's own machine stays signed in (`routes/devices.ts`, `devices.store.ts`).
 *
 * Through the real control routes and stores: made only with the control token (never by a signed-in admin, never
 * for coming from loopback), bound to the first admin, traded for an ordinary session, held to the sign-in's limit
 * per address, listed and revoked by an admin, gone with "Reset accounts", and left alone by a password change.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { DeviceTokenStore } from "@/modules/users/devices.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { cheapPasswords } from "../helpers.ts";

const TOKEN = "control-token-for-tests-0000000000";
const PASSWORD = "correct horse battery";
const FAR = "203.0.113.10";
const LOOPBACK = "127.0.0.1";

let dir = "";
let db: SqliteDb;
let users: UserStore;
let devices: DeviceTokenStore;
let app: Hono;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "device-tokens-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  users = new UserStore({ passwords: cheapPasswords, db });
  devices = new DeviceTokenStore(db);
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users,
    devices,
    files: {},
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Ask = { method?: string; body?: unknown; cookie?: string; token?: boolean; from?: string };
async function call(path: string, ask: Ask = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ask.token) headers["x-nouride-token"] = TOKEN;
  if (ask.cookie) headers.cookie = ask.cookie;
  return await app.request(
    `/api/control${path}`,
    { method: ask.method ?? (ask.body === undefined ? "GET" : "POST"), headers, ...(ask.body === undefined ? {} : { body: JSON.stringify(ask.body) }) },
    { clientAddress: ask.from ?? FAR },
  );
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function accounts() {
  const first = await users.create({ username: "gading", password: PASSWORD, role: "admin", createdBy: "test" });
  // Made in the same millisecond or not, the first one made is the first admin: the row's order breaks a tie.
  const second = await users.create({ username: "rina", password: PASSWORD, role: "admin", createdBy: "test" });
  const operator = await users.create({ username: "sam", password: PASSWORD, role: "operator", createdBy: "test" });
  return { first, second, operator };
}
const signIn = async (username: string) => cookieOf(await call("/auth/login", { body: { username, password: PASSWORD } }));
const mint = async (name = "Nouride Home on the Mac") => call("/auth/devices", { token: true, body: { name } });
const trade = (token: string, from = FAR) => call("/auth/device", { body: { token }, from });

describe("making one", () => {
  test("with the control token: its value shown once, bound to the admin made first, only its hash kept", async () => {
    const { first } = await accounts();
    const res = await mint();
    expect(res.status).toBe(201);
    const made = (await res.json()) as { device: { id: string; label: string; userId: string; username: string }; value: string };
    expect(made.value).toStartWith("ndev_");
    expect(made.device).toMatchObject({ label: "Nouride Home on the Mac", userId: first.id, username: "gading" });
    const stored = db.prepare<{ token_hash: string }>("SELECT token_hash FROM device_tokens").all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toContain(made.value.slice(5));
  });

  test("never by a signed-in admin, never for coming from loopback, and never with no admin to bind it to", async () => {
    await accounts();
    const admin = await signIn("gading");
    expect((await call("/auth/devices", { cookie: admin, body: { name: "x" } })).status).toBe(403);
    expect((await call("/auth/devices", { body: { name: "x" }, from: LOOPBACK })).status).toBe(401);
    expect(devices.list()).toEqual([]);
    users.resetAll();
    expect((await mint()).status).toBe(409);
  });
});

describe("trading one for a session", () => {
  test("signs the app in as that admin, with an ordinary session the next request carries", async () => {
    await accounts();
    const { value } = (await (await mint()).json()) as { value: string };
    const res = await trade(value);
    expect(res.status).toBe(200);
    const session = cookieOf(res);
    expect(session).toStartWith("nouride_session=");
    const me = (await (await call("/auth/me", { cookie: session })).json()) as { user: { username: string } };
    expect(me.user.username).toBe("gading");
    expect(devices.list()[0]!.lastUsedAt).not.toBeNull();
  });

  // The dashboard offers no Sign out in a device's session (the app trades its token again at once), and tells such a
  // session from the account's answer, never from the browser: a browser on the same phone keeps its Sign out.
  test("the account's answer says the session is a device's, and says nothing of it for a password's or the control token", async () => {
    await accounts();
    const { value } = (await (await mint()).json()) as { value: string };
    const traded = (await (await call("/auth/me", { cookie: cookieOf(await trade(value)) })).json()) as Record<string, unknown>;
    expect(traded.device).toBe(true);
    // The same account, signed in with its password, on the same daemon and after the trade.
    const typed = (await (await call("/auth/me", { cookie: await signIn("gading") })).json()) as Record<string, unknown>;
    expect(typed.kind).toBe("user");
    expect("device" in typed).toBe(false);
    const cli = (await (await call("/auth/me", { token: true })).json()) as Record<string, unknown>;
    expect(cli.kind).toBe("token");
    expect("device" in cli).toBe(false);
  });

  test("signing out is not refused to a device's session", async () => {
    await accounts();
    const { value } = (await (await mint()).json()) as { value: string };
    const session = cookieOf(await trade(value));
    expect((await call("/auth/logout", { cookie: session, body: {} })).status).toBe(200);
    expect((await call("/auth/me", { cookie: session })).status).toBe(401);
  });

  test("a wrong token is refused, and failed trades spend the address's sign-in allowance, as wrong passwords do", async () => {
    await accounts();
    const { value } = (await (await mint()).json()) as { value: string };
    expect((await trade("ndev_not-a-token")).status).toBe(401);
    for (let i = 1; i < 30; i++) await trade(`ndev_guess-${i}`);
    expect((await trade(value)).status).toBe(429);
    expect((await call("/auth/login", { body: { username: "gading", password: PASSWORD } })).status).toBe(429);
    // Another address has its own allowance.
    expect((await trade(value, "198.51.100.7")).status).toBe(200);
  });

  test("a good trade gives its spend back", async () => {
    await accounts();
    const { value } = (await (await mint()).json()) as { value: string };
    for (let i = 0; i < 40; i++) expect((await trade(value)).status).toBe(200);
  });
});

describe("taking one back", () => {
  test("an admin lists and revokes it: its next trade is refused and its session ends; an operator does neither", async () => {
    await accounts();
    const { device, value } = (await (await mint()).json()) as { device: { id: string }; value: string };
    const operator = await signIn("sam");
    expect((await call("/auth/devices", { cookie: operator })).status).toBe(403);
    expect((await call(`/auth/devices/${device.id}`, { method: "DELETE", cookie: operator })).status).toBe(403);

    const admin = await signIn("rina");
    const listed = (await (await call("/auth/devices", { cookie: admin })).json()) as { devices: { id: string; username: string }[] };
    expect(listed.devices.map((one) => [one.id, one.username])).toEqual([[device.id, "gading"]]);
    const appSession = cookieOf(await trade(value));
    expect((await call("/auth/me", { cookie: appSession })).status).toBe(200);
    expect((await call(`/auth/devices/${device.id}`, { method: "DELETE", cookie: admin })).status).toBe(200);
    expect((await trade(value)).status).toBe(401);
    // The session it was traded for ends with it; the admin's own, made with a password, does not.
    expect((await call("/auth/me", { cookie: appSession })).status).toBe(401);
    expect((await call("/auth/me", { cookie: admin })).status).toBe(200);
    expect((await (await call("/auth/devices", { cookie: admin })).json()) as unknown).toEqual({ devices: [] });
  });

  test("\"Reset accounts\" takes every device token; a password change leaves them", async () => {
    const { first } = await accounts();
    const { value } = (await (await mint()).json()) as { value: string };
    await users.setPassword(first.id, "another long password", "test");
    users.endAllSessions(first.id);
    expect((await trade(value)).status).toBe(200);
    users.resetAll();
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM device_tokens").get()!.n).toBe(0);
    expect((await trade(value)).status).toBe(401);
  });
});
