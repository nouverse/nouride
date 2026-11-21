/**
 * Deleting an agent (`web/control/agent-delete.ts`, `routes/agent-delete.ts`, `db/agent-rows.ts`), through the real
 * routes over an install's real config file, packs, registry and stores.
 *
 * Everything that makes the agent run goes: its pack, its private folder, its automations, its grants and stored
 * sign-ins, the connections only it answers, its seat in rooms, its background jobs and its user on the machine, its
 * open missions stopped first. What happened stays: its chats, what it remembered, its missions' records, the audit
 * log and usage, so an agent made again under the id is joined to them. The orchestrator is refused, and the route
 * wants the agent's id typed again.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { privateWorkspace } from "@nouride/persona";
import { runAgentCommandsThrough } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { AgentDeleted, AgentDeletion } from "@nouride/wire";
import { AuditLog } from "@/commons/audit.store.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { KEY_COLUMNS, ON_AGENT_DELETE } from "@/db/keys.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { McpTokenStore } from "@/modules/mcp-server/tokens.store.ts";
import { Missions } from "@/modules/missions/missions.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { SetupService } from "@/modules/setup/service.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { registerAgentDeleteRoutes } from "@/modules/web/control/routes/agent-delete.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { writeAgentPack } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const TOKEN = "control-token-for-tests-0000000000";
const BOT_TOKEN = "5550001111:AAH-a-live-looking-bot-token-for-tests";
const NOW = 1_760_000_000_000;

let bench: Bench | undefined;
afterEach(() => {
  bench?.dispose();
  bench = undefined;
});

interface Install {
  app: Hono;
  bench: Bench;
  configPath: string;
  secrets: SecretStore;
  /** The audit log, which writes its rows a little after they are recorded: flushed before they are counted. */
  audit: AuditLog;
  missions: Missions;
  cron: CronStore;
  rooms: RoomStore;
  /** What the delete asked of the daemon's other parts, in order. */
  asked: string[];
  /** Jobs "running" for an agent, until killed. */
  running: Map<string, string[]>;
  forgotten: string[];
  private: (agent: string) => string;
  call: (path: string, ask?: { method?: string; body?: unknown; as?: "admin" | "operator" }) => Promise<Response>;
}

/**
 * An install with an orchestrator (`nouva`) and two more agents: `rex`, with one of everything a delete takes and
 * everything it keeps, and `milo`, another agent whose things must be as they were afterwards.
 */
