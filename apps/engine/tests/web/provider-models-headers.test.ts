/**
 * A saved profile's model listing is asked the way every request through the profile is: with its own headers.
 *
 * `GET /providers/:name/models` and the wizard's `GET /setup/models` probed with the base URL and the key alone. A
 * gateway that wants a header of its own beside the key — what `[providers.<name>] headers` is for — refused the
 * listing, and the model picker said the key was rejected while every turn through the same profile worked.
 * The gateway here is a real HTTP server that refuses exactly that.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, removePath, serveHttp, type HttpServer, type SqliteDb } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { AgentRegistry } from "@nouride/persona";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { probeProvider } from "@/modules/setup/probe.ts";
import { SetupService } from "@/modules/setup/service.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
const KEY = "sk-not-a-real-key";
const HEADER = "x-gateway-team";
const TEAM = "team-a";

/** Answers its listing only to a request that carries the key and its own header. */
let gateway: HttpServer;
let baseUrl = "";

beforeAll(() => {
  gateway = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      if (new URL(req.url).pathname !== "/v1/models") return new Response("not here", { status: 404 });
      const allowed = req.headers.get("authorization") === `Bearer ${KEY}` && req.headers.get(HEADER) === TEAM;
      return allowed ? Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] }) : new Response("{}", { status: 401 });
    },
  });
  baseUrl = `http://127.0.0.1:${gateway.port}/v1`;
});

afterAll(async () => {
  await gateway.stop(true);
});

let dir = "";
let db: SqliteDb;
let app: Hono;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "provider-models-headers-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.providers = { gateway: { kind: "openai", baseUrl, apiKeySecret: "gateway_api_key", headers: { [HEADER]: TEAM } } };
  // From the environment, as an install's `.env` would give it: nothing is written for it.
  const secrets = await SecretStore.open(dir, { GATEWAY_API_KEY: KEY });
  const providers = new ProviderRegistry(config.providers, secrets);
  const setup = new SetupService({
    config,
    configPath: join(dir, "config.toml"),
    dataDir: dir,
    agentsDir: join(dir, "agents"),
    secrets,
    providers,
    // Neither listing reads the agents.
    registry: {} as AgentRegistry,
    userCount: () => 1,
  });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 0, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    users: new UserStore({ db }),
    secrets,
    providers,
    setup,
  } as unknown as ControlDeps);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`/api/control${path}`, { headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });
  return { status: res.status, body: await res.json() };
}

test("a saved profile's listing carries the profile's headers", async () => {
  expect(await get("/providers/gateway/models")).toEqual({ status: 200, body: { ok: true, models: ["model-a", "model-b"] } });
});

test("so does the wizard's, from the profile it would give a new agent", async () => {
  expect(await get("/setup/models")).toEqual({ status: 200, body: { ok: true, models: ["model-a", "model-b"] } });
});

test("the gateway does refuse the same listing without its header", async () => {
  // What both routes answered before, and what keeps the two above honest: a gateway that answered anybody would pass
  // them with the headers dropped.
  expect(await probeProvider({ kind: "openai", baseUrl, apiKey: KEY })).toEqual({ ok: false, models: [], error: "The endpoint rejected that API key.", why: "unauthorized" });
});
