/**
 * `GET /approvals?all=1` and `GET /approvals/:id` (0.8.7): what `nouride approvals --all` and `show <id>` read — the
 * answered requests the gate keeps, beside the pending ones, from a real gate on a migrated database.
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
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;

function row(id: string, agentId: string, status: string, resolvedAt: number | null) {
  db.prepare("INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, status, requested_at, resolved_at, decision, timeout_ms) VALUES (?, ?, 'c', 'telegram', 'exec', '{}', ?, 1, ?, ?, 60000)").run(
    id, agentId, status, resolvedAt, status === "approved" ? "allow-once" : null,
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "approvals-history-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    approvals: new SqliteApprovalGate({ db, timeoutMs: 60_000 }),
  } as unknown as ControlDeps);
  row("apr_wait", "nouva", "pending", null);
  row("apr_old", "nouva", "approved", 10);
  row("apr_new", "nox", "denied", 20);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => app.request(`/api/control${path}`, { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });

describe("approvals history over the control API", () => {
  test("plain: pending only, as before", async () => {
    const body = (await (await get("/approvals")).json()) as Record<string, { id: string }[]>;
    expect(body.pending!.map((one) => one.id)).toEqual(["apr_wait"]);
    expect(body.settled).toBeUndefined();
  });

  test("all=1: the answered ones too, newest first; agent= narrows both", async () => {
    const all = (await (await get("/approvals?all=1")).json()) as Record<string, { id: string }[]>;
    expect(all.settled!.map((one) => one.id)).toEqual(["apr_new", "apr_old"]);
    const mine = (await (await get("/approvals?all=1&agent=nouva")).json()) as Record<string, { id: string }[]>;
    expect(mine.pending!.map((one) => one.id)).toEqual(["apr_wait"]);
    expect(mine.settled!.map((one) => one.id)).toEqual(["apr_old"]);
  });

  test("one by id, whatever became of it; an unknown id is a 404", async () => {
    const one = (await (await get("/approvals/apr_old")).json()) as { approval: { status: string; decision: string } };
    expect(one.approval).toMatchObject({ status: "approved", decision: "allow-once" });
    expect((await get("/approvals/apr_nope")).status).toBe(404);
  });
});
