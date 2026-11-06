/**
 * `POST /restart` — the dashboard's Restart, and `nouride restart`.
 *
 * No route test existed, and the route had two faults nobody saw: it ended the process 50 ms after being
 * asked, whatever was running, and the CLI created its wake-up *before* asking — so a refusal (no supervisor)
 * still left a follow-up that fired into a daemon that had never gone down. The follow-up is now the route's
 * to create, after the refusal could have happened.
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
import { DaemonRestart } from "@/modules/update/restart.ts";
import { eventually } from "../helpers.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;
let store: CronStore;
let restarts: number;
let supervised: boolean;
let restart: DaemonRestart;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restart-route-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  store = new CronStore({ db, config: config.cron, timezone: "Asia/Jakarta" });
  restarts = 0;
  supervised = true;
  const audit = new AuditLog(db);
  restart = new DaemonRestart({
    requestRestart: () => void (restarts += 1),
    supervisor: () => (supervised ? { kind: "systemd", restartsOnExit: true } : { kind: "none", restartsOnExit: false }),
    busy: () => false,
    cron: store,
    audit,
    pacing: { beatMs: 5, pollMs: 5 },
  });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit,
    users: new UserStore({ db }),
    files: {},
    registry: { get: (id: string) => (id === "nouva" ? { config: { id } } : undefined) },
    restart,
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) =>
  app.request(
    `/api/control${path}`,
    {
      method: "POST",
      headers: { "x-nouride-token": TOKEN, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { clientAddress: "203.0.113.10" },
  );

/** The restart happened — polled, not slept for: a fixed wait against the beat was a bet on the machine's load. */
const restarted = () => eventually(() => restarts === 1, 4_000, "the restart");
const target = { agent_id: "nouva", gateway_id: "telegram:nouva", chat_id: "814" };

describe("POST /restart", () => {
  test("with nothing to start the daemon again is refused, says what to do, and schedules nothing", async () => {
    supervised = false;
    const res = await post("/restart", { ...target, then: "check the gateways" });

    expect(res.status).toBe(409);
    // The CLI's words as they were, and the page's beside them (0.8.20): the dashboard showed the command and the flag.
    expect(await res.json()).toMatchObject({
      error: "nothing would restart this daemon",
      note: expect.stringContaining("nouride service install"),
      plain: "Nouride was not restarted: nothing on this server would start it again. Whoever runs the server can restart it there.",
    });
    // Nothing is waiting to restart it, so nothing will — said from the state, not from a quiet interval.
    expect({ jobs: store.list().length, restarts, waiting: restart.waiting }).toEqual({ jobs: 0, restarts: 0, waiting: false });
  });

  test("answers first, then restarts — with no body at all, as the CLI from before sends it", async () => {
    const res = await post("/restart");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, waiting: false, supervisor: "systemd", note: "restarting now: systemd is expected to start it again", plain: "Nouride is restarting now." });
    expect(restarts).toBe(0);
    await restarted();
  });

  test("`then` writes the turn that comes back, parked until the process ends", async () => {
    const res = await post("/restart", { ...target, then: "check the gateways", in_seconds: 15 });
    expect(await res.json()).toMatchObject({ ok: true, wake_in_seconds: 15 });

    const [job] = store.list();
    expect(job).toMatchObject({
      agentId: "nouva",
      name: "wake-up: restarting the daemon",
      target: { gatewayId: "telegram:nouva", chatId: "814" },
      session: "chat",
      createdBy: "restart",
    });
    await restarted();
    // Armed as the process ended: fifteen seconds from then, not fifteen minutes.
    expect(store.get(job!.id)!.nextRunAt! - Date.now()).toBeLessThan(16_000);
  });

  test("a follow-up aimed at half a conversation, or at no agent, is refused before anything happens", async () => {
    expect((await post("/restart", { agent_id: "nouva", chat_id: "814", then: "check" })).status).toBe(400);
    const ghost = await post("/restart", { ...target, agent_id: "ghost", then: "check" });
    expect(ghost.status).toBe(400);
    expect(((await ghost.json()) as { error: string }).error).toContain('no agent "ghost"');
    expect({ jobs: store.list().length, restarts, waiting: restart.waiting }).toEqual({ jobs: 0, restarts: 0, waiting: false });
  });
});
