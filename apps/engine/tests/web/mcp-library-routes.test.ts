/**
 * The control API for the MCP library (0.7.19): a read says of each server whether its secrets are set — never their
 * names — and which agents use it; a save, a switch and a credential each pass through to the writer as sent; and
 * one agent's page shows the library's servers with that agent's word on each, plus any its pack still declares.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const TOKEN = "control-token-for-tests-0000000000";
let dir = "";
let db: SqliteDb;
let app: Hono;
let calls: { method: string; args: Record<string, unknown> }[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-lib-route-"));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "mcp.toml"), ['[[servers]]', 'name = "gh"', 'transport = "stdio"', 'command = "npx"', 'env_secrets = { GITHUB_TOKEN = "github_token", OTHER = "missing_one" }', ""].join("\n"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  calls = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.agentsDir = agentsDir;
  const gh = { name: "gh", transport: "stdio", command: "npx", envSecrets: { GITHUB_TOKEN: "mcp-nouva-gh-github_token", OTHER: "missing_one" }, loginAs: "shared" };
  const agents = [
    { dir: "/packs/nouva", config: { id: "nouva", mcp: { gh: { on: true, envSecrets: { GITHUB_TOKEN: "mcp-nouva-gh-github_token" } } }, mcpServers: [gh] } },
    { dir: "/packs/nox", config: { id: "nox", mcp: {}, mcpServers: [] } },
  ];
  const writer = (method: string) => async (args: Record<string, unknown>) => (calls.push({ method, args }), { ok: true, restartRequired: false });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 2, providerErrors: new Map() },
    token: TOKEN,
    audit: new AuditLog(db),
    files: {},
    registry: { get: (id: string) => agents.find((agent) => agent.config.id === id), all: () => agents, reload: async () => {} },
    settings: {
      hasSecret: (name: string) => name === "github_token" || name === "mcp-nouva-gh-github_token",
      saveLibraryServer: writer("saveLibraryServer"),
      setAgentMcp: writer("setAgentMcp"),
      removeLibraryServer: writer("removeLibraryServer"),
    },
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/control${path}`, { method, headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, { clientAddress: "203.0.113.10" });

describe("the MCP library over the API", () => {
  test("a read says whether each secret is set, never its name — and which agents use the server, with their own credential or not", async () => {
    const answer = (await (await call("GET", "/mcp/library")).json()) as { servers: Record<string, unknown>[] };
    expect(answer.servers[0]!.envSecrets).toEqual([{ name: "GITHUB_TOKEN", set: true }, { name: "OTHER", set: false }]);
    expect(answer.servers[0]!.agents).toEqual([
      { id: "nouva", on: true, own: true, connected: false, tools: 0, needsLogin: false },
      { id: "nox", on: false, own: false },
    ]);
    expect(JSON.stringify(answer)).not.toContain("github_token");
  });

  test("a save passes the server, its credential and the agents to switch on through — the credential never as part of the server", async () => {
    await call("POST", "/mcp/library", { name: "gh", transport: "stdio", command: "npx", perAgent: true, envSecrets: { GITHUB_TOKEN: {}, NEW_ONE: { value: "v" }, JUNK: "not an object" }, enable: ["nox"] });
    const args = calls[0]!.args;
    expect(args.envSecrets).toEqual({ GITHUB_TOKEN: {}, NEW_ONE: { value: "v" }, JUNK: {} });
    expect(args.enable).toEqual(["nox"]);
    expect(args.server).toEqual({ name: "gh", transport: "stdio", command: "npx", perAgent: true });
  });

  test("adding from one agent's page is a library save switched on for that agent", async () => {
    await call("POST", "/agents/nox/mcp", { name: "gh", transport: "stdio", command: "npx" });
    expect(calls[0]).toMatchObject({ method: "saveLibraryServer", args: { enable: ["nox"] } });
    expect((await call("POST", "/agents/ghost/mcp", { name: "gh", transport: "stdio", command: "npx" })).status).toBe(404);
  });
});

describe("one agent's MCP over the API", () => {
  test("the library's servers with this agent's word on each — a pack declares none since 0.7.19", async () => {
    const answer = (await (await call("GET", "/agents/nouva/mcp")).json()) as { servers: Record<string, unknown>[] };
    expect(answer.servers.map((server) => [server.name, server.on, server.credential, server.loginAs])).toEqual([["gh", true, "own", "library"]]);
    expect(answer.servers.every((server) => !("origin" in server))).toBe(true);
    expect(JSON.stringify(answer)).not.toContain("mcp-nouva-gh");
    const other = (await (await call("GET", "/agents/nox/mcp")).json()) as { servers: Record<string, unknown>[] };
    expect(other.servers.map((server) => [server.name, server.on])).toEqual([["gh", false]]);
  });

  test("a switch and a credential pass through as sent; a junk credential is not one", async () => {
    await call("PUT", "/agents/nox/mcp/gh", { on: true, credential: { envSecrets: { GITHUB_TOKEN: { value: "x" } }, login: false } });
    await call("PUT", "/agents/nox/mcp/gh", { credential: "library" });
    await call("PUT", "/agents/nox/mcp/gh", { credential: 7 });
    await call("DELETE", "/agents/nox/mcp/gh");
    expect(calls.map((entry) => [entry.args.on, entry.args.credential])).toEqual([
      [true, { envSecrets: { GITHUB_TOKEN: { value: "x" } }, login: false }],
      [undefined, "library"],
      [undefined, undefined],
      [false, undefined],
    ]);
  });
});
