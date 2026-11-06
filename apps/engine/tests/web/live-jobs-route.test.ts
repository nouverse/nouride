/**
 * `/sessions/:id/live` reports the conversation's running jobs while its first turn is still going.
 *
 * A new conversation's session is stored when its first turn ends, and the jobs were looked up by
 * session — so a job that turn started appeared only once the agent had finished (2026-10-07).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { turnStore } from "../helpers.ts";

const TOKEN = "control-token-for-tests-0000000000";
const WHERE = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
const SESSION = "ses_nouva:web:dashboard:web-1";
let dir = "";
let db: SqliteDb;
let app: Hono;
let jobs: JobStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "live-jobs-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const turns = turnStore(db);
  jobs = new JobStore({ db, logDir: join(dir, "logs"), maxConcurrentPerAgent: 4 });
  turns.begin({ sessionId: SESSION, ...WHERE, prompt: "start a build" });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    turns,
    jobs,
    // The first turn is still running, so the session has not been written yet.
    sessions: { find: () => null },
  } as unknown as ControlDeps);
});
afterEach(() => {
  for (const job of jobs.running("nouva")) jobs.kill(job.id, "test");
  db.close();
  removePath(dir);
});

describe("jobs while the first turn runs", () => {
  test("a job the turn started is reported at once, not when the turn ends", async () => {
    const job = jobs.start({ ...WHERE, argv: ["sleep", "5"], sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } } });
    const res = await app.request(`/api/control/sessions/${encodeURIComponent(SESSION)}/live`, { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });
    const body = (await res.json()) as { turn: { status: string }; jobs: { id: string }[] };
    expect(body.turn.status).toBe("running");
    expect(body.jobs.map((j) => j.id)).toEqual([job.id]);
  });

  test("another conversation's job is still not this one's", async () => {
    jobs.start({ ...WHERE, chatId: "web-2", argv: ["sleep", "5"], sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } } });
    const res = await app.request(`/api/control/sessions/${encodeURIComponent(SESSION)}/live`, { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });
    expect(((await res.json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });
});
