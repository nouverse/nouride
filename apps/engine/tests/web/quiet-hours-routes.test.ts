/**
 * The dashboard's way to the install's quiet hours: what it reads, what it may send, and who may send it. The settings
 * service is a recorder here: what it does with the value is `quiet-hours-settings.test`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { registerQuietHoursRoutes } from "@/modules/web/control/routes/quiet-hours.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

let dir = "";
let db: SqliteDb;
let app: Hono;
let role: "admin" | "operator" | "viewer";
let saved: { hours: string; actor?: string }[];
let editable: boolean;
/** What the scheduler says is kept now: a job id for each thing said, and when the hours end. */
let kept: { jobIds: string[]; until: number } | null;
/** The automations those ids are: the reader's own, and another person's that reports to a chat that is not theirs. */
const JOBS: Record<string, unknown> = {
  mine: { id: "mine", owner: "web:u2", target: { gatewayId: "telegram:main", chatId: "900" }, delivery: { mode: "announce" } },
  theirs: { id: "theirs", owner: "web:u1", target: { gatewayId: "telegram:main", chatId: "901" }, delivery: { mode: "announce" } },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "quiet-hours-routes-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  role = "admin";
  saved = [];
  editable = true;
  kept = null;
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.timezone = "Asia/Jakarta";
  const settings = {
    setQuietHours: async (args: { hours: string; actor?: string }) => {
      saved.push(args);
      if (args.hours === "22:00-22:00") return { ok: false, error: "the two times are the same" };
      config.cron.quietHours = args.hours;
      return { ok: true, restartRequired: false };
    },
  };
  const deps = {
    ctx: { config, db },
    audit: new AuditLog(db),
    cron: { scheduler: { kept: () => kept }, store: { get: (id: string) => JOBS[id] ?? null } },
    get settings() {
      return editable ? settings : undefined;
    },
  } as unknown as ControlDeps;
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, { kind: "session", role, actor: "rina", user: { id: "u2", username: "rina", role } } as never);
    await next();
  });
  registerQuietHoursRoutes(app as never, deps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const read = async () => (await (await app.request("/policy/quiet-hours")).json()) as Record<string, unknown>;
const send = async (body: unknown) => {
  const res = await app.request("/policy/quiet-hours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("the install's quiet hours", () => {
  test("none set: read as no times, with the zone they would be in", async () => {
    expect(await read()).toEqual({ timeZone: "Asia/Jakarta", editable: true });
  });

  test("an admin saves two times, and is answered with what is in force", async () => {
    expect(await send({ from: "22:00", to: "07:00" })).toEqual({ status: 200, body: { ok: true, from: "22:00", to: "07:00", timeZone: "Asia/Jakarta", editable: true } });
    expect(saved).toEqual([{ hours: "22:00-07:00", actor: "rina" }]);
    expect(await read()).toEqual({ from: "22:00", to: "07:00", timeZone: "Asia/Jakarta", editable: true });
  });

  test("both null is none", async () => {
    await send({ from: "22:00", to: "07:00" });
    expect(await send({ from: null, to: null })).toEqual({ status: 200, body: { ok: true, timeZone: "Asia/Jakarta", editable: true } });
    expect(saved.at(-1)).toEqual({ hours: "", actor: "rina" });
  });

  test("anyone signed in reads them; only an admin sets them", async () => {
    await send({ from: "22:00", to: "07:00" });
    for (const who of ["operator", "viewer"] as const) {
      role = who;
      expect({ who, read: await read() }).toEqual({ who, read: { from: "22:00", to: "07:00", timeZone: "Asia/Jakarta", editable: true } });
      expect({ who, status: (await send({ from: "23:00", to: "06:00" })).status }).toEqual({ who, status: 403 });
    }
    expect(saved).toHaveLength(1);
  });

  test("half of it, or something that is not a time, is refused in words a person reads", async () => {
    for (const body of [{ from: "22:00" }, { from: "22:00", to: null }, { from: 22, to: 7 }, {}]) {
      const answer = await send(body);
      expect({ body, status: answer.status, plain: answer.body.plain }).toEqual({ body, status: 400, plain: "Nothing was saved. Check the two times, and try again." });
    }
    expect(saved).toEqual([]);
    expect(await send({ from: "22:00", to: "22:00" })).toMatchObject({ status: 400, body: { plain: "Nothing was saved. Check the two times: they must be different, and try again." } });
  });

  test("an install whose config cannot be edited says so", async () => {
    editable = false;
    expect(await read()).toEqual({ timeZone: "Asia/Jakarta", editable: false });
    expect((await send({ from: "22:00", to: "07:00" })).status).toBe(501);
  });
});

describe("what is kept now", () => {
  const UNTIL = 1_800_000_000_000;

  test("nothing kept: nothing said of it", async () => {
    expect(await read()).not.toHaveProperty("kept");
    kept = { jobIds: [], until: UNTIL };
    expect(await read()).not.toHaveProperty("kept");
  });

  test("an admin is told how many things are kept, everyone's, and when they are sent", async () => {
    kept = { jobIds: ["mine", "theirs", "theirs"], until: UNTIL };
    expect((await read()).kept).toEqual({ count: 3, until: UNTIL });
  });

  test("an operator is told of their own automations' alone: another person's are not theirs to learn of, by a number either", async () => {
    role = "operator";
    kept = { jobIds: ["mine", "theirs", "theirs", "mine"], until: UNTIL };
    expect((await read()).kept).toEqual({ count: 2, until: UNTIL });
    kept = { jobIds: ["theirs"], until: UNTIL };
    expect(await read()).not.toHaveProperty("kept");
  });

  test("a line whose automation is gone is nobody's to count", async () => {
    kept = { jobIds: ["deleted"], until: UNTIL };
    expect(await read()).not.toHaveProperty("kept");
  });

  test("a save answers with it too, as a read does", async () => {
    kept = { jobIds: ["mine"], until: UNTIL };
    expect((await send({ from: "22:00", to: "07:00" })).body.kept).toEqual({ count: 1, until: UNTIL });
  });
});
