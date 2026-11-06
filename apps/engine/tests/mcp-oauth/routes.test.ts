/**
 * The control routes of a login (0.7.19): started, finished and logged out over the API — admin only, as saving a
 * server is; what a server's card reads about its login; a server taken out taking its login with it. And never a
 * token, a code or a verifier in an answer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { cheapPasswords } from "../helpers.ts";
import { approve, challengeOf, loginBench, type LoginBench } from "./fixture.ts";

const TOKEN = "control-token-for-tests-0000000000";
const OPERATOR_PASSWORD = "operator-password-1";
let b: LoginBench;
let app: Hono;
let removed: string[];

async function mount(withLogins = true): Promise<void> {
  const users = new UserStore({ db: b.db, passwords: cheapPasswords });
  if (!users.byUsername("opal")) await users.create({ username: "opal", password: OPERATOR_PASSWORD, role: "operator", createdBy: "test" });
  app = new Hono();
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.agentsDir = b.agentsDir;
  mountControlRoutes(app, {
    ctx: { config, db: b.db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(b.db),
    users,
    files: {},
    registry: b.registry,
    settings: {
      hasSecret: () => false,
      removeLibraryServer: async (args: { name: string }) => (removed.push(args.name), { ok: true, restartRequired: false, users: ["nouva"] }),
    },
    mcp: { status: () => b.logins.waiting().map(({ agentId, server }) => ({ agentId, server, connected: false, tools: 0, schemaBytes: 0, needsLogin: true })) },
    ...(withLogins ? { mcpLogins: b.logins } : {}),
  } as unknown as ControlDeps);
}

beforeEach(async () => {
  removed = [];
  b = await loginBench();
  await mount();
});
afterEach(async () => {
  await b.close();
});

const call = (method: string, path: string, body?: unknown, cookie?: string) =>
  app.request(
    `/api/control${path}`,
    { method, headers: { ...(cookie ? { cookie } : { "x-nouride-token": TOKEN }), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { clientAddress: "203.0.113.10" },
  );

describe("a login over the API", () => {
  test("started, finished with the address the browser landed on, read on the card, and logged out — no secret in any answer", async () => {
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const card = async () => ((await (await call("GET", "/agents/nouva/mcp")).json()) as { servers: Record<string, unknown>[] }).servers[0]!;
    expect(await card()).toMatchObject({ name: "fake", on: true, loginAs: "library", needsLogin: true, running: true, connected: false });

    const started = await call("POST", "/agents/nouva/mcp/fake/oauth/start", {});
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const { code, state } = await approve(url);
    const finished = await call("POST", "/mcp/oauth/finish", { url: `http://127.0.0.1:18254/dashboard/oauth/mcp/callback?code=${code}&state=${state}` });
    const answers = [JSON.stringify(await finished.json())];
    expect(JSON.parse(answers[0]!)).toEqual({ ok: true, holder: "shared", server: "fake" });

    const after = await card();
    answers.push(JSON.stringify(after));
    expect(after).toMatchObject({ needsLogin: false, login: { loggedInBy: "cli", scope: null } });
    // The library's page says the same of its login.
    const library = (await (await call("GET", "/mcp/library")).json()) as { servers: Record<string, unknown>[] };
    answers.push(JSON.stringify(library));
    expect(library.servers[0]).toMatchObject({ name: "fake", login: { loggedInBy: "cli" }, agents: [{ id: "nouva", on: true, own: false }] });

    const out = await call("DELETE", "/mcp/library/fake/oauth");
    answers.push(JSON.stringify(await out.json()));
    expect(JSON.parse(answers[3]!)).toEqual({ ok: true });
    expect(b.store.get("shared", "fake")).toBeUndefined();

    const verifier = new URL(url).searchParams.get("code_challenge")!;
    for (const secret of [...b.servers.issued, code, verifier]) for (const answer of answers) expect(answer.includes(secret)).toBe(false);
  });

  test("its refusals carry their status: an unknown server is 404, one with its own credential 400", async () => {
    expect((await call("POST", "/agents/nouva/mcp/linear/oauth/start", {})).status).toBe(404);
    expect((await call("POST", "/mcp/library/linear/oauth/start", {})).status).toBe(404);
    // nix does not use it: its own login is nothing to make.
    expect((await call("POST", "/agents/nix/mcp/fake/oauth/start", {})).status).toBe(404);
    const stale = await call("POST", "/mcp/oauth/finish", { code: "c", state: "nobody-started-this" });
    expect({ status: stale.status, error: ((await stale.json()) as { error: string }).error }).toEqual({ status: 400, error: expect.stringContaining("no login is waiting") });
  });

  test("admin only — an operator is refused at every step", async () => {
    const login = await call("POST", "/auth/login", { username: "opal", password: OPERATOR_PASSWORD });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    for (const [method, path] of [["POST", "/agents/nouva/mcp/fake/oauth/start"], ["POST", "/mcp/library/fake/oauth/start"], ["POST", "/mcp/oauth/finish"], ["DELETE", "/agents/nouva/mcp/fake/oauth"], ["DELETE", "/mcp/library/fake/oauth"]] as const) {
      const res = await call(method, path, method === "POST" ? {} : undefined, cookie);
      expect({ path, status: res.status, body: await res.json() }).toEqual({ path, status: 403, body: { error: "admin only" } });
    }
  });

  test("answers 501 where the daemon has no logins to give", async () => {
    await mount(false);
    expect((await call("POST", "/agents/nouva/mcp/fake/oauth/start", {})).status).toBe(501);
    expect((await call("POST", "/mcp/oauth/finish", {})).status).toBe(501);
  });

  test("a server taken out of the library takes its logins with it", async () => {
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const { url } = (await (await call("POST", "/agents/nouva/mcp/fake/oauth/start", {})).json()) as { url: string };
    await call("POST", "/mcp/oauth/finish", await approve(url));
    expect(b.secrets.resolve("mcp-oauth-shared-fake-access")).toBeDefined();

    expect((await call("DELETE", "/mcp/library/fake")).status).toBe(200);
    expect(removed).toEqual(["fake"]);
    expect(b.secrets.resolve("mcp-oauth-shared-fake-access")).toBeUndefined();
    expect(b.store.get("shared", "fake")).toBeUndefined();
  });

  test("the server list says which wait for a login", async () => {
    b.logins.refused("nouva", "fake", null);
    expect(await (await call("GET", "/mcp")).json()).toEqual({ servers: [{ agentId: "nouva", server: "fake", connected: false, tools: 0, schemaBytes: 0, needsLogin: true }] });
  });
});
