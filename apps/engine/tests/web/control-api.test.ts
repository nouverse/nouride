/**
 * The control API, over HTTP, through the guard.
 *
 * This file exists because there was nothing here. Roughly twenty route modules under
 * `modules/web/control/routes/`, the whole contract the dashboard is written against, and not one
 * test that went through `mountControlRoutes` with a real guard and a real principal —
 * `hooks.test.ts` mounts the *webhook* endpoint, `chat-files.test.ts` mounts a bare Hono for one
 * handler. On 2026-09-06 four defects reached production in one session and all four were found by
 * the operator; three more did on 2026-09-09, and the same was true of those.
 *
 * So what is tested here is the part no unit test can see: **who gets in, what they may do once
 * they are in, and what the daemon says when the answer is no.** Those are properties of the
 * middleware and the route together, and they are the ones that fail quietly — a 403 that should
 * have been a 401, an admin-only route that answers an operator, a rate limit that locks out the
 * person it protects.
 *
 * The deps are the smallest set that boots: `mountControlRoutes` demands seven and every other
 * field is optional, which is what makes this possible at all. A route needing something absent
 * answers 501 by design, and a test for such a route says so rather than filling the field in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { FileService } from "@/modules/setup/files.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import type { AgentRegistry } from "@nouride/persona";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { cheapPasswords } from "../helpers.ts";

const CONTROL_TOKEN = "control-token-for-tests-0000000000";
const ADMIN_PASSWORD = "admin-password-1";
const VIEWER_PASSWORD = "viewer-password-1";
const OPERATOR_PASSWORD = "operator-password-1";

let dir: string;
let db: SqliteDb;
let users: UserStore;
let audit: AuditLog;
let app: Hono;

/**
 * A daemon context with only what the routes under test read.
 *
 * Cast rather than constructed: the real one owns a gateway map, a provider error map and a
 * `DaemonStatus`, none of which the auth and guard paths touch. Filling them in would make this
 * fixture look like a claim about the whole daemon, which it is not.
 */
function context(): DaemonContext {
  return {
    config: {},
    db,
    gateways: new Map(),
    startedAt: Date.now(),
    configSource: null,
    status: "ready",
    agentCount: 0,
    providerErrors: new Map(),
  } as unknown as DaemonContext;
}

function deps(): ControlDeps {
  return {
    ctx: context(),
    token: CONTROL_TOKEN,
    audit,
    users,
    /**
     * Present, so the admin-only rule on `POST /config` is what a test exercises.
     *
     * Without it the route answers 501 — the capability check runs before the authorization check —
     * and a test asserting 403 would have been asserting "this daemon has no file editing" while
     * appearing to assert a permission. Found by writing that test and reading why it failed.
     */
    files: new FileService({
      agentsDir: join(dir, "agents"),
      configPath: join(dir, "config.toml"),
      registry: { get: () => undefined, reload: async () => {} } as unknown as AgentRegistry,
      config: DEFAULT_CONFIG,
    }),
    // The four the mount requires and these tests never reach. A route that used one would fail
    // loudly on a property of `undefined` rather than passing on a fake that answered wrongly.
    pipeline: undefined,
    registry: undefined,
    providers: undefined,
    approvals: undefined,
  } as unknown as ControlDeps;
}

/** A request with an address, because the login limiter counts per address and a test has none. */
async function request(
  path: string,
  init: RequestInit = {},
  address: string | null = "203.0.113.10",
): Promise<Response> {
  return await app.request(`/api/control${path}`, init, { clientAddress: address });
}

async function login(
  username: string,
  password: string,
  address?: string | null,
): Promise<Response> {
  return await request(
    "/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    address,
  );
}