async function install(over: { account?: ControlDeps["agentAccounts"] } = {}): Promise<Install> {
  bench = await pipelineBench({ agents: ["nouva", "rex", "milo"], config: { daemon: { orchestrator: "nouva" } } });
  const { config, db, dataDir, agentsDir, registry, providers } = bench;
  const workspace = join(dataDir, "workspace");
  config.daemon.workspaceDir = workspace;
  const configPath = join(dataDir, "config.toml");
  writeFileSync(configPath, '[daemon]\norchestrator = "nouva"\n');
  const secrets = await SecretStore.open(dataDir, { TESTKEY: "sk-test" });
  const audit = new AuditLog(db);
  const asked: string[] = [];
  const running = new Map<string, string[]>([["rex", ["job_rex_build"]], ["milo", ["job_milo_serve"]]]);
  const forgotten: string[] = [];
  const settings = new SettingsService({
    config, configPath, secrets, providers, audit,
    gatewayStatus: () => new Map(),
    retireGateway: async (id) => (asked.push(`retire ${id}`), { stopped: true, loggedOut: true }),
  });
  // rex's own connection, a second one of rex's sharing a token with milo's, and milo's.
  for (const [name, agent] of [["rex", "rex"], ["rex-two", "rex"], ["milo", "milo"]] as const) {
    const saved = await settings.saveGateway({ platform: "telegram", name, enabled: true, token: BOT_TOKEN, agent, actor: "test" });
    if (!saved.ok) throw new Error(saved.error);
  }
  writeFileSync(configPath, readFileSync(configPath, "utf8").replace('[gateways.telegram.rex-two]', "[gateways.telegram.rex-two]").replace(/(\[gateways\.telegram\.rex-two\][^[]*?token = ")telegram-rex-two"/, '$1telegram-milo"'));
  const two = config.gateways.find((gateway) => gateway.id === "telegram:rex-two")!;
  two.tokenSecret = "telegram-milo";
  await secrets.delete("telegram-rex-two");

  const missions = new Missions({
    store: new MissionStore(db),
    settings: () => ({ perAgent: 2, maxRunning: 4, limitHours: 8, limitTurns: 50, limitTokens: 50_000_000 }),
    agents: { exists: () => true, asleep: () => false, privateDir: (id) => privateWorkspace(workspace, id) },
    parked: () => [],
    tell: async () => {},
    queueTurn: () => true,
    stopTurn: (mission) => void asked.push(`stop turn of ${mission.id}`),
    branchRefusal: async () => null,
    prepare: async () => {},
    check: async () => ({ passed: true, failed: null }),
    now: () => NOW,
  });
  const cron = new CronStore({ db, config: config.cron, timezone: "Asia/Jakarta", now: () => NOW });
  const rooms = new RoomStore(db);
  const ctx = { config, db, gateways: bench.gateways, startedAt: NOW, configSource: configPath, status: "ready", agentCount: 3, providerErrors: new Map() } as unknown as DaemonContext;
  const app = new Hono();
  mountControlRoutes(app, {
    ctx,
    token: TOKEN,
    secrets,
    settings,
    setup: new SetupService({ config, configPath, dataDir, agentsDir, secrets, providers, registry, audit, userCount: () => 1 }),
    audit,
    approvals: new SqliteApprovalGate({ db, timeoutMs: 300_000 }),
    pipeline: bench.pipeline,
    registry,
    providers,
    access: bench.access,
    sessions: bench.sessions,
    missions,
    cron: { store: cron, scheduler: {} as never, timezone: "Asia/Jakarta" },
    rooms,
    mcpTokens: new McpTokenStore(db),
    jobs: {
      running: (agentId: string) => (running.get(agentId) ?? []).map((id) => ({ id })),
      kill: (id: string, by: string) => {
        asked.push(`kill ${id} (${by})`);
        for (const [agent, ids] of running) running.set(agent, ids.filter((one) => one !== id));
        return true;
      },
      logDirFor: (agentId: string) => (mkdirSync(join(dataDir, "jobs", agentId), { recursive: true }), join(dataDir, "jobs", agentId)),
    },
    grants: { revokeAll: (by: string, agentId?: string) => (asked.push(`revoke grants of ${agentId} (${by})`), 0) },
    mcpLogins: { forget: async (holder: string, server: string) => void (forgotten.push(`${holder}/${server}`), db.prepare("DELETE FROM mcp_oauth WHERE agent_id = ? AND server = ?").run(holder, server)) },
    externalAgents: { stop: (agentId: string) => void asked.push(`stop cli of ${agentId}`), stopLogin: (agentId: string) => void asked.push(`stop sign-in of ${agentId}`) },
    mcp: { status: () => [], toolList: () => undefined, disconnectAgent: (agentId: string) => void asked.push(`close connectors of ${agentId}`) },
    ...(over.account ? { agentAccounts: over.account } : {}),
  } as unknown as ControlDeps);

  // In the users' table for the principal: an admin by the control token, an operator by a stand-in header the guard does not take.
  const call: Install["call"] = (path, ask = {}) =>
    Promise.resolve(
      app.request(`/api/control${path}`, {
        method: ask.method ?? (ask.body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json", ...(ask.as === "operator" ? {} : { "x-nouride-token": TOKEN }) },
        ...(ask.body === undefined ? {} : { body: JSON.stringify(ask.body) }),
      }),
    );
  return { app, bench, configPath, secrets, audit, missions, cron, rooms, asked, running, forgotten, private: (agent) => privateWorkspace(workspace, agent), call };
}

/** One of everything, for `agent`: what goes and what stays. */
async function fill(i: Install, agent: string): Promise<{ open: string; ended: string; own: string; handed: string | null }> {
  const { db } = i.bench;
  const start = (goal: string) => {
    const started = i.missions.start({ agentId: agent, goal, startedBy: "8142", gatewayId: "telegram:nouva", chatId: "8142" });
    if ("refused" in started) throw new Error(started.refused);
    return started.mission.id;
  };
  const ended = start(`${agent}: the report that was written`);
  i.missions.stop(ended, "Gading");
  const open = start(`${agent}: the report still being written`);
  const own = i.cron.create({ agentId: agent, name: `${agent}'s morning check`, trigger: { kind: "every", everyMs: 3_600_000 }, payload: { kind: "agentTurn", message: "check" }, target: { gatewayId: "telegram:nouva", chatId: "8142" }, createdBy: "usr_1" }).id;
  // Another agent's automation with a step handed to this one, and one with none.
  const handed =
    agent === "rex"
      ? i.cron.create({
          agentId: "nouva", name: "Nightly review", trigger: { kind: "every", everyMs: 86_400_000 }, target: { gatewayId: "telegram:nouva", chatId: "8142" }, createdBy: "usr_1",
          payload: { kind: "steps", steps: [{ id: "a", kind: "command", argv: ["true"] }, { id: "b", kind: "parallel", steps: [{ id: "b1", kind: "agentTurn", message: "review", agentId: "rex" }, { id: "b2", kind: "command", argv: ["true"] }] }] },
        }).id
      : null;
  i.rooms.create({ gatewayId: "web:dashboard", chatId: `room-${agent}`, agentIds: [agent, "nouva"], title: "Planning" });
  db.prepare("INSERT INTO exec_grants (grant_key, id, agent_id, command_text, argv, cwd, created_at, created_by, policy_snapshot) VALUES (?, ?, ?, 'ls', '[\"ls\"]', '/', ?, 'test', '{}')").run(`key-${agent}`, `grt_${agent}`, agent, NOW);
  db.prepare("INSERT INTO tool_grants (id, grant_key, agent_id, tool, scope_dir, created_at, created_by) VALUES (?, ?, ?, 'write', '/w', ?, 'test')").run(`tgr_${agent}`, `tkey-${agent}`, agent, NOW);
  db.prepare("INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at) VALUES (?, ?, 'telegram:nouva', '8142', 'make', '/w', 'succeeded', '/dev/null', ?)").run(`job_${agent}_old`, agent, NOW);
  db.prepare("INSERT INTO mcp_oauth (agent_id, server, discovery, client_id, logged_in_by, logged_in_at) VALUES (?, 'notion', '{}', 'client', 'test', ?)").run(agent, NOW);
  db.prepare("INSERT INTO rsi_tool_seen (agent_id, tool_name, first_seen_at) VALUES (?, 'exec', ?)").run(agent, NOW);
  db.prepare("INSERT INTO room_mention (platform, chat_id, require_mention, agent_id, set_by, set_at) VALUES ('telegram', ?, 0, ?, 'test', ?)").run(`-100${agent.length}`, agent, NOW);
  // What happened: a chat, what it remembered, what it spent, what was done to it.
  i.bench.sessions.save({ agentId: agent, gatewayId: "telegram:nouva", chatId: `dm-${agent}` }, [{ role: "user", content: "hello" }, { role: "assistant", content: `I am ${agent}.` }], 12);
  db.prepare("INSERT INTO memory_episode_agents (episode_id, agent_id) VALUES (?, ?)").run(`ep_${agent}`, agent);
  db.prepare("INSERT INTO llm_usage (agent_id, model, provider, input_tokens, output_tokens, timestamp) VALUES (?, 'test-model', 'test', 10, 5, ?)").run(agent, NOW);
  i.audit.record({ action: "agent_created", actor: "test", agentId: agent, details: {} });
  // Its own files: a note and a coding CLI's sign-in in its private folder.
  mkdirSync(join(i.private(agent), ".cli", "codex", "default"), { recursive: true });
  writeFileSync(join(i.private(agent), ".cli", "codex", "default", "auth.json"), "{}");
  writeFileSync(join(i.private(agent), "notes.md"), "mine");
  return { open, ended, own, handed };
}

/** How many rows each column that names an agent holds for `agent`, by `table.column`. */
function rowsOf(i: Install, agent: string): Record<string, number> {
  const counts: Record<string, number> = {};
  i.audit.flush();
  for (const key of KEY_COLUMNS.filter((one) => one.kind === "agent")) {
    const where = key.list ? `',' || ${key.column} || ',' LIKE '%,' || ? || ',%'` : `${key.column} = ?`;
    counts[`${key.table}.${key.column}`] = i.bench.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${key.table} WHERE ${where}`).get(agent)!.n;
  }
  return counts;
}

/** The columns a delete empties of the agent that still name it: none, after one. */
function rowsLeft(i: Install, agent: string): string[] {
  const rows = rowsOf(i, agent);
  return Object.entries(ON_AGENT_DELETE)
    .filter(([column, rule]) => (rule === "deleted" || rule === "unlisted") && rows[column] !== 0)
    .map(([column]) => column);
}

describe("what a delete would take", () => {
  test("is counted for the dialog: its work, its automations, its connections, its seats, its grants, its sign-ins, its folders", async () => {
    const i = await install({ account: { own: () => true, remove: async () => ({ how: "removed", left: 0 }) } });
    await fill(i, "rex");
    await fill(i, "milo");
    i.asked.length = 0;
    const res = await i.call("/agents/rex/delete");
    expect(res.status).toBe(200);
    const found = (await res.json()) as AgentDeletion;
    expect(found).toMatchObject({
      agent: "rex", displayName: "Rex", missions: 1, jobs: 1, automations: 1, handed: 1, connections: ["telegram:rex", "telegram:rex-two"], rooms: 1, grants: 2, signIns: 1, account: true,
    });
    // Its pack's files and the three it has in its private folder; the size where `du` could read it.
    expect(found.folder.files).toBeGreaterThanOrEqual(4);
    expect(found.folder.more).toBe(false);
    // Asking changes nothing.
    expect(i.bench.registry.get("rex")).toBeDefined();
    expect(i.asked).toEqual([]);
  });

  test("is refused for the orchestrator, in the owner's words, and for an agent that is not there; and is an admin's to ask", async () => {
    const i = await install();
    const orchestrator = await i.call("/agents/nouva/delete");
    expect(orchestrator.status).toBe(409);
    expect(await orchestrator.json()).toMatchObject({ plain: "You need at least an orchestrator. Make another agent the orchestrator first." });
    expect((await i.call("/agents/nobody/delete")).status).toBe(404);
    expect((await i.call("/agents/rex/delete", { as: "operator" })).status).toBe(401);
  });

  test("an account that is not an admin's is refused by the routes themselves, the question and the delete, before anything is read", async () => {
    for (const role of ["operator", "viewer"]) {
      const app = new Hono<{ Variables: { principal: unknown } }>();
      app.use("*", async (c, next) => {
        c.set("principal", { kind: "user", actor: "sam", role, user: { id: "u2", username: "sam", displayName: "", role } });
        await next();
      });
      // Nothing behind the routes: one that went past its check would throw on the first thing it reached for.
      registerAgentDeleteRoutes(app as never, {} as never);
      const asks = await app.request("/agents/rex/delete");
      const deletes = await app.request("/agents/rex/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "rex" }) });
      expect([asks.status, deletes.status]).toEqual([403, 403]);
    }
  });
});

describe("deleting an agent", () => {
  test("the route wants its id typed again, and refuses the orchestrator whatever is typed: nothing is touched", async () => {
    const i = await install();
    await fill(i, "rex");
    i.asked.length = 0;
    const before = rowsOf(i, "rex");
    for (const body of [{}, { confirm: "" }, { confirm: "Rex" }, { confirm: "milo" }, { confirm: true }]) {
      const res = await i.call("/agents/rex/delete", { body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ plain: "Type the agent's id to confirm, exactly as it is shown." });
    }
    const orchestrator = await i.call("/agents/nouva/delete", { body: { confirm: "nouva" } });
    expect(orchestrator.status).toBe(409);
    expect(await orchestrator.json()).toMatchObject({ error: "You need at least an orchestrator. Make another agent the orchestrator first." });
    expect((await i.call("/agents/nobody/delete", { body: { confirm: "nobody" } })).status).toBe(404);
    expect(i.bench.registry.get("rex")).toBeDefined();
    expect(i.bench.registry.get("nouva")).toBeDefined();
    expect(rowsOf(i, "rex")).toEqual(before);
    expect(i.asked).toEqual([]);
    expect(existsSync(join(i.private("rex"), "notes.md"))).toBe(true);
  });

  test("takes everything that makes it run, and leaves what happened and every other agent as they were", async () => {
    const i = await install({ account: { own: () => true, remove: async (agentId) => (i.asked.push(`remove user of ${agentId}`), { how: "removed", left: 0 }) } });
    const rex = await fill(i, "rex");
    const milo = await fill(i, "milo");
    const { db, registry, config, agentsDir, dataDir } = i.bench;
    i.asked.length = 0;
    const rexBefore = rowsOf(i, "rex");
    const miloBefore = rowsOf(i, "milo");
    const packOf = (agent: string) => join(agentsDir, agent);
    expect(existsSync(packOf("rex"))).toBe(true);

    const res = await i.call("/agents/rex/delete", { body: { confirm: "rex" } });
    expect(res.status).toBe(200);
    const done = (await res.json()) as AgentDeleted;
    expect(done).toEqual({
      deleted: "rex",
      took: { missions: 1, jobs: 1, automations: 1, handed: 1, connections: ["telegram:rex", "telegram:rex-two"], rooms: 1, grants: 2, signIns: 1 },
      account: "removed",
      notes: [],
    });

    // Not an agent any more: not listed, and its pack and its private folder, sign-ins and all, are gone from the disk.
    expect(registry.get("rex")).toBeUndefined();
    expect(registry.all().map((agent) => agent.config.id).sort()).toEqual(["milo", "nouva"]);
    expect(existsSync(packOf("rex"))).toBe(false);
    expect(existsSync(i.private("rex"))).toBe(false);
    expect(existsSync(join(dataDir, "jobs", "rex"))).toBe(false);

    // Its work was ended first: the open mission stopped, its running job killed, its coding CLI and connectors let go.
    expect(i.missions.get(rex.open)).toMatchObject({ status: "stopped", reason: "stopped by cli, who deleted its agent rex" });
    expect(i.asked).toEqual(expect.arrayContaining([`stop turn of ${rex.open}`, "kill job_rex_build (agent rex deleted by cli)", "stop cli of rex", "close connectors of rex", "remove user of rex"]));
    // In that order at the ends: nothing is removed from the machine before its work has stopped.
    expect(i.asked.indexOf(`stop turn of ${rex.open}`)).toBeLessThan(i.asked.indexOf("remove user of rex"));
    expect(i.asked.at(-1)).toBe("remove user of rex");

    // Nothing in the config names it: both its connections are gone, the file's tables with them.
    const file = readFileSync(i.configPath, "utf8");
    expect(file).not.toContain("rex");
    expect(config.gateways.map((gateway) => gateway.id)).toEqual(["telegram:milo"]);
    expect(i.asked).toEqual(expect.arrayContaining(["retire telegram:rex", "retire telegram:rex-two"]));
    // The token its own connection used stays in Secrets, to delete or to name again; one another connection uses too.
    expect(await i.secrets.resolve("telegram-rex")).toBe(BOT_TOKEN);
    expect(await i.secrets.resolve("telegram-milo")).toBe(BOT_TOKEN);

    // No row of a table that makes it run names it, and no list holds it: its automations, grants, sign-ins, seat, jobs.
    expect(rowsLeft(i, "rex")).toEqual([]);
    const rexAfter = rowsOf(i, "rex");
    expect(i.cron.get(rex.own)).toBeNull();
    expect(i.forgotten).toEqual(["rex/notion"]);
    // Another agent's automation with a step for it is turned off, and says why on its row.
    expect(i.cron.get(rex.handed!)).toMatchObject({ enabled: false, disabledReason: "A step of it was given to rex, an agent that has been deleted. Give that step to another agent, then turn it on again." });
    // What the others wrote in the room stays: the agent only left it.
    expect(i.rooms.membersOf("web:dashboard", "room-rex")).toEqual(["nouva"]);

    // What happened is all still there, row for row: its chat, what it remembered, its missions' records, usage, audit.
    for (const [column, rule] of Object.entries(ON_AGENT_DELETE)) {
      if (rule === "kept" || rule === "stopped" || rule === "expired") expect({ column, rows: rexAfter[column] }).toEqual({ column, rows: rexBefore[column]! + (column === "audit_log.agent_id" ? 1 : 0) });
    }
    for (const column of ["sessions.agent_id", "memory_episode_agents.agent_id", "llm_usage.agent_id", "missions.agent_id", "audit_log.agent_id"]) expect(rexBefore[column]).toBeGreaterThan(0);
    expect(i.missions.get(rex.ended)).toMatchObject({ status: "stopped", goal: "rex: the report that was written" });
    expect(i.bench.sessions.load({ agentId: "rex", gatewayId: "telegram:nouva", chatId: "dm-rex" }).messages.at(-1)).toMatchObject({ content: "I am rex." });
    // And the delete is itself a row of the audit log, with what it took.
    const audited = db.prepare<{ actor: string; details: string }>("SELECT actor, details FROM audit_log WHERE action = 'agent_deleted'").all();
    expect(audited).toHaveLength(1);
    expect(JSON.parse(audited[0]!.details)).toMatchObject({ missions: 1, automations: 1, handed: 1, connections: "telegram:rex,telegram:rex-two", account: "removed" });

    // The other agent has everything it had: its rows, its pack, its files, its running job, its open mission.
    expect(rowsOf(i, "milo")).toEqual(miloBefore);
    expect(existsSync(packOf("milo"))).toBe(true);
    expect(readFileSync(join(i.private("milo"), "notes.md"), "utf8")).toBe("mine");
    expect(i.running.get("milo")).toEqual(["job_milo_serve"]);
    expect(i.missions.get(milo.open)!.status).not.toBe("stopped");
    expect(i.cron.get(milo.own)).toMatchObject({ enabled: true });
    expect(file).toContain("[gateways.telegram.milo]");
    // Deleted once: a second ask finds no such agent.
    expect((await i.call("/agents/rex/delete", { body: { confirm: "rex" } })).status).toBe(404);
  });

  test("a token another tool reaches Nouride with keeps its other agents and loses this one", async () => {
    const i = await install();
    const tokens = new McpTokenStore(i.bench.db);
    const both = tokens.create({ person: "gading", agents: ["nouva", "rex", "milo"], scopes: ["memory"], label: "zed", now: NOW, expiresAt: null }).token;
    const alone = tokens.create({ person: "gading", agents: ["rex"], scopes: ["memory"], label: "cursor", now: NOW, expiresAt: null }).token;
    // An agent whose id starts the same is not this one.
    const near = tokens.create({ person: "gading", agents: ["rex2", "trex"], scopes: ["memory"], label: "other", now: NOW, expiresAt: null }).token;
    const mixed = tokens.create({ person: "gading", agents: ["rex2", "rex"], scopes: ["memory"], label: "both rexes", now: NOW, expiresAt: null }).token;
    expect((await i.call("/agents/rex/delete", { body: { confirm: "rex" } })).status).toBe(200);
    const agentsOf = (id: string) => i.bench.db.prepare<{ agents: string }>("SELECT agents FROM mcp_tokens WHERE id = ?").get(id)!.agents;
    expect(agentsOf(both.id)).toBe("nouva,milo");
    expect(agentsOf(alone.id)).toBe("");
    expect(agentsOf(near.id)).toBe("rex2,trex");
    expect(agentsOf(mixed.id)).toBe("rex2");
    // Three lists held it, and the audit row counts those: the one that only looks alike was not one.
    i.audit.flush();
    const audited = i.bench.db.prepare<{ details: string }>("SELECT details FROM audit_log WHERE action = 'agent_deleted'").get()!;
    expect((JSON.parse(audited.details) as { rows: Record<string, number> }).rows.mcp_tokens).toBe(3);
  });

  test("an agent made again under the id is joined to its old chats and memories, and to nothing that made the old one run", async () => {
    const i = await install();
    await fill(i, "rex");
    expect((await i.call("/agents/rex/delete", { body: { confirm: "rex" } })).status).toBe(200);
    // Made again as an install makes one: its pack written, and loaded.
    await writeAgentPack(i.bench.agentsDir, { id: "rex", soul: "Be brief.", configToml: '[llm]\nprovider = "test"\n' });
    await i.bench.registry.reload("rex");
    expect(i.bench.registry.get("rex")).toBeDefined();
    const chat = i.bench.sessions.load({ agentId: "rex", gatewayId: "telegram:nouva", chatId: "dm-rex" });
    expect(chat.messages.map((message) => message.content)).toEqual(["hello", "I am rex."]);
    expect(i.bench.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM memory_episode_agents WHERE agent_id = 'rex'").get()!.n).toBe(1);
    // No schedule, grant, sign-in, seat or connection came back with the name.
    const summary = (await (await i.call("/agents/rex/delete")).json()) as AgentDeletion;
    expect(summary).toMatchObject({ missions: 0, automations: 0, connections: [], rooms: 0, grants: 0, signIns: 0 });
  });
});

describe("its user on the machine", () => {
  const removed = async (account: ControlDeps["agentAccounts"] | undefined) => {
    const i = await install(account ? { account } : {});
    await fill(i, "rex");
    const res = await i.call("/agents/rex/delete", { body: { confirm: "rex" } });
    return { i, done: (await res.json()) as AgentDeleted, status: res.status };
  };

  test("where agents are not their own users there is none to remove, and nothing is said of one", async () => {
    const { done, i } = await removed(undefined);
    expect(done).toMatchObject({ account: "none", notes: [] });
    expect(existsSync(i.private("rex"))).toBe(false);
  });

  test("one that never ran a command had none", async () => {
    expect((await removed({ own: () => true, remove: async () => ({ how: "absent" }) })).done).toMatchObject({ account: "absent", notes: [] });
  });

  test("once its user is removed, what is left of its folders is taken by the daemon alone: nothing is run as the agent again", async () => {
    // The live box: the delete removed the agent's user, went over its folders once more as the agent, and the helper
    // made the user again for that command. Root may delete anything, so there is nothing left for a second pass.
    if (process.getuid?.() === 0) return;
    let noted = "";
    let parent = "";
    const i = await install({
      account: {
        own: () => true,
        // The helper hands what is left to the daemon as it removes the user: the folder can be deleted from here on.
        remove: async () => (appendFileSync(noted, "the user is removed\n"), chmodSync(parent, 0o755), { how: "removed", left: 0 }),
      },
    });
    await fill(i, "rex");
    noted = join(i.bench.dataDir, "as-agent.log");
    parent = dirname(i.private("rex"));
    // Each command run as an agent is noted and does nothing, as an agent's user that may not delete a thing.
    runAgentCommandsThrough({ prefix: (agent) => ["sh", "-c", `echo "as ${agent}" >> "${noted}"`, "--"], put: () => [] });
    // What the daemon cannot delete at first: its private folder, in a folder the daemon may not change yet.
    chmodSync(parent, 0o555);
    try {
      const res = await i.call("/agents/rex/delete", { body: { confirm: "rex" } });
      expect(res.status).toBe(200);
    } finally {
      runAgentCommandsThrough(null);
      chmodSync(parent, 0o755);
    }
    const lines = readFileSync(noted, "utf8").trim().split("\n");
    const removed = lines.indexOf("the user is removed");
    expect(lines.slice(0, removed)).toContain("as rex");
    expect(lines.slice(removed + 1)).toEqual([]);
    expect(existsSync(i.private("rex"))).toBe(false);
  });

  test("an install whose helper is older still deletes the agent, and says its account is left and how to bring it up to date", async () => {
    const { done, status, i } = await removed({ own: () => true, remove: async () => ({ how: "old" }) });
    expect(status).toBe(200);
    expect(done.account).toBe("left");
    expect(done.notes).toEqual(["Its account on the machine, nr-rex, is left: the part of Nouride that removes one was installed by an earlier release. Running the installer again brings it up to date."]);
    // Everything else went all the same.
    expect(i.bench.registry.get("rex")).toBeUndefined();
    expect(existsSync(i.private("rex"))).toBe(false);
    expect(rowsLeft(i, "rex")).toEqual([]);
  });

  test("a helper that refuses, or cannot be asked, leaves the account with its reason, and the agent is deleted", async () => {
    const refused = await removed({ own: () => true, remove: async () => ({ how: "refused", why: "a user named nr-rex exists that nouride did not make, so it is left as it is" }) });
    expect(refused.done).toMatchObject({ account: "left", notes: ["Its account on the machine, nr-rex, is left: a user named nr-rex exists that nouride did not make, so it is left as it is."] });
    const broken = await removed({ own: () => true, remove: async () => { throw new Error("the socket is gone"); } });
    expect(broken.done.account).toBe("left");
    expect(broken.done.notes[0]).toContain("the socket is gone");
    expect(broken.i.bench.registry.get("rex")).toBeUndefined();
  });
});

describe("every column that names an agent", () => {
  test("says what deleting an agent does to it, and no other column does", () => {
    const named = KEY_COLUMNS.filter((key) => key.kind === "agent").map((key) => `${key.table}.${key.column}`);
    expect(Object.keys(ON_AGENT_DELETE).sort()).toEqual(named.sort());
  });
});
