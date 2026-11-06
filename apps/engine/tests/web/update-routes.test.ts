/**
 * The `/update` routes: the last check in front of replacing this daemon's binary from the dashboard or the CLI.
 *
 * Nothing sent them a request (`tests-update-apply-orchestration-untested`): the admin gate on the routes that swap
 * the binary, the all-three-or-none rule for the follow-up, the delay's bounds, and the audit record were all
 * unpinned, and `cli-contract.test.ts` checked only that `/update/apply` is registered. Mounted here the way the
 * daemon mounts them, with the real guard and real accounts, and the update module replaced by `ControlDeps.updates`.
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
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import { followUpFrom, type UpdateOps } from "@/modules/web/control/routes/update.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { cheapPasswords } from "../helpers.ts";

const TOKEN = "control-token-for-tests-0000000000";
const OPERATOR_PASSWORD = "operator-password-1";

let dir = "";
let db: SqliteDb;
let audit: AuditLog;
let app: Hono;
let supported = true;
let withCron = true;
/** Each self-update the routes asked for, with what they passed. */
let ran: { deps: Parameters<UpdateOps["runSelfUpdate"]>[0]; target: Parameters<UpdateOps["runSelfUpdate"]>[1] }[] = [];
let failWith: string | null = null;
/** Each track the route saved (0.8.18). */
let tracks: string[] = [];

const IDLE = { status: "idle" as const, received: 0, total: null, tag: null, artifact: null, path: null, error: null };