/** The `set-cookie` a successful login returned, ready to send back as `cookie`. */
function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-control-api-"));
  db = openDatabase(join(dir, "test.db"));
  await migrate(db);
  users = new UserStore({ passwords: cheapPasswords, db });
  audit = new AuditLog(db);
  await users.create({ username: "admin", password: ADMIN_PASSWORD, role: "admin", createdBy: "test" });
  await users.create({ username: "opal", password: OPERATOR_PASSWORD, role: "operator", createdBy: "test" });
  await users.create({ username: "vera", password: VIEWER_PASSWORD, role: "viewer", createdBy: "test" });

  app = new Hono();
  mountControlRoutes(app, deps());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("who gets in", () => {
  test("no credential is a 401, on a route that exists", async () => {
    const res = await request("/auth/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a wrong control token is a 401 and not a thrown request", async () => {
    /**
     * `identify` compares buffers, and `timingSafeEqual` throws on a length mismatch rather than
     * answering false. A token of the wrong length has to be rejected, not turned into a 500 — and
     * a multibyte header can match the expected *string* length while being longer in bytes.
     */
    for (const bad of ["", "short", `${CONTROL_TOKEN}x`, "é".repeat(CONTROL_TOKEN.length)]) {
      const res = await request("/auth/me", { headers: { "x-nouride-token": bad } });
      expect(res.status).toBe(401);
    }
  });

  test("the control token is an admin, and reports itself as not a person", async () => {
    const res = await request("/auth/me", { headers: { "x-nouride-token": CONTROL_TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "token", role: "admin", actor: "cli", user: null });
  });

  test("a session cookie is the person who logged in", async () => {
    const signedIn = await login("admin", ADMIN_PASSWORD);
    expect(signedIn.status).toBe(200);

    const res = await request("/auth/me", { headers: { cookie: cookieFrom(signedIn) } });
    expect(await res.json()).toMatchObject({ kind: "user", role: "admin", actor: "admin" });
  });

  test("a made-up session cookie is a 401", async () => {
    const res = await request("/auth/me", { headers: { cookie: "nouride_session=not-a-session" } });
    expect(res.status).toBe(401);
  });

  test("the two public paths need no credential, and nothing else does", async () => {
    // `/setup/state` answers three booleans: an unconfigured instance is not a secret, and the
    // alternative is a browser that cannot tell a fresh install from a locked one.
    expect((await request("/setup/state")).status).not.toBe(401);
    expect((await login("admin", "wrong-password")).status).toBe(401);

    // A sample from the rest of the surface. Every one of these is behind the guard.
    for (const path of ["/status", "/agents", "/users", "/sessions", "/cron", "/webhooks", "/config"]) {
      expect((await request(path)).status).toBe(401);
    }
  });
});

describe("what a role may do", () => {
  test("a viewer may read and may not write, decided on the method", async () => {
    const cookie = cookieFrom(await login("vera", VIEWER_PASSWORD));

    const read = await request("/auth/me", { headers: { cookie } });
    expect(read.status).toBe(200);

    // Enforced on the method rather than a route list, so a route added later is read-only to a
    // viewer by default. This asserts the default, not one route's rule.
    const write = await request("/config", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: "forbidden" });
  });

  test("an operator gets past the guard and is still refused an admin-only route", async () => {
    /**
     * The distinction that matters, and the one a method-based rule cannot make: the daemon's own
     * config decides who may reach it and what every agent may run, so `POST /config` is admin-only
     * even though everything else in the file editor is not.
     */
    const cookie = cookieFrom(await login("opal", OPERATOR_PASSWORD));

    const res = await request("/config", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "admin only" });
  });

  test("a route whose dependency is absent says 501, not 500", async () => {
    /**
     * Most of `ControlDeps` is optional, and the contract is that a daemon without a subsystem
     * reports it rather than crashing. `cron` is absent here — a daemon with `[cron] enabled =
     * false` is exactly that shape, and it must answer the dashboard rather than throwing at it.
     */
    const res = await request("/webhooks", { headers: { "x-nouride-token": CONTROL_TOKEN } });
    expect(res.status).toBe(501);
    expect(await res.json()).toHaveProperty("error");
  });
});

describe("what no client calls is not served", () => {
  test("pruning every conversation before a moment, and saving a draft's edit without deciding, are gone", async () => {
    /**
     * Neither had a caller in the dashboard, the CLI or the Pro tree, nor a test: one bulk-deleted history, the
     * other wrote a draft, and both read like features no screen offers (`dash-dead-api-wrappers`). The neighbours
     * they sat beside stay — one conversation deleted by id, a draft's edits sent with its approval — and answer
     * here with 501, for the dependency this harness leaves out, which is how a 404 is known to mean "no route".
     */
    const asAdmin = { headers: { "x-nouride-token": CONTROL_TOKEN } };
    expect((await request("/sessions?before=1000", { method: "DELETE", ...asAdmin })).status).toBe(404);
    expect((await request("/skills/drafts/drf_1/edit", { method: "POST", ...asAdmin, body: "{}" })).status).toBe(404);
    expect((await request("/sessions/ses_1", { method: "DELETE", ...asAdmin })).status).toBe(501);
    expect((await request("/skills/drafts/drf_1/approve", { method: "POST", ...asAdmin, body: "{}" })).status).toBe(501);
  });
});

describe("signing in", () => {
  test("an unknown user and a wrong password are the same answer", async () => {
    // Two messages would turn this into a way to find out which accounts exist.
    const unknown = await login("nobody", "whatever-password");
    const wrong = await login("admin", "whatever-password");

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  test("a missing field is a 400 rather than a failed attempt", async () => {
    const res = await request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin" }),
    });
    expect(res.status).toBe(400);
  });

  test("the login is recorded, and so is the failure", async () => {
    await login("admin", ADMIN_PASSWORD);
    await login("admin", "wrong-password");

    // The buffer the *routes* wrote to. Creating a second `AuditLog` and stopping that one flushes
    // an empty buffer, which is how this test first passed nothing and claimed the writes were
    // missing — worth keeping as a comment, because the mistake is invisible in the assertion.
    audit.stop();
    const rows = db
      .prepare<{ action: string }>("SELECT action FROM audit_log ORDER BY timestamp")
      .all()
      .map((r) => r.action);
    expect(rows).toContain("login");
    expect(rows).toContain("login_failed");
  });
});

/**
 * The brake on the sign-in route.
 *
 * Two rules, and the test that matters most is the last one: a limiter keyed only by account is a
 * way for anyone who knows a username to lock its owner out, and the mitigation is that a correct
 * password costs nothing.
 */
describe("the login rate limit", () => {
  test("failures from one address are eventually refused", async () => {
    // The account rule is the tighter of the two (10 in 15 minutes), so it trips first.
    for (let i = 0; i < 10; i += 1) {
      expect((await login("admin", "wrong-password")).status).toBe(401);
    }

    const refused = await login("admin", "wrong-password");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // The message says what to do and nothing about whether the account exists.
    expect(((await refused.json()) as { error: string }).error).toContain("too many");
  });

  test("spraying across accounts from one address is caught by the address rule", async () => {
    /**
     * Why per-account alone is not enough: each of these accounts sees a single attempt, so no
     * account rule would ever trip. Thirty from one address is the ceiling.
     */
    let refusals = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = await login(`user-${i}`, "wrong-password");
      if (res.status === 429) refusals += 1;
    }
    expect(refusals).toBeGreaterThan(0);
  });

  test("one address's failures do not spend another's allowance", async () => {
    for (let i = 0; i < 40; i += 1) await login(`user-${i}`, "x-wrong", "198.51.100.7");
    expect((await login("user-99", "x-wrong", "198.51.100.7")).status).toBe(429);

    // A different office, a different bucket.
    expect((await login("user-99", "x-wrong", "203.0.113.99")).status).toBe(401);
  });

  test("the right password gets in even after the account has been hammered", async () => {
    /**
     * The property the whole design turns on. Somebody who knows a username can burn nine of its
     * ten attempts on purpose; the owner must still be able to sign in. Only being *wrong*
     * accumulates — a success is refunded on the address and cleared on the account.
     */
    for (let i = 0; i < 9; i += 1) {
      expect((await login("admin", "wrong-password")).status).toBe(401);
    }

    const ok = await login("admin", ADMIN_PASSWORD);
    expect(ok.status).toBe(200);

    // And the slate is clean afterwards, so the next honest mistake is not the last one allowed.
    for (let i = 0; i < 9; i += 1) {
      expect((await login("admin", "wrong-password")).status).toBe(401);
    }
  });
});

