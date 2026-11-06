/**
 * The dashboard's way to an agent's headline (0.7.18): operator and up, one short line, written into that agent's own
 * IDENTITY.md as its `Headline:` line, and the agent reloaded so its peers read it from their next message.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;
let reloaded: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "headline-route-"));
  mkdirSync(join(dir, "nouva"));
  writeFileSync(join(dir, "nouva", "IDENTITY.md"), "# IDENTITY\n\n- **Name:** Nouva\n- **Headline:** Assistant\n- **Emoji:** 🌙\n");
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  reloaded = [];
  const users = new UserStore({ db, passwords: cheapPasswords });
  await users.create({ username: "vic", password: "viewer-password-1", role: "viewer", createdBy: "test" });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users,
    files: {},
    registry: {
      get: (id: string) => (id === "nouva" ? { dir: join(dir, "nouva"), config: {} } : undefined),
      reload: async (id: string) => void reloaded.push(id),
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
const identity = () => readFileSync(join(dir, "nouva", "IDENTITY.md"), "utf8");

describe("an agent's headline", () => {
  test("is written as its Headline line — over the one it had — and the agent reloaded", async () => {
    const res = await call("/agents/nouva/headline", { headline: "Everyday help:  plans,\n reminders" });
    expect(await res.json()).toEqual({ ok: true, headline: "Everyday help: plans, reminders" });
    expect(identity()).toBe("# IDENTITY\n\n- **Name:** Nouva\n- **Headline:** Everyday help: plans, reminders\n- **Emoji:** 🌙\n");
    expect(reloaded).toEqual(["nouva"]);
  });

  test("past 150 characters, or empty, is refused and the file is left as it was", async () => {
    for (const headline of ["x".repeat(151), "   "]) {
      const res = await call("/agents/nouva/headline", { headline });
      expect(res.status).toBe(400);
    }
    expect(identity()).toContain("- **Headline:** Assistant");
    expect(reloaded).toEqual([]);
  });

  test("is an operator's to change: a viewer is refused", async () => {
    const login = await call("/auth/login", { username: "vic", password: "viewer-password-1" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await call("/agents/nouva/headline", { headline: "Mine now" }, cookie);
    expect(res.status).toBe(403);
    expect(identity()).toContain("- **Headline:** Assistant");
  });
});
