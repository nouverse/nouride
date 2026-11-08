/**
 * Whether a webhook can arrive from the internet (0.8.0): local network only, reachable, or
 * unknown — and the test that tells them apart, sent through the public address and counted by the hook route
 * without running the job.
 *
 * Before this the Webhooks page said nothing, and a box behind a home router waited for GitHub calls that never came.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { Job, ReachTest } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import type { CronScheduler } from "@/modules/cron/scheduler.ts";
import { mountHooks } from "@/modules/web/hooks.ts";
import { HookTests, TEST_HEADER, hookReach, sendReachTest } from "@/modules/web/hook-reach.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const PUBLIC = { publicUrl: "https://box.example.com", host: "0.0.0.0", port: 18254 };
const URL_OF = (token: string) => `https://box.example.com/hooks/${token}`;
const tested = (overrides: Partial<ReachTest> = {}): ReachTest => ({ url: URL_OF("tok"), at: 1, arrived: true, detail: "arrived in 40 ms", ...overrides });

describe("where a hook stands", () => {
  const hook = (reachTest?: ReachTest): Pick<Job, "webhookToken" | "reachTest"> => ({ webhookToken: "tok", ...(reachTest ? { reachTest } : {}) });

  test("with no public address set, only this network can call it", () => {
    const reach = hookReach({ publicUrl: "", host: "0.0.0.0", port: 18254 }, hook(tested()));
    expect(reach.state).toBe("local");
    expect(reach.why).toContain("No public address is set");
  });

  test("a public address on this network is local too — an address, or a name that never resolves outside", () => {
    for (const publicUrl of ["http://192.168.0.10:18254", "http://10.0.0.5", "http://[fd12::1]", "http://nouride.local", "http://box.lan", "http://nouride", "http://box.home.arpa"]) {
      expect(hookReach({ ...PUBLIC, publicUrl }, hook()).state).toBe("local");
    }
  });

  test("a test through the public address that arrived makes it reachable, and says how it went", () => {
    const reach = hookReach(PUBLIC, hook(tested()));
    expect(reach.state).toBe("internet");
    expect(reach.why).toContain("arrived in 40 ms");
  });

  test("a test that did not arrive leaves it unknown, with what happened", () => {
    const reach = hookReach(PUBLIC, hook(tested({ arrived: false, detail: "The name box.example.com does not resolve." })));
    expect(reach.state).toBe("unknown");
    expect(reach.why).toContain("does not resolve");
  });

  test("a test of another address says nothing — the token was rotated, or the public address changed", () => {
    const reach = hookReach(PUBLIC, hook(tested({ url: URL_OF("old-token") })));
    expect(reach.state).toBe("unknown");
    expect(reach.why).toContain("Not tested yet");
    expect(reach.test).toBeUndefined();
  });
});

describe("the test, end to end", () => {
  let dir = "";
  let db: SqliteDb;
  let store: CronStore;
  let hooks: Hono;
  let runs: string[];
  let job: Job;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hook-reach-"));
    db = openDatabase(join(dir, "t.db"));
    await migrate(db);
    store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "UTC" });
    job = store.create({
      agentId: "nouva",
      name: "github",
      trigger: { kind: "webhook" },
      payload: { kind: "agentTurn", message: "look" },
      target: { gatewayId: "telegram:main", chatId: "1" },
      createdBy: "tester",
    });
    runs = [];
    hooks = new Hono();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The hook route on `hooks`, sharing `tests`; the scheduler records what it would have run. */
  function mount(tests: HookTests): void {
    const scheduler = {
      isRunning: () => false,
      runNow: async (id: string) => {
        runs.push(id);
        return { status: "success" };
      },
    } as unknown as CronScheduler;
    mountHooks(hooks, { cron: { store, scheduler }, tests });
  }

  /** A `fetch` that is the internet reaching this daemon: every request lands on the hook route. */
  const throughTheInternet = (url: string | URL | Request, init?: RequestInit) => hooks.request(new URL(String(url)).pathname, init);

  test("a test that arrives is counted, answered, and never runs the job", async () => {
    const tests = new HookTests({ fetch: throughTheInternet as typeof fetch });
    mount(tests);
    const result = await sendReachTest(tests, PUBLIC, job);
    expect(result.arrived).toBe(true);
    expect(result.url).toBe(URL_OF(job.webhookToken!));
    expect(result.detail).toMatch(/^arrived in \d+ ms$/);
    expect(runs).toEqual([]);
  });

  test("a word this daemon did not hand out is refused, and does not run the job either", async () => {
    mount(new HookTests());
    const res = await hooks.request(`/hooks/${job.webhookToken}`, { method: "POST", headers: { [TEST_HEADER]: "made-up" }, body: "{}" });
    expect(res.status).toBe(400);
    expect(runs).toEqual([]);
  });

  test("a word handed out for another hook does not count for this one", async () => {
    const tests = new HookTests();
    mount(tests);
    const word = tests.expect("cron_another");
    const res = await hooks.request(`/hooks/${job.webhookToken}`, { method: "POST", headers: { [TEST_HEADER]: word }, body: "{}" });
    expect(res.status).toBe(400);
    expect(tests.take(word)).toBe(false);
  });

  test("something else answering the address is not arriving, and says what answered", async () => {
    const tests = new HookTests({ fetch: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch });
    mount(tests);
    const result = await sendReachTest(tests, PUBLIC, job);
    expect(result.arrived).toBe(false);
    expect(result.detail).toContain("box.example.com answered 404");
    expect(result.detail).toContain("never reached Nouride");
  });

  test("a redirect is somebody else's answer, named, and not followed", async () => {
    let redirect: RequestInit["redirect"];
    const tests = new HookTests({
      fetch: (async (_url: string, init?: RequestInit) => {
        redirect = init?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://login.example.com/" } });
      }) as unknown as typeof fetch,
    });
    mount(tests);
    const result = await sendReachTest(tests, PUBLIC, job);
    expect(redirect).toBe("manual");
    expect(result.arrived).toBe(false);
    expect(result.detail).toContain("a redirect to https://login.example.com/");
  });

  test("no answer at all says why in words, and that a box may not reach its own public address", async () => {
    // A name that does not resolve is no router's doing: the live box's was known only to its own network's DNS.
    const failing = (error: object) => new HookTests({ fetch: (async () => Promise.reject(Object.assign(new TypeError("failed"), error))) as unknown as typeof fetch });
    const dns = await sendReachTest(failing({ code: "ENOTFOUND" }), PUBLIC, job);
    expect(dns.detail).toContain("The name box.example.com does not resolve. The internet most likely cannot find it either");
    expect(dns.detail).toContain("Give it a public record, or set public_url to a tunnel's address.");
    expect(dns.detail).not.toContain("cannot reach its own public address");
    const refused = await sendReachTest(failing({ code: "ECONNREFUSED" }), PUBLIC, job);
    expect(refused.detail).toContain("box.example.com refused the connection");
    expect(refused.detail).toContain("cannot reach its own public address");
    const slow = await sendReachTest(failing({ name: "TimeoutError" }), PUBLIC, job);
    expect(slow.detail).toContain("Nothing answered at box.example.com within 15 seconds");
  });

  describe("POST /webhooks/:id/test", () => {
    const TOKEN = "control-token-for-tests-0000000000";

    function control(publicUrl: string): Hono {
      const tests = new HookTests({ fetch: throughTheInternet as typeof fetch });
      mount(tests);
      const config = structuredClone(DEFAULT_CONFIG);
      config.dashboard.publicUrl = publicUrl;
      const app = new Hono();
      mountControlRoutes(app, {
        ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
        token: TOKEN,
        audit: new AuditLog(db),
        users: new UserStore({ db }),
        files: {},
        cron: { store, scheduler: {}, timezone: "UTC", tests },
        registry: { get: () => ({ dir: "/packs/nouva", config: {} }), reload: async () => {} },
      } as unknown as ControlDeps);
      return app;
    }
    const post = (app: Hono, id: string) =>
      app.request(`/api/control/webhooks/${id}/test`, { method: "POST", headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });

    test("a test that arrives is kept on the hook, and the hook reads as reachable — after a reload too", async () => {
      const app = control(PUBLIC.publicUrl);
      const res = await post(app, job.id);
      expect(res.status).toBe(200);
      const { webhook } = (await res.json()) as { webhook: { reach: { state: string } } };
      expect(webhook.reach.state).toBe("internet");
      expect(store.get(job.id)?.reachTest?.arrived).toBe(true);
      const listed = (await (await app.request("/api/control/webhooks", { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" })).json()) as { webhooks: { reach: { state: string } }[] };
      expect(listed.webhooks[0]?.reach.state).toBe("internet");
      expect(runs).toEqual([]);
    });

    test("with no public address there is nowhere outside to test through, and it says so", async () => {
      const res = await post(control(""), job.id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("no public address is set");
    });

    test("a paused hook is not tested: it answers nobody, and that would read as unreachable", async () => {
      store.setEnabled(job.id, false, "tester");
      const res = await post(control(PUBLIC.publicUrl), job.id);
      expect(res.status).toBe(409);
      expect(store.get(job.id)?.reachTest).toBeUndefined();
    });
  });
});
