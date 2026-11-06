/**
 * `/cron` refuses a job no agent can run — at the request, not hours later when it comes due.
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
import { CronStore } from "@/modules/cron/cron.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;
let store: CronStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cron-agent-route-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  store = new CronStore({ db, config: config.cron, timezone: "Asia/Jakarta" });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    cron: { store, scheduler: {}, timezone: "Asia/Jakarta" },
    registry: { get: (id: string) => (id === "nouva" ? { dir: "/packs/nouva", config: {} } : undefined), reload: async () => {} },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  app.request(
    `/api/control${path}`,
    { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) },
    { clientAddress: "203.0.113.10" },
  );

const job = (agentId: string) => ({
  agentId,
  name: "publish",
  cron: "15 21 * * *",
  payload: { kind: "agentTurn", message: "go" },
  target: { gatewayId: "telegram:nouva", chatId: "1" },
});

describe("which agent runs a job", () => {
  test("none, or one that does not exist, is refused with a sentence saying so", async () => {
    const none = await post("/cron", job(""));
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toContain("needs an agent");

    const ghost = await post("/cron", job("ghost"));
    expect(ghost.status).toBe(400);
    expect(((await ghost.json()) as { error: string }).error).toBe('no agent "ghost": a job must name one that exists');
    expect(store.list()).toHaveLength(0);
  });

  test("a real one is accepted, and an update can change it — but not to one that does not exist", async () => {
    const created = await post("/cron", job("nouva"));
    expect(created.status).toBe(200);
    const { job: saved } = (await created.json()) as { job: { id: string } };
    expect((await post(`/cron/${saved.id}`, { agentId: "ghost" })).status).toBe(400);
    expect((await post(`/cron/${saved.id}`, { agentId: "nouva", name: "renamed" })).status).toBe(200);
  });
});
