/**
 * `POST /cron/:id/run` answers a browser that asks for it (`Prefer: respond-async, wait=N`) within N seconds — with the
 * outcome when the run is over by then, with 202 and `running` when it is not — and keeps the CLI's answer, the whole
 * run, for a caller that does not ask.
 *
 * The dashboard's Run waited on an agent turn that can take an hour, gave up at its own 15 s timeout, and said
 * nothing; a long webhook test-fire was reported as the daemon not answering.
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
let jobId = "";
/** What the scheduler's `runNow` returns next — a test decides how long the run takes. */
let nextRun: () => Promise<{ status: string; result?: string }>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cron-run-route-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  const store = new CronStore({ db, config: config.cron, timezone: "UTC" });
  jobId = store.create({
    agentId: "nouva",
    name: "report",
    trigger: { kind: "cron", expr: "0 9 * * *" },
    payload: { kind: "systemEvent", text: "hi" },
    target: { gatewayId: "telegram:nouva", chatId: "1" },
    createdBy: "tester",
  }).id;
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    cron: { store, scheduler: { runNow: () => nextRun() }, timezone: "UTC" },
    registry: { get: () => ({ dir: "/packs/nouva", config: {} }), reload: async () => {} },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (prefer?: string) =>
  app.request(
    `/api/control/cron/${jobId}/run`,
    { method: "POST", headers: { "x-nouride-token": TOKEN, ...(prefer ? { prefer } : {}) } },
    { clientAddress: "203.0.113.10" },
  );

describe("POST /cron/:id/run", () => {
  test("asked to answer at once, a run still going is a 202 that says so", async () => {
    nextRun = () => new Promise(() => {});
    const res = await run("respond-async, wait=0");
    expect(res.status).toBe(202);
    expect(res.headers.get("preference-applied")).toBe("respond-async");
    expect(await res.json()).toEqual({ outcome: { status: "running" } });
  });

  test("a run over within the wait answers with its outcome, as it always did", async () => {
    nextRun = async () => ({ status: "success", result: "delivered" });
    const res = await run("respond-async, wait=10");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: { status: "success", result: "delivered" } });
  });

  test("a caller that does not ask — the CLI — waits for the whole run", async () => {
    nextRun = () => new Promise((resolve) => setTimeout(() => resolve({ status: "error", result: "exit 1" }), 50));
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: { status: "error", result: "exit 1" } });
  });
});