/**
 * The field the route dropped.
 *
 * Both dashboards send `allow_exec` when creating an agent — the first-run wizard with a toggle
 * defaulting to on, the new-agent form with one defaulting to off, under the words "For security,
 * chat gateways require a sender allowlist when enabled". This route read `id`, `display_name`,
 * `system_prompt`, `user_name`, `model`, `provider` and `auto_on`, and not that one. So the switch
 * decided nothing and every agent created from a browser got a shell.
 *
 * Tested here rather than only at the service, because the service has always been able to do the
 * right thing with a value it was never handed. This is the half that was broken.
 */
describe("an agent's preset, tools and default, from the dashboard", () => {
  function withSetup(): { seen: Record<string, unknown>[]; app: Hono } {
    const seen: Record<string, unknown>[] = [];
    const scoped = new Hono();
    mountControlRoutes(scoped, {
      ...deps(),
      setup: {
        createAgent: async (input: Record<string, unknown>) => (seen.push({ create: input }), { ok: true as const, id: String(input.id), provider: "openai" }),
        availableTools: () => ["read", "exec", "web_search"],
        setAgentTools: async (input: Record<string, unknown>) => (seen.push({ tools: input }), { ok: true as const }),
        setOrchestrator: async (input: Record<string, unknown>) => (seen.push({ orchestrator: input }), { ok: true as const }),
        setAgentAccess: async (input: Record<string, unknown>) => (seen.push({ access: input }), { ok: true as const }),
      },
    } as unknown as ControlDeps);
    return { seen, app: scoped };
  }
  const post = (scoped: Hono, path: string, body: unknown) =>
    scoped.request(`/api/control${path}`, { method: "POST", headers: { "x-nouride-token": CONTROL_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }, { clientAddress: "203.0.113.10" });

  test("the preset and a custom pick reach the service; a preset that does not exist does not", async () => {
    const { seen, app: scoped } = withSetup();
    await post(scoped, "/setup/agent", { id: "scout", display_name: "Scout", model: "gpt-4o", preset: "researcher" });
    await post(scoped, "/setup/agent", { id: "mine", display_name: "Mine", model: "gpt-4o", preset: "custom", tools: ["read", 7] });
    await post(scoped, "/setup/agent", { id: "odd", display_name: "Odd", model: "gpt-4o", preset: "wizard" });
    expect(seen.map((entry) => (entry.create as Record<string, unknown>).preset)).toEqual(["researcher", "custom", undefined]);
    expect((seen[1]!.create as Record<string, unknown>).tools).toEqual(["read"]);
  });

  test("tools and orchestrator reach their own routes, not the agent module's /agents/:id/:action", async () => {
    // Registered after them, `/agents/:id/:action` would read `tools` and `orchestrator` as actions and
    // answer "no agent" or an unknown action instead.
    const { seen, app: scoped } = withSetup();
    expect((await post(scoped, "/agents/nix/tools", { tools: ["read"] })).status).toBe(200);
    expect((await post(scoped, "/agents/nix/orchestrator", {})).status).toBe(200);
    expect(seen).toEqual([{ tools: { agentId: "nix", tools: ["read"], actor: "cli" } }, { orchestrator: { agentId: "nix", actor: "cli" } }]);
    expect((await post(scoped, "/agents/nix/tools", { tools: "read" })).status).toBe(400);
    expect((await post(scoped, "/agents/nix/access", { access: "allowlist" })).status).toBe(200);
    expect(seen.at(-1)).toEqual({ access: { agentId: "nix", access: "allowlist", actor: "cli" } });
    // `open` is never an agent's to choose: the daemon refuses it for any agent with exec.
    expect((await post(scoped, "/agents/nix/access", { access: "open" })).status).toBe(400);
  });

  test("an orchestrator refused for an agent that is there is a conflict; one that is not there, not found (0.8.10)", async () => {
    // An external agent's refusal came back 404 on the live box: "not found" for an agent the daemon had.
    const scoped = new Hono();
    mountControlRoutes(scoped, {
      ...deps(),
      registry: { get: (id: string) => (id === "nix" ? { config: { id: "nix", external: { cli: "claude-code" } } } : undefined), reload: async () => {} } as unknown as AgentRegistry,
      setup: { setOrchestrator: async (input: { agentId: string }) => ({ ok: false as const, error: input.agentId === "nix" ? "nix is an external agent: …" : `no agent "${input.agentId}"` }) },
    } as unknown as ControlDeps);
    const refused = await post(scoped, "/agents/nix/orchestrator", {});
    expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: "nix is an external agent: …", plain: "This agent cannot be the main agent. Nothing was changed." } });
    expect((await post(scoped, "/agents/ghost/orchestrator", {})).status).toBe(404);
  });

  test("the presets list what each gives on this daemon, and the tools grouped", async () => {
    const { app: scoped } = withSetup();
    const res = await scoped.request("/api/control/setup/presets", { headers: { "x-nouride-token": CONTROL_TOKEN } }, { clientAddress: "203.0.113.10" });
    const body = (await res.json()) as { presets: { id: string; tools: string[]; soul: string }[]; groups: { label: string; tools: string[] }[] };
    expect(body.presets.find((preset) => preset.id === "pilot")?.tools).toEqual(["read", "exec", "web_search"]);
    // Its starting SOUL, which the New Agent form fills in (0.8.1).
    expect(body.presets.find((preset) => preset.id === "researcher")?.soul).toContain("You are a careful researcher.");
    expect(body.presets.find((preset) => preset.id === "researcher")?.tools).toEqual(["read", "web_search"]);
    expect(body.groups.map((group) => group.label)).toEqual(["Files", "Terminal", "Web"]);
  });
});

