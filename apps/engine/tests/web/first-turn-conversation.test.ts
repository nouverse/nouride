/**
 * A conversation whose first turn is still running, over the control API.
 *
 * Its session row is written when that first turn ends, so for as long as it ran — eleven minutes, for Nix on Claude
 * Code on the live box (2026-11-02) — the chat list did not have it, while the Office showed the agent working in it,
 * and opening it from there found no session: the page fell back to the orchestrator. The list now carries such a
 * conversation from its running turn, and its transcript names the agent the turn is for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import type { TurnStore } from "@/modules/turns/turns.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { turnStore } from "../helpers.ts";

const TOKEN = "control-token-for-tests-0000000000";
const OLD = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
const FIRST = { agentId: "nix", gatewayId: "web:dashboard", chatId: "web-2" };
const FIRST_ID = sessionIdFor(FIRST);

let dir: string;
let db: SqliteDb;
let sessions: SessionStore;
let turns: TurnStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "first-turn-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  sessions = new SessionStore(db);
  turns = turnStore(db);
  // A conversation that has finished a turn, and one whose first turn is running: no row yet.
  sessions.save(OLD, [{ role: "user", content: "hello" }], 10);
  turns.begin({ sessionId: FIRST_ID, ...FIRST, prompt: "audit the release branch" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function control(local = true): Hono {
  const app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 2, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    sessions,
    turns,
    ...(local ? { local: { id: "web:dashboard" } } : {}),
  } as unknown as ControlDeps);
  return app;
}

interface Listed { id: string; agentId: string; gatewayId: string; chatId: string; running: boolean; title?: string }
interface List { sessions: Listed[]; total: number }
interface Transcript { session: { id: string; agentId: string; chatId: string; gatewayId: string; writable: boolean } | null; turns: unknown[] }

const call = async <T>(path: string): Promise<T> =>
  (await (await control().request(`/api/control${path}`, { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" })).json()) as T;
const list = (path: string) => call<List>(path);
const ids = async (path: string) => (await list(path)).sessions.map((session) => session.id);
const transcriptOf = (id: string) => call<Transcript>(`/sessions/${encodeURIComponent(id)}/turns`);

describe("a conversation whose first turn is running", () => {
  test("is in the chat list, working, named by what was asked, and counted", async () => {
    const body = await list("/sessions");
    const listed = body.sessions.find((session) => session.id === FIRST_ID);
    expect(listed).toMatchObject({ id: FIRST_ID, agentId: "nix", gatewayId: "web:dashboard", chatId: "web-2", running: true, title: "audit the release branch" });
    // First, as the newest; then the conversation that has a row.
    expect(body.sessions.map((session) => session.id)).toEqual([FIRST_ID, sessionIdFor(OLD)]);
    expect(body.total).toBe(2);
  });

  test("is held to the list's own filters: the agent, the search, a later page", async () => {
    expect(await ids("/sessions?agent=nouva")).toEqual([sessionIdFor(OLD)]);
    expect(await ids("/sessions?q=release")).toEqual([FIRST_ID]);
    expect(await ids("/sessions?q=hello-nothing")).toEqual([]);
    expect(await ids(`/sessions?before=${Date.now() + 60_000}`)).toEqual([sessionIdFor(OLD)]);
  });

  test("once its row is written, it is listed once", async () => {
    sessions.save(FIRST, [{ role: "user", content: "audit the release branch" }], 10);
    expect((await ids("/sessions")).filter((id) => id === FIRST_ID)).toHaveLength(1);
  });

  test("its transcript names the agent the turn is for, and whether this dashboard can send there", async () => {
    const body = await transcriptOf(FIRST_ID);
    expect(body.session).toMatchObject({ id: FIRST_ID, agentId: "nix", chatId: "web-2", gatewayId: "web:dashboard", writable: true });
    // The running turn itself is `/live`'s, never the transcript's.
    expect(body.turns).toEqual([]);
  });

  test("an id nothing has a turn for, or whose turns are over with no row, is still answered with no session", async () => {
    expect((await transcriptOf("ses_nix:web:dashboard:web-404")).session).toBeNull();
    const ended = { agentId: "nix", gatewayId: "web:dashboard", chatId: "web-3" };
    turns.finish(turns.begin({ sessionId: sessionIdFor(ended), ...ended, prompt: "an old question" }), { status: "done", reply: "answered" });
    expect((await transcriptOf(sessionIdFor(ended))).session).toBeNull();
  });
});
