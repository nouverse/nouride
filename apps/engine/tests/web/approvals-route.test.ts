/**
 * The dashboard's way to an agent's approval level: the new names only (0.7.23). An old one — `risky` — is refused
 * with what it is called now, and nothing is written; the loader's mapping is for a file at boot, not for a request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { setAgentApprovals } from "@/modules/config/settings/agents.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;
let written: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "approvals-route-"));
  mkdirSync(join(dir, "nouva"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  written = [];
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    settings: {
      setAgentApprovals: async (input: { approvals: string }) => {
        written.push(input.approvals);
        return { ok: true, restartRequired: false };
      },
    },
    registry: {
      get: (id: string) => (id === "nouva" ? { dir: join(dir, "nouva"), config: {} } : undefined),
      reload: async () => {},
    },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  app.request(
    "/api/control/agents/nouva/approvals",
    { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) },
    { clientAddress: "203.0.113.10" },
  );

describe("POST /agents/:id/approvals", () => {
  test("an old name (until 0.7.23) is refused like any other word, and nothing is written", async () => {
    for (const old of ["normal", "risky", "none"]) {
      const res = await post({ approvals: old });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `approvals must be one of careful, balanced, trusted, per-person, got "${old}"`, plain: "Nouride could not read that request. Reload the page and try again." });
    }
    expect(written).toEqual([]);
  });

  test("each new name, and per-person, is taken", async () => {
    for (const level of ["careful", "balanced", "trusted", "per-person"]) {
      const res = await post({ approvals: level });
      expect(await res.json()).toEqual({ ok: true, approvals: level });
    }
    expect(written).toEqual(["careful", "balanced", "trusted", "per-person"]);
  });
});

describe("setAgentApprovals", () => {
  test("refuses an old name like any other word, and leaves the pack as it was", async () => {
    const agentConfigPath = join(dir, "nouva", "config.toml");
    writeFileSync(agentConfigPath, '[agent]\nname = "Nouva"\n');
    const deps = { config: structuredClone(DEFAULT_CONFIG), configPath: join(dir, "config.toml") } as never;
    const result = await setAgentApprovals(deps, { agentConfigPath, reload: async () => {}, agentId: "nouva", approvals: "risky" as never, actor: "t" });
    expect(result).toEqual({ ok: false, error: 'approvals must be one of careful, balanced, trusted, per-person, got "risky"' });
    expect(readFileSync(agentConfigPath, "utf8")).toBe('[agent]\nname = "Nouva"\n');
  });
});
