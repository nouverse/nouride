/**
 * The dashboard's way to the quiet-job wait: what it reads, what it may send, and who may send it.
 * The settings service is a recorder here — what it does with the value is `job-quiet-settings.test`.
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
let calls: { what: string; args: Record<string, unknown> }[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "job-quiet-routes-"));
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
      setJobQuietMinutes: async (args: { minutes: number }) => {
        calls.push({ what: "daemon", args });
        config.jobs.quietAfterMinutes = args.minutes;
        return { ok: true, restartRequired: false };
      },
      saveAgentJobQuietMinutes: async (args: Record<string, unknown>) => {
        calls.push({ what: "agent", args });
        return { ok: true, restartRequired: false };
      },
    },
  } as unknown as ControlDeps;
  app = new Hono();
  mountControlRoutes(app, deps);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (path: string, body?: unknown) =>
  app.request(
    `/api/control${path}`,
    body === undefined
      ? { headers: { "x-nouride-token": TOKEN } }
      : { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) },
    { clientAddress: "203.0.113.10" },
  );

describe("the daemon's quiet-job wait", () => {
  test("reads the live value, with its bound", async () => {
    const res = await call("/policy/job-quiet");
    expect(await res.json()).toEqual({ minutes: 5, max: 1440, editable: true });
  });

  test("saves a number and answers with the value now in force", async () => {
    const res = await call("/policy/job-quiet", { minutes: 12 });
    expect(await res.json()).toEqual({ ok: true, minutes: 12 });
    expect(calls).toEqual([{ what: "daemon", args: expect.objectContaining({ minutes: 12 }) }]);
  });

  test("refuses anything but a number before the service sees it", async () => {
    expect((await call("/policy/job-quiet", { minutes: "5" })).status).toBe(400);
    // A body of `null` is JSON too: the route read `body.minutes` from it and answered 500.
    expect((await call("/policy/job-quiet", null)).status).toBe(400);
    expect((await call("/policy/job-quiet", [12])).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("one agent's", () => {
  test("a number, or null to follow the daemon, goes to that agent's own file", async () => {
    expect((await call("/agents/nouva/job-quiet", { minutes: 20 })).status).toBe(200);
    expect((await call("/agents/nouva/job-quiet", { minutes: null })).status).toBe(200);
    expect(calls.map((c) => c.args.minutes)).toEqual([20, null]);
    expect(calls[0]!.args.agentConfigPath).toBe("/packs/nouva/config.toml");
  });

  test("an agent that does not exist is a 404, not a file written somewhere", async () => {
    expect((await call("/agents/ghost/job-quiet", { minutes: 20 })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