function ops(): UpdateOps {
  return {
    updateSupported: () => supported,
    describeInstall: async () => ({ version: "0.7.8", edition: "basic", installDir: dir, installDirWritable: true, supervisor: "systemd", restartsOnExit: true, compiled: true, platform: "linux", arch: "x64", musl: false }),
    checkForUpdate: async () => ({ current: "0.7.8", latest: "v0.7.9", newer: true, track: "latest", publishedAt: null, notesUrl: null }),
    downloadState: () => IDLE,
    startDownload: async () => {
      if (failWith) throw new Error(failWith);
      return { check: { current: "0.7.8", latest: "v0.7.9", newer: true, track: "latest", publishedAt: null, notesUrl: null }, download: { ...IDLE, status: "downloading" } };
    },
    pauseDownload: () => IDLE,
    discardDownload: async () => IDLE,
    runSelfUpdate: async (deps, target) => {
      if (failWith) throw new Error(failWith);
      ran.push({ deps, target });
      return { note: "Replaced nouride.", to: "v0.7.9", followUp: null, restart: "idle" };
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-update-routes-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(dir, ".nouride/data");
  audit = new AuditLog(db);
  const users = new UserStore({ passwords: cheapPasswords, db });
  await users.create({ username: "opal", password: OPERATOR_PASSWORD, role: "operator", createdBy: "test" });
  supported = true;
  withCron = true;
  ran = [];
  failWith = null;
  tracks = [];
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit,
    users,
    files: {},
    pipeline: { stats: () => ({ running: 0, waiting: 0, completed: 0 }) },
    approvals: { pending: () => [] },
    get cron() {
      return withCron ? { store: new CronStore({ db, config: config.cron, timezone: "UTC" }), scheduler: {}, timezone: "UTC" } : undefined;
    },
    updates: ops(),
    settings: {
      setUpdateTrack: async (params: { track: string }) => {
        tracks.push(params.track);
        return { ok: true, restartRequired: false };
      },
    },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  app.request(
    `/api/control${path}`,
    {
      method: init.method ?? "POST",
      headers: { ...(init.cookie ? { cookie: init.cookie } : { "x-nouride-token": TOKEN }), "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    { clientAddress: "203.0.113.10" },
  );

async function operatorCookie(): Promise<string> {
  const res = await call("/auth/login", { body: { username: "opal", password: OPERATOR_PASSWORD } });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const ACTING = ["/update/apply", "/update/install", "/update/download", "/update/pause", "/update/discard"];

describe("who may act", () => {
  test("every route that acts is admin only — an operator gets past the guard and is refused each one", async () => {
    const cookie = await operatorCookie();
    for (const path of ACTING) {
      const res = await call(path, { cookie, body: {} });
      expect({ path, status: res.status, body: await res.json() }).toEqual({ path, status: 403, body: { error: "admin only" } });
    }
    expect(ran).toEqual([]);
  });

  test("while reading whether anything is newer is anyone's", async () => {
    const res = await call("/update", { method: "GET", cookie: await operatorCookie() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ supported: true, check: { latest: "v0.7.9" } });
  });

  test("a build with no update provider says 501 on every route that acts", async () => {
    supported = false;
    for (const path of ACTING) expect({ path, status: (await call(path, { body: {} })).status }).toEqual({ path, status: 501 });
    // And the read says so as an answer, not an error.
    expect(await (await call("/update", { method: "GET" })).json()).toMatchObject({ supported: false });
  });
});

describe("taking the update", () => {
  for (const path of ["/update/apply", "/update/install"]) {
    test(`${path}: two of agent, gateway and chat is a 400, and nothing is touched`, async () => {
      const res = await call(path, { body: { agent_id: "nouva", gateway_id: "telegram:nouva" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "give agent_id, gateway_id and chat_id together, or none of them", plain: "Nouride could not read that request. Reload the page and try again." });
      expect(ran).toEqual([]);
    });

    test(`${path}: with the scheduler off it is a 409, because no follow-up could be scheduled`, async () => {
      withCron = false;
      const res = await call(path, { body: {} });
      expect(res.status).toBe(409);
      expect(ran).toEqual([]);
    });

    test(`${path}: a refusal from the update itself is a 409 with its reason`, async () => {
      failWith = "nothing would restart this daemon after the swap";
      const res = await call(path, { body: {} });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "nothing would restart this daemon after the swap", plain: "The update did not install. Try again in a moment." });
    });

    test(`${path}: aimed at a conversation, the follow-up and its clamped delay are what the update gets, and it is audited`, async () => {
      const res = await call(path, { body: { agent_id: "nouva", gateway_id: "telegram:nouva", chat_id: "814", then: "  check the version  ", in_seconds: 1 } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, to: "v0.7.9", wake_in_seconds: 10 });
      expect(ran[0]!.target).toEqual({ message: "check the version", delaySeconds: 10, agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814" });
      const rows = audit.ofActions(["daemon_update"]);
      expect(rows.map((row) => ({ actor: row.actor, to: row.details?.to }))).toEqual([{ actor: "cli", to: "v0.7.9" }]);
    });
  }

  test("only the install says the download is staged, so apply downloads and install does not download twice", async () => {
    await call("/update/apply", { body: {} });
    await call("/update/install", { body: {} });
    expect(ran.map((run) => run.deps.staged)).toEqual([undefined, false]);
  });

  test("none aimed is the watched case: a person with the page open needs no follow-up turn", async () => {
    await call("/update/install", { body: { now: true } });
    expect(ran[0]!.target).toEqual({ watched: true });
    expect(ran[0]!.deps.immediately).toBe(true);
  });
});

describe("followUpFrom", () => {
  test("the delay is clamped to 10..600 seconds and whole, and defaults to 20", () => {
    const delay = (in_seconds: unknown) => {
      const parsed = followUpFrom({ in_seconds });
      if ("error" in parsed) throw new Error(parsed.error);
      return parsed.delaySeconds;
    };
    expect([delay(1), delay(10), delay(25.9), delay(600), delay(9999), delay("30"), delay(undefined)]).toEqual([10, 10, 25, 600, 600, 20, 20]);
  });

  test("an empty `then` is the default turn, not an empty one", () => {
    const parsed = followUpFrom({ agent_id: "a", gateway_id: "g", chat_id: "c", then: "   " });
    expect("target" in parsed && "message" in parsed.target && parsed.target.message).toBe(
      "Confirm the daemon came back on the new version and every gateway reconnected.",
    );
  });

  test("one of three is refused like two of three", () => {
    expect(followUpFrom({ chat_id: "814" })).toEqual({ error: "give agent_id, gateway_id and chat_id together, or none of them" });
  });
});

describe("the update track (0.8.18)", () => {
  test("an operator cannot change what replaces the binary: 403, and nothing is saved", async () => {
    const res = await call("/update/track", { body: { track: "lts" }, cookie: await operatorCookie() });
    expect(res.status).toBe(403);
    expect(tracks).toEqual([]);
  });

  test("the owner's token can, and the answer carries the check", async () => {
    const res = await call("/update/track", { body: { track: "lts" } });
    expect(res.status).toBe(200);
    expect(tracks).toEqual(["lts"]);
    expect(await res.json()).toMatchObject({ ok: true, check: { latest: "v0.7.9" } });
  });
});