describe("creating an agent from the dashboard", () => {
  function withSetup(): { seen: Record<string, unknown>[]; app: Hono } {
    const seen: Record<string, unknown>[] = [];
    const scoped = new Hono();
    mountControlRoutes(scoped, {
      ...deps(),
      setup: {
        createAgent: async (input: Record<string, unknown>) => {
          seen.push(input);
          return { ok: true as const, id: String(input.id), provider: "openai" };
        },
      },
    } as unknown as ControlDeps);
    return { seen, app: scoped };
  }

  async function create(scoped: Hono, body: Record<string, unknown>): Promise<Response> {
    return await scoped.request(
      "/api/control/setup/agent",
      {
        method: "POST",
        headers: { "x-nouride-token": CONTROL_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ id: "scribe", display_name: "Scribe", model: "gpt-4o", ...body }),
      },
      { clientAddress: "203.0.113.10" },
    );
  }

  test("`allow_exec: false` reaches the service, so the switch decides something", async () => {
    const { seen, app: scoped } = withSetup();
    expect((await create(scoped, { allow_exec: false })).status).toBe(200);
    expect(seen[0]?.allowExec).toBe(false);
  });

  test("and leaving it out says nothing, rather than saying no", async () => {
    // `nouride setup` does not send it. Turning silence into a refusal would take the shell away
    // from every first agent created at a terminal, which is not what anybody asked for.
    const { seen, app: scoped } = withSetup();
    expect((await create(scoped, {})).status).toBe(200);
    expect("allowExec" in (seen[0] ?? {})).toBe(false);
  });

  test("auto-approval is sent as a decision, not left to the route's default", async () => {
    /**
     * `auto_on` is read as `body.auto_on !== false`, so silence means yes — and the new-agent form
     * was silent. Every agent created there switched standing auto-approval on for the local
     * surface, and the screen said nothing about it. The switch is on that screen now, still
     * defaulting to on, so what changed is that it can be seen and turned off.
     *
     * Both positions asserted: a form that only ever sent `true` would satisfy the first line.
     */
    const { seen, app: scoped } = withSetup();
    expect((await create(scoped, { auto_on: false })).status).toBe(200);
    expect(seen[0]?.autoOn).toBe(false);

    expect((await create(scoped, { id: "scribe2", auto_on: true })).status).toBe(200);
    expect(seen[1]?.autoOn).toBe(true);
  });

  test("by an admin only — an operator gets past the guard and is refused, and nothing is made", async () => {
    // A new agent is made enabled, and could be given every tool and a coding CLI on the install's shared account,
    // while the provider and `answered-by` were already an admin's.
    const { seen, app: scoped } = withSetup();
    const cookie = cookieFrom(await login("opal", OPERATOR_PASSWORD));
    const res = await scoped.request(
      "/api/control/setup/agent",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ id: "scribe", display_name: "Scribe", model: "gpt-4o", tools: ["*"], external: { cli: "claude-code" } }),
      },
      { clientAddress: "203.0.113.10" },
    );
    expect({ status: res.status, body: await res.json(), made: seen.length }).toEqual({ status: 403, body: { error: "admin only" }, made: 0 });
    // An admin's — here the CLI's token — is made as before.
    expect((await create(scoped, {})).status).toBe(200);
  });

  test("the profile the dashboard chose is the profile the agent gets", async () => {
    // The other half of the same form. The daemon has always accepted `provider`; no dashboard sent
    // it, so a new agent landed on whichever profile resolved first and the model you typed had to
    // exist there.
    const { seen, app: scoped } = withSetup();
    expect((await create(scoped, { provider: "anthropic" })).status).toBe(200);
    expect(seen[0]?.provider).toBe("anthropic");
  });
});

