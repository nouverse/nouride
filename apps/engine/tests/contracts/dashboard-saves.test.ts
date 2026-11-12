/**
 * What the dashboard's Automations page sends when it saves is taken by the routes it sends it to, and kept as the
 * page then draws it.
 *
 * The saves are the page's own (`apps/dashboard/tests/fixtures/automation-saves.json`, which the dashboard's test
 * holds to what the page builds: every kind of step, paths that go on, end and jump, each way to start, one thing and
 * a list, a new automation and a change). The page checks a list before it sends it and the routes check it again:
 * two copies of one rule, and the dashboard's mount tests answer a save from a fixture. So a body these routes refuse,
 * or keep in another shape, passed every test on both sides and failed in a browser, at Save.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

interface Save {
  name: string;
  send: { create: "/cron" | "/webhooks" } | { change: string };
  body: unknown;
  keeps: { name: string; start: string; payload: unknown; target: unknown; delivery: unknown };
}

const SAVES = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "dashboard", "tests", "fixtures", "automation-saves.json"), "utf8")) as Save[];
const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dashboard-saves-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  const store = new CronStore({ db, config: config.cron, timezone: "Asia/Jakarta" });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 2, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    cron: { store, scheduler: {}, timezone: "Asia/Jakarta" },
    // The agents the page's saves name: the automation's own, and another one step is given to.
    registry: { get: (id: string) => (["nouva", "nix"].includes(id) ? { dir: `/packs/${id}`, config: {} } : undefined), reload: async () => {} },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = (path: string, body?: unknown) =>
  app.request(
    `/api/control${path}`,
    body === undefined ? { headers: { "x-nouride-token": TOKEN } } : { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) },
    { clientAddress: "203.0.113.10" },
  );

/** The automation as its page is then answered (`GET /automations/:id`): the parts a save says it keeps. */
async function drawn(id: string): Promise<Save["keeps"]> {
  const answer = await ask(`/automations/${id}`);
  expect(answer.status).toBe(200);
  const { automation } = (await answer.json()) as { automation: Save["keeps"] };
  return { name: automation.name, start: automation.start, payload: automation.payload, target: automation.target, delivery: automation.delivery };
}

describe("what the Automations page saves", () => {
  test("the file is the page's: saves of new automations, and changes to them", () => {
    expect(SAVES.filter((save) => "create" in save.send).length).toBeGreaterThanOrEqual(5);
    expect(SAVES.filter((save) => "change" in save.send).length).toBeGreaterThanOrEqual(3);
  });

  test("each one is taken by the route it is sent to, and the automation is then drawn as the page saved it", async () => {
    const ids = new Map<string, string>();
    for (const save of SAVES) {
      const where = `"${save.name}"`;
      if ("create" in save.send) {
        const answer = await ask(save.send.create, save.body);
        const said = (await answer.json()) as { job?: { id: string }; webhook?: { id: string }; error?: string };
        expect({ save: where, status: answer.status, error: said.error }).toEqual({ save: where, status: 200, error: undefined });
        ids.set(save.name, (said.job ?? said.webhook)!.id);
      } else {
        const id = ids.get(save.send.change);
        expect({ save: where, changes: id !== undefined }).toEqual({ save: where, changes: true });
        const answer = await ask(`/cron/${id}`, save.body);
        const said = (await answer.json()) as { error?: string };
        expect({ save: where, status: answer.status, error: said.error }).toEqual({ save: where, status: 200, error: undefined });
        ids.set(save.name, id!);
      }
      expect({ save: where, ...(await drawn(ids.get(save.name)!)) }).toEqual({ save: where, ...save.keeps });
    }
  });
});
