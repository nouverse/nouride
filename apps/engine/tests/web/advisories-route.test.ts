/**
 * `GET /api/control/advisories`: what the last boot said about how this install is set up, for the dashboard's
 * Overview — said at warn once and at info after, an advisory was otherwise only in the journal.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Logger } from "@nouride/shared";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { openAdvisories } from "@/boot/advisories.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "advisories-route-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    state: new DaemonStateStore(db),
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const get = async () =>
  (await (await app.request("/api/control/advisories", { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" })).json()) as {
    advisories: { message: string; agents: string[]; since: number }[];
  };

test("lists the last boot's set, one line per thing said with its agents — and nothing before a boot wrote one", async () => {
  expect((await get()).advisories).toEqual([]);
  // What a boot writes, through the store the daemon builds over the same database.
  const said = openAdvisories(new DaemonStateStore(db), { warn: () => {}, info: () => {} } as unknown as Logger, () => 1_000);
  for (const agent of ["nouva", "nix"]) said.advise("exec_secrets.github_token is unscoped", { agent_id: agent });
  said.save();
  expect((await get()).advisories).toEqual([{ message: "exec_secrets.github_token is unscoped", agents: ["nouva", "nix"], since: 1_000 }]);
});