/**
 * What the provider step is told about the gateway a `router` build carries.
 *
 * `sharedCredential` is the one field on this route that is a **boot** fact rather than a config
 * one, and it cannot be recomputed later: it is true only when the gateway came up in the same boot
 * that created this daemon's first account. Switching `[nougate] in_process` on afterwards leaves a
 * gateway holding a password of its own, and the wizard telling the operator to reuse Nouride's
 * would send them to a login form with a password that was never set there.
 */
describe("what `/setup/state` says about the bundled gateway", () => {
  async function state(overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
    const scoped = new Hono();
    const base = deps();
    mountControlRoutes(scoped, {
      ...base,
      ctx: { ...base.ctx, config: { nougate: { inProcess: true, port: 18256 } } },
      ...overrides,
    } as unknown as ControlDeps);
    const res = await scoped.request("/api/control/setup/state", {}, { ip: "10.0.0.1" });
    return (await res.json()) as Record<string, unknown>;
  }

  test("passes through which of the two ways the credential is shared", async () => {
    // Not a boolean. The wizard's sentence differs: an `INITIAL_ADMIN_*` password is one the reader
    // still holds, a generated one is the one they replaced on the way in.
    expect(await state({ sharedGatewayCredential: "environment" })).toMatchObject({
      bundledGateway: { available: true, baseUrl: "http://127.0.0.1:18256", sharedCredential: "environment" },
    });
    expect(await state({ sharedGatewayCredential: "generated" })).toMatchObject({
      bundledGateway: { sharedCredential: "generated" },
    });
  });

  test("says nothing when the gateway came up holding a password of its own", async () => {
    // Switching `[nougate] in_process` on after the first run. The field is absent rather than
    // false, and the wizard treats absent as "do not claim anything".
    const body = (await state({})).bundledGateway as Record<string, unknown>;
    expect(body).toEqual({ available: true, baseUrl: "http://127.0.0.1:18256" });
  });

  test("names where its dashboard and API are served through this one, and whether the page can show it", async () => {
    // The sign-in step needs only `mount` — the gateway's API, in the binary. The LLM Gateway page
    // also needs the bundle beside it, which an older update left behind.
    expect(await state({ llmGatewayMount: "/llm-gateway", llmGatewayDashboard: () => true })).toMatchObject({
      bundledGateway: { available: true, mount: "/llm-gateway", dashboard: true },
    });
    expect(await state({ llmGatewayMount: "/llm-gateway", llmGatewayDashboard: () => false })).toMatchObject({
      bundledGateway: { mount: "/llm-gateway", dashboard: false },
    });
  });

  test("no mount, no promise of one", async () => {
    const body = (await state({ llmGatewayDashboard: () => true })).bundledGateway as Record<string, unknown>;
    expect(body.mount).toBeUndefined();
    expect(body.dashboard).toBeUndefined();
  });

  test("says nothing at all about a build with the gateway switched off", async () => {
    const scoped = new Hono();
    mountControlRoutes(scoped, {
      ...deps(),
      sharedGatewayCredential: "generated",
    } as unknown as ControlDeps);
    const res = await scoped.request("/api/control/setup/state", {}, { ip: "10.0.0.1" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bundledGateway).toEqual({ available: false });
  });
});

/**
 * `/appliance/*` — a forward to the Device-only plugin. The engine owns only who may reach it and
 * the prefix; what it serves is the plugin's (`internals/pro/appliance/src/core/box.ts`).
 */
describe("the appliance forward", () => {
  function withAppliance(): { app: Hono; seen: { method: string; path: string; body: string }[] } {
    const seen: { method: string; path: string; body: string }[] = [];
    const scopedDeps = deps();
    (scopedDeps.ctx as { appliance?: unknown }).appliance = {
      report: () => ({}),
      handle: async (request: Request) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text() });
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    };
    const scoped = new Hono();
    mountControlRoutes(scoped, scopedDeps);
    return { app: scoped, seen };
  }

  test("a build without the plugin answers 404, as for a route that does not exist", async () => {
    const res = await request("/appliance/state", { headers: { "x-nouride-token": CONTROL_TOKEN } });
    expect(res.status).toBe(404);
  });

  test("an operator is refused; claiming a box is an admin's decision", async () => {
    const { app: scoped, seen } = withAppliance();
    app = scoped;
    const cookie = cookieFrom(await login("opal", OPERATOR_PASSWORD));
    const res = await request("/appliance/state", { headers: { cookie } });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  test("an admin reaches the plugin, with the prefix stripped and the body intact", async () => {
    const { app: scoped, seen } = withAppliance();
    app = scoped;
    const cookie = cookieFrom(await login("admin", ADMIN_PASSWORD));
    expect((await request("/appliance/state", { headers: { cookie } })).status).toBe(200);
    await request("/appliance/claim-link", { method: "POST", headers: { cookie }, body: "{\"x\":1}" });
    expect(seen).toEqual([
      { method: "GET", path: "/state", body: "" },
      { method: "POST", path: "/claim-link", body: "{\"x\":1}" },
    ]);
  });
});
