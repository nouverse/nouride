/**
 * A script through the control API: the dashboard's editor and `nouride cron add --steps` both come this way. Held
 * here: that a script is read from what a caller sends and kept, that who wrote it is the caller and never a name the
 * caller sent, that a script which could not run on this machine is refused before anything is saved, when a job is
 * made and when one is changed, and that how long a job lasts is read while when it ends is not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { Job, JobStep } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import type { ScriptFacts } from "@/modules/cron/scripts.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;
let store: CronStore;
let facts: ScriptFacts;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cron-script-route-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  store = new CronStore({ db, config: config.cron, timezone: "Asia/Jakarta" });
  facts = { secrets: () => ["notion_token"], hasProgram: async (_agent, program) => program === "sh" };
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    files: {},
    cron: { store, scheduler: {}, timezone: "Asia/Jakarta", scripts: facts },
    registry: { get: (id: string) => (id === "nouva" ? { dir: "/packs/nouva", config: {} } : undefined), reload: async () => {} },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  app.request(`/api/control${path}`, { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }, { clientAddress: "203.0.113.10" });

const script = (text: string, more: Record<string, unknown> = {}) => ({ kind: "command", argv: ["sh"], script: { text, about: "Saves the summary", ...more } });
const body = (steps: unknown[], more: Record<string, unknown> = {}) => ({ agentId: "nouva", name: "morning", every: "10m", payload: { kind: "steps", steps }, target: { gatewayId: "telegram:nouva", chatId: "1" }, ...more });
const stepsOf = (job: Job): JobStep[] => (job.payload as { steps: JobStep[] }).steps;
const said = async (response: Response) => (await response.json()) as { error?: string; plain?: string; job?: Job };

describe("a script through the control API", () => {
  test("it is kept as sent, and whoever sent it wrote it: a name in the request is not read", async () => {
    const made = await post("/cron", body([{ kind: "agentTurn", message: "Sum up." }, script("cat > /dev/null; echo saved", { by: "agent:nouva", secrets: ["notion_token"] })]));
    expect(made.status).toBe(200);
    const saved = stepsOf(store.list()[0]!)[1] as Extract<JobStep, { kind: "command" }>;
    expect(saved.argv).toEqual(["sh"]);
    expect(saved.script).toMatchObject({ text: "cat > /dev/null; echo saved", about: "Saves the summary", secrets: ["notion_token"] });
    expect(saved.script!.by).toBeDefined();
    expect(saved.script!.by).not.toBe("agent:nouva");
  });

  test("a job that is one script is read the same way", async () => {
    const made = await post("/cron", { agentId: "nouva", name: "one", every: "10m", payload: { kind: "command", argv: ["sh"], script: { text: "date", about: "Says the time" }, then: "deliver" }, target: { gatewayId: "telegram:nouva", chatId: "1" } });
    expect(made.status).toBe(200);
    expect(store.list()[0]!.payload).toMatchObject({ kind: "command", argv: ["sh"], script: { text: "date", about: "Says the time" }, then: "deliver" });
  });

  test("a program that is not on this machine is refused before anything is saved, in the page's words too", async () => {
    const refused = await post("/cron", body([{ kind: "command", argv: ["python3"], script: { text: "print(1)", about: "Counts" } }]));
    expect(refused.status).toBe(400);
    const answer = await said(refused);
    expect(answer.error).toBe("step 1: `python3` is not on this machine for nouva's commands, so the script could not run: write it for a program that is (`sh` always is), or install that one.");
    expect(answer.plain).toContain("the steps");
    expect(store.list()).toEqual([]);
  });

  test("a change to a script is asked of the machine again, and a refused one leaves the job as it was", async () => {
    const made = await said(await post("/cron", body([script("echo one")])));
    const changed = await post(`/cron/${made.job!.id}`, { payload: { kind: "steps", steps: [{ id: "s1", kind: "command", argv: ["bun"], script: { text: "console.log(2)", about: "Counts" } }] } });
    expect(changed.status).toBe(400);
    expect((await said(changed)).error).toContain("`bun` is not on this machine");
    expect(stepsOf(store.list()[0]!)[0]).toMatchObject({ argv: ["sh"], script: { text: "echo one" } });
    // One the machine can run is saved.
    expect((await post(`/cron/${made.job!.id}`, { payload: { kind: "steps", steps: [{ id: "s1", ...script("echo two") }] } })).status).toBe(200);
    expect(stepsOf(store.list()[0]!)[0]).toMatchObject({ script: { text: "echo two" } });
  });

  test("a secret its agent does not hold is refused by name", async () => {
    const refused = await post("/cron", body([script("echo", { secrets: ["gh_token"] })]));
    expect(refused.status).toBe(400);
    expect((await said(refused)).error).toBe("step 1: the script names `gh_token`, which nouva's commands are not handed: an admin adds a secret to an agent on its page.");
  });

  test("a webhook that would run a script is asked the same", async () => {
    const refused = await post("/webhooks", { agentId: "nouva", name: "hook", payload: { kind: "steps", steps: [{ kind: "command", argv: ["ruby"], script: { text: "puts 1", about: "Counts" } }] }, target: { gatewayId: "telegram:nouva", chatId: "1" } });
    expect(refused.status).toBe(400);
    expect((await said(refused)).error).toContain("`ruby` is not on this machine");
    expect(store.list({ includeDisabled: true })).toEqual([]);
  });
});

describe("how long a job lasts, through the control API", () => {
  test("the length is read, and when it ends is the daemon's to write whatever the request said", async () => {
    const before = Date.now();
    const made = await post("/cron", body([script("echo")], { delivery: { mode: "announce", once: true, lasts: 3_600_000, endsAt: 1 } }));
    expect(made.status).toBe(200);
    const delivery = store.list()[0]!.delivery;
    expect(delivery).toMatchObject({ mode: "announce", once: true, lasts: 3_600_000 });
    expect(delivery.endsAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  test("a length a job on no clock cannot have is refused as when it runs", async () => {
    const refused = await post("/cron", { agentId: "nouva", name: "by hand", manual: true, payload: { kind: "systemEvent", text: "hi" }, target: { gatewayId: "telegram:nouva", chatId: "1" }, delivery: { mode: "announce", lasts: 3_600_000 } });
    expect(refused.status).toBe(400);
    const answer = await said(refused);
    expect(answer.error).toContain("only a job that runs again and again on a clock can last a set time");
    expect(answer.plain).toContain("when it runs");
  });
});
