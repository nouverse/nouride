/**
 * Whose an automation is, and whose a mission is (`Job.owner`, `Mission.owner`): a person, as People writes an id.
 *
 * Every account read and changed every one of them, and who made one was recorded in four spellings, none the form
 * People reads: a username, an account's bare id, a sender's bare id, `agent:<id>`. So an owner is written where one
 * is made, turned on or started, and filled once for those from before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { ownerIdentity, type CronSection } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { proposalFor, turnOnProposal } from "@/modules/cron/proposals.ts";
import { newMission, type StartRequest } from "@/modules/missions/start.ts";

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 1000,
  maxJobs: 20,
  runRetentionDays: 14,
  catchupWindowMs: 60_000,
  failStreakLimit: 3,
  quietHours: "",
  unattendedApproval: "auto",
  commandTimeoutMs: 5000,
};

let dir: string;
let db: SqliteDb;
let store: CronStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-tmp-owner-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  store = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => Date.parse("2026-11-13T00:00:00Z") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (over: Partial<JobInput> = {}): JobInput => ({
  agentId: "nouva",
  name: "morning",
  trigger: { kind: "every", everyMs: 60_000 },
  payload: { kind: "systemEvent", text: "ping" },
  target: { gatewayId: "telegram:nouva", chatId: "814" },
  createdBy: "gading",
  ...over,
});

describe("the identity an owner is kept as", () => {
  test("the platform and the sender's id there, as People writes one", () => {
    expect(ownerIdentity("telegram:nouva", "814")).toBe("telegram:814");
    expect(ownerIdentity("web:dashboard", "u1")).toBe("web:u1");
    expect(ownerIdentity("discord:nero", " 5823 ")).toBe("discord:5823");
  });

  test("nothing for a sender that is no person: the command line, the daemon, an agent, nobody", () => {
    for (const sender of ["cli", "agent:nix", "nouride:system", "", "  ", null, undefined]) expect(ownerIdentity("telegram:nouva", sender)).toBeUndefined();
  });
});

describe("a job's owner", () => {
  test("the account that made it; one made with none is nobody's", () => {
    expect(store.create(input({ owner: "web:u1" })).owner).toBe("web:u1");
    const cli = store.create(input({ name: "from the command line", createdBy: "cli" }));
    expect(cli.owner).toBeUndefined();
    expect(store.get(cli.id)?.owner).toBeUndefined();
  });

  test("a proposal is nobody's, whatever it was made with, until a person turns it on: then theirs", () => {
    const proposal = proposalFor("nouva", { gatewayId: "telegram:nouva", chatId: "814", senderId: "814" }, 1);
    const proposed = store.create(input({ createdBy: "agent:nouva", owner: "web:u9", proposal }));
    expect(proposed.owner).toBeUndefined();

    const turned = turnOnProposal(store, proposed.id, { actor: "Gading", as: "814", owner: "telegram:814" });
    expect("job" in turned && turned.job.owner).toBe("telegram:814");
    expect("job" in turned && turned.job.turnedOnBy).toBe("814");
    expect("job" in turned && turned.job.enabled).toBe(true);
  });

  test("turned on by someone who is no person, it stays nobody's", () => {
    const proposed = store.create(input({ createdBy: "agent:nouva", proposal: proposalFor("nouva", { gatewayId: "telegram:nouva", chatId: "814", senderId: "814" }, 1) }));
    const turned = turnOnProposal(store, proposed.id, { actor: "cli", as: "cli" });
    expect("job" in turned && turned.job.owner).toBeUndefined();
  });

  test("a change another person turns on leaves the job its owner's; it runs as whoever said yes", () => {
    const rinas = store.create(input({ owner: "web:u2", createdBy: "rina" }));
    const change = store.create(
      input({ name: "morning, later", createdBy: "agent:nouva", proposal: proposalFor("nouva", { gatewayId: "telegram:nouva", chatId: "814", senderId: "814" }, 1, rinas.id) }),
    );
    const turned = turnOnProposal(store, change.id, { actor: "Gading", as: "814", owner: "telegram:814" });
    expect("job" in turned && turned.job.id).toBe(rinas.id);
    expect("job" in turned && turned.job.owner).toBe("web:u2");
    expect("job" in turned && turned.job.turnedOnBy).toBe("814");
    expect("job" in turned && turned.job.name).toBe("morning, later");
  });

  test("handed to a person, and to nobody, by its id", () => {
    const job = store.create(input({ createdBy: "cli" }));
    expect(store.setOwner(job.id, "web:u2", "gading")?.owner).toBe("web:u2");
    expect(store.setOwner(job.id, null, "gading")?.owner).toBeUndefined();
    expect(store.setOwner("cron_missing", "web:u2", "gading")).toBeNull();
  });
});

describe("a mission's owner", () => {
  const at = { id: "msn_1", settings: { perAgent: 1, maxRunning: 2, limitHours: 8, limitTurns: 50, limitTokens: 1_000 }, privateDir: "/tmp/x", now: 1 };
  const request = (over: Partial<StartRequest> = {}): StartRequest => ({ agentId: "nouva", goal: "Ship it", startedBy: "814", gatewayId: "telegram:nouva", chatId: "814", ...over });

  test("whoever started it: a sender in a chat, an account on the dashboard", () => {
    expect(newMission(request(), at).owner).toBe("telegram:814");
    expect(newMission(request({ startedBy: "u1", gatewayId: "web:dashboard", chatId: "missions" }), at).owner).toBe("web:u1");
  });

  test("nobody's from the command line", () => {
    expect(newMission(request({ startedBy: "cli", gatewayId: "web:dashboard", chatId: "missions" }), at).owner).toBeNull();
  });

  test("said outright, it is that and not whoever it runs as: an automation's owner, an automation nobody owns, a parent's", () => {
    // A job's mission runs as whoever turned the job on, by a bare id or a username, and reports to the job's chat.
    expect(newMission(request({ startedBy: "gading", owner: "web:u1", jobId: "cron_1" }), at).owner).toBe("web:u1");
    expect(newMission(request({ startedBy: "gading", owner: null, jobId: "cron_1" }), at).owner).toBeNull();
    // Started from the dashboard to report to a chat on a chat app: the account's, not that platform's.
    expect(newMission(request({ startedBy: "u1", owner: "web:u1" }), at).owner).toBe("web:u1");
  });
});

describe("the ones from before", () => {
  test("a database of the schema before comes up with each job and mission owned, or nobody's", async () => {
    const old = openDatabase(join(dir, "old.db"));
    try {
      await migrate(old, {}, MIGRATIONS.filter((one) => one.version <= 85));
      expect(old.prepare<{ name: string }>("SELECT name FROM pragma_table_info('cron_jobs')").all().map((column) => column.name)).not.toContain("owner");
      old.prepare("INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1', 'gading', 'x', 'admin', 1, 1), ('u2', 'rina', 'x', 'operator', 1, 1)").run();
      const job = old.prepare(
        `INSERT INTO cron_jobs (id, agent_id, name, enabled, schedule, payload, created_at, target_gateway_id, target_chat_id, session, created_by, turned_on_by, proposal)
         VALUES (?, 'nouva', ?, 1, '{"kind":"every","everyMs":60000}', '{"kind":"systemEvent","text":"x"}', 1, ?, '814', 'fresh', ?, ?, ?)`,
      );
      // Made on the dashboard by an account; by one that is gone; from the command line; by the daemon.
      job.run("cron_dash", "dash", "telegram:nouva", "gading", null, null);
      job.run("cron_gone", "gone", "telegram:nouva", "budi", null, null);
      job.run("cron_cli", "cli", "telegram:nouva", "cli", null, null);
      job.run("cron_restart", "restart", "telegram:nouva", "restart", null, null);
      // Proposed by an agent and turned on: in its chat, on the dashboard, from the command line; and not yet.
      job.run("cron_chat", "chat", "telegram:nouva", "agent:nouva", "814", null);
      job.run("cron_page", "page", "telegram:nouva", "agent:nouva", "u2", null);
      job.run("cron_byline", "byline", "telegram:nouva", "agent:nouva", "cli", null);
      job.run("cron_waiting", "waiting", "telegram:nouva", "agent:nouva", null, '{"by":"nouva","gatewayId":"telegram:nouva","chatId":"814","for":"814","at":1}');

      const mission = old.prepare(
        `INSERT INTO missions (id, agent_id, started_by, gateway_id, chat_id, goal, status, workdir, limit_hours, limit_turns, limit_tokens, created_at, updated_at, job_id, parent_id)
         VALUES (?, 'nouva', ?, ?, ?, 'goal', 'done', '/tmp/x', 8, 50, 1000, 1, 1, ?, ?)`,
      );
      mission.run("msn_page", "u1", "web:dashboard", "missions", null, null);
      mission.run("msn_chat", "814", "telegram:nouva", "814", null, null);
      mission.run("msn_discord", "5823", "discord:nero", "1534", null, null);
      mission.run("msn_cli", "cli", "web:dashboard", "missions", null, null);
      // From the dashboard: by an account's username, as an older build wrote it; to report to a chat on a chat app; by
      // an account that is gone; under a word that is no account's.
      mission.run("msn_username", "Gading", "web:dashboard", "missions", null, null);
      mission.run("msn_page_to_chat", "u2", "telegram:nouva", "814", null, null);
      mission.run("msn_gone", "u9", "web:dashboard", "missions", null, null);
      mission.run("msn_word", "dashboard", "web:dashboard", "missions", null, null);
      // A job's: it ran as a username, which is no id on the job's platform. Its job's owner; and its child's.
      mission.run("msn_job", "gading", "telegram:nouva", "814", "cron_dash", null);
      mission.run("msn_child", "gading", "telegram:nouva", "814", null, "msn_job");
      mission.run("msn_nobodys_job", "cli", "telegram:nouva", "814", "cron_cli", null);

      await migrate(old);

      const owners = (table: string) => Object.fromEntries(old.prepare<{ id: string; owner: string | null }>(`SELECT id, owner FROM ${table} ORDER BY id`).all().map((row) => [row.id, row.owner]));
      expect(owners("cron_jobs")).toEqual({
        cron_byline: null,
        cron_chat: "telegram:814",
        cron_cli: null,
        cron_dash: "web:u1",
        cron_gone: null,
        cron_page: "web:u2",
        cron_restart: null,
        cron_waiting: null,
      });
      expect(owners("missions")).toEqual({
        msn_chat: "telegram:814",
        msn_child: "web:u1",
        msn_cli: null,
        msn_discord: "discord:5823",
        msn_gone: null,
        msn_job: "web:u1",
        msn_nobodys_job: null,
        msn_page: "web:u1",
        msn_page_to_chat: "web:u2",
        msn_username: "web:u1",
        msn_word: null,
      });
    } finally {
      old.close();
    }
  });
});
