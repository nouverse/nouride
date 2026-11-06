/**
 * The dashboard's way to how many helpers an agent may run in the background (0.7.15): what it reads, what it may send,
 * and who may send it. The settings service is a recorder here — what it does with the value is
 * `config/delegate-settings.test.ts`.
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

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;
let calls: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "delegate-routes-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  calls = [];
  const config = structuredClone(DEFAULT_CONFIG);
  const deps = {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    registry: { get: (id: string) => (id === "nouva" ? { dir: "/packs/nouva", config: {} } : undefined), reload: async () => {} },
    settings: {
      saveAgentMaxBackground: async (args: Record<string, unknown>) => {
        calls.push(args);
        return args.value === 9 ? { ok: false, error: "[delegate] max_background must be a whole number from 0 (off) to 4, got 9" } : { ok: true, restartRequired: false };
      },
    },
  } as unknown as ControlDeps;
  app = new Hono();
  mountControlRoutes(app, deps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, body?: unknown) =>
  app.request(
    `/api/control${path}`,
    body === undefined
      ? { headers: { "x-nouride-token": TOKEN } }
      : { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) },
    { clientAddress: "203.0.113.10" },
  );

test("the daemon's limit is read with its ceiling", async () => {
  expect(await (await call("/policy/delegate")).json()).toEqual({ maxBackground: 2, max: 4, editable: true });
});

describe("one agent's limit", () => {
  test("a number, or null to follow the daemon, goes to that agent's own file", async () => {
    expect((await call("/agents/nouva/delegate", { maxBackground: 1 })).status).toBe(200);
    expect((await call("/agents/nouva/delegate", { maxBackground: null })).status).toBe(200);
    expect(calls.map((c) => c.value)).toEqual([1, null]);
    expect(calls[0]!.agentConfigPath).toBe("/packs/nouva/config.toml");
  });

  test("what the service refuses is a 400 with why; anything but a number never reaches it", async () => {
    const refused = await call("/agents/nouva/delegate", { maxBackground: 9 });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("from 0 (off) to 4");
    expect((await call("/agents/nouva/delegate", { maxBackground: "2" })).status).toBe(400);
    expect((await call("/agents/nouva/delegate", null)).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("an agent that does not exist is a 404, not a file written somewhere", async () => {
    expect((await call("/agents/ghost/delegate", { maxBackground: 1 })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
