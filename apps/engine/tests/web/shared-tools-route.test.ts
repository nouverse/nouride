/**
 * The dashboard's way to whether the orchestrator installs the programs every agent runs (`[security] shared_tools`,
 * 0.8.0): admin only, a boolean, into that agent's own pack — and what it writes there.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { cheapPasswords } from "../helpers.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { setAgentModelGuard, setAgentSharedTools } from "@/modules/config/settings/agents.ts";

const TOKEN = "control-token-for-tests-0000000000";
const OPERATOR_PASSWORD = "operator-password-1";
let dir = "";
let db: SqliteDb;
let app: Hono;
let calls: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "shared-tools-route-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  calls = [];
  const users = new UserStore({ db, passwords: cheapPasswords });
  await users.create({ username: "opal", password: OPERATOR_PASSWORD, role: "operator", createdBy: "test" });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users,
    files: {},
    registry: { get: (id: string) => (id === "nouva" ? { dir: "/packs/nouva", config: {} } : undefined), reload: async () => {} },
    settings: {
      setAgentSharedTools: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true, restartRequired: false };
      },
      setAgentModelGuard: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true, restartRequired: false };
      },
    },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, body: unknown, cookie?: string) =>
  app.request(
    `/api/control${path}`,
    { method: "POST", headers: { ...(cookie ? { cookie } : { "x-nouride-token": TOKEN }), "content-type": "application/json" }, body: JSON.stringify(body) },
    { clientAddress: "203.0.113.10" },
  );

describe("whether the orchestrator installs programs for every agent", () => {
  test("on or off, into that agent's own pack, by an admin — an operator is refused before anything is written", async () => {
    expect(await (await call("/agents/nouva/shared_tools", { on: false })).json()).toEqual({ ok: true, on: false });
    expect(calls.map((args) => [args.on, args.agentConfigPath])).toEqual([[false, "/packs/nouva/config.toml"]]);
    const login = await call("/auth/login", { username: "opal", password: OPERATOR_PASSWORD });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await call("/agents/nouva/shared_tools", { on: true }, cookie)).status).toBe(403);
    expect((await call("/agents/nouva/shared_tools", { on: "yes" })).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("off is written; on takes the key out, so the pack says what one that never turned it off says", async () => {
    const pack = join(dir, "config.toml");
    writeFileSync(pack, '[agent]\nname = "Nouva"\n');
    const input = { agentConfigPath: pack, reload: async () => {}, agentId: "nouva", actor: "admin" };
    expect(await setAgentSharedTools({}, { ...input, on: false })).toEqual({ ok: true, restartRequired: false });
    expect(readFileSync(pack, "utf-8")).toContain("[security]\nshared_tools = false");
    await setAgentSharedTools({}, { ...input, on: true });
    expect(readFileSync(pack, "utf-8")).not.toContain("shared_tools");
  });
});

describe("an agent's second look (0.8.0)", () => {
  test("off, a tier or a model id — or null to follow the daemon's — by an admin, into that agent's own pack", async () => {
    expect(await (await call("/agents/nouva/model_guard", { value: "off" })).json()).toEqual({ ok: true, value: "off" });
    expect(await (await call("/agents/nouva/model_guard", { value: null })).json()).toEqual({ ok: true, value: null });
    expect(calls.map((args) => args.value)).toEqual(["off", null]);
    expect((await call("/agents/nouva/model_guard", { value: 1 })).status).toBe(400);
    const login = await call("/auth/login", { username: "opal", password: OPERATOR_PASSWORD });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await call("/agents/nouva/model_guard", { value: "off" }, cookie)).status).toBe(403);
  });

  test("written as said; null takes the key out; a switch's word is refused before anything is written", async () => {
    const pack = join(dir, "config.toml");
    writeFileSync(pack, '[agent]\nname = "Nouva"\n');
    const input = { agentConfigPath: pack, reload: async () => {}, agentId: "nouva", actor: "admin" };
    expect(await setAgentModelGuard({}, { ...input, value: "high" })).toEqual({ ok: true, restartRequired: false });
    expect(readFileSync(pack, "utf-8")).toContain('[security]\nmodel_guard = "high"');
    expect(await setAgentModelGuard({}, { ...input, value: "on" })).toMatchObject({ ok: false, error: expect.stringContaining("none of off, a tier") });
    await setAgentModelGuard({}, { ...input, value: null });
    expect(readFileSync(pack, "utf-8")).not.toContain("model_guard");
  });
});
