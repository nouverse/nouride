/**
 * A conversation's work notes over the control API: found by its session row, or — while a new conversation's first
 * turn still runs and it has no row yet — by that turn's record. Found live in 0.8.0: the plan beside a new chat
 * answered 404 for its whole first turn, so the strip above the composer never showed it.
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
import { NotesStore } from "@/modules/notes/store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
const KEY = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
const SESSION = "ses_nouva:web:dashboard:web-1";

let dir: string;
let db: SqliteDb;
let notes: NotesStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "notes-route-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  notes = new NotesStore(join(dir, "notes"));
  await notes.keepPlan(KEY, "Current work", [
    { text: "wait", state: "done" },
    { text: "wait again", state: "active" },
    { text: "report", state: "pending" },
  ]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function control(found: { session?: boolean; turn?: boolean }): Hono {
  const app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    notes,
    sessions: { find: (id: string) => (found.session && id === SESSION ? { id: SESSION, ...KEY } : null) },
    turns: { latestForSession: (id: string) => (found.turn && id === SESSION ? { id: "turn_1", sessionId: SESSION, ...KEY, status: "running" } : null) },
  } as unknown as ControlDeps);
  return app;
}

const read = (app: Hono) => app.request(`/api/control/sessions/${encodeURIComponent(SESSION)}/notes`, { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });

describe("GET /sessions/:id/notes", () => {
  test("a conversation with a row: its plan", async () => {
    const res = await read(control({ session: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan: { steps: unknown[] } }).plan.steps).toHaveLength(3);
  });

  test("a new conversation's first turn, still running and with no row yet: its plan, from the turn's record", async () => {
    const res = await read(control({ turn: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { task: string; steps: { text: string; state: string }[] } };
    expect(body.plan.steps.map((step) => `${step.text}:${step.state}`)).toEqual(["wait:done", "wait again:active", "report:pending"]);
  });

  test("neither a row nor a turn: no such session", async () => {
    expect((await read(control({}))).status).toBe(404);
  });
});
