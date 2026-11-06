/**
 * A mission's own conversation over the control API (0.8.0). It is not one of a person's chats, so the chat list leaves
 * it out — listed, it could be deleted from there by mistake. Deleted anyway, it takes its mission with it: left alone,
 * the mission went on working with its checklist gone.
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
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
const CHAT = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
const MISSION = { agentId: "nouva", gatewayId: "web:mission", chatId: "msn_0123456789abcdef" };

let dir: string;
let db: SqliteDb;
let sessions: SessionStore;
let forgotten: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mission-conversations-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  sessions = new SessionStore(db);
  for (const key of [CHAT, MISSION]) sessions.save(key, [{ role: "user", content: "hello" }], 10);
  forgotten = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function control(): Hono {
  const app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    sessions,
    missions: { forget: (id: string) => void forgotten.push(id) },
    pipeline: { endConversation: async () => ({ stopped: false, turns: 0 }) },
  } as unknown as ControlDeps);
  return app;
}

const call = (path: string, method = "GET") => control().request(`/api/control${path}`, { method, headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });

describe("a mission's own conversation", () => {
  test("is not in the chat list, nor in its count", async () => {
    const body = (await (await call("/sessions")).json()) as { sessions: { gatewayId: string }[]; total: number };
    expect(body.sessions.map((session) => session.gatewayId)).toEqual(["web:dashboard"]);
    expect(body.total).toBe(1);
  });

  test("deleted, takes its mission with it; a person's chat deleted takes none", async () => {
    const missionSession = sessions.list({ limit: 10 }).find((session) => session.gatewayId === "web:mission")!;
    const chatSession = sessions.list({ limit: 10 }).find((session) => session.gatewayId === "web:dashboard")!;
    expect((await call(`/sessions/${encodeURIComponent(chatSession.id)}`, "DELETE")).status).toBe(200);
    expect(forgotten).toEqual([]);
    expect((await call(`/sessions/${encodeURIComponent(missionSession.id)}`, "DELETE")).status).toBe(200);
    expect(forgotten).toEqual([MISSION.chatId]);
  });
});
