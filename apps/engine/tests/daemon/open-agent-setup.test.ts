/**
 * Opening an agent to everyone and closing it again, through the setup service and the loader as they run.
 *
 * Opening is one edit of the pack: the word and the two limits together, so no file says open without them. An agent
 * with notes of its own is opened only once the one opening it says they know, since what its notes hold it may say to
 * anyone. Closing leaves the limits for the next time. And what its page is told (`openOf`) is read from the same
 * pack and the same counts the door uses. The two agents that are never open are `open-orchestrator.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@nouride/persona";
import type { SqliteDb } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import { addLogSink, type GlobalConfig, type LogEntry } from "@nouride/shared";
import { refusedByThisInstall } from "@/boot/preflight.ts";
import { startOfLocalDay } from "@/commons/clock.ts";
import { openAndMigrate } from "@/db/index.ts";
import { OpenDoorStore } from "@/modules/access/open-door.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { hasNotes } from "@/modules/setup/open-agent.ts";
import { SetupService } from "@/modules/setup/service.ts";
import { openOf } from "@/modules/web/control/agent-open.ts";

const NORA = '[agent]\ndisplay_name = "Nora"\n';
const LIMITS = { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30 };
const NOTES_FIRST = "nora has notes of its own, and once it is open it may say what they hold to anyone who asks. Read its notes first, then open it and say that you have.";

/** Each time a pack's load called a key of it one nothing reads. */
const unknownKeys: LogEntry[] = [];
addLogSink((entry) => void (entry.message === "unknown pack config key ignored" && unknownKeys.push(entry)));

let root: string;
let config: GlobalConfig;
let db: SqliteDb;

function pack(id: string, toml: string, memory?: string): void {
  mkdirSync(join(root, "agents", id), { recursive: true });
  writeFileSync(join(root, "agents", id, "IDENTITY.md"), `${id}\n`);
  writeFileSync(join(root, "agents", id, "config.toml"), toml);
  if (memory !== undefined) writeFileSync(join(root, "agents", id, "MEMORY.md"), memory);
}

const configOf = (id: string) => readFileSync(join(root, "agents", id, "config.toml"), "utf8");

async function service() {
  const agents = await AgentRegistry.create({
    agentsDir: config.daemon.agentsDir,
    llmDefaults: { ...DEFAULT_CONFIG.llm.defaults, provider: "p", model: "m" },
    knownClis: ["codex"],
    refuse: refusedByThisInstall(config),
  });
  const secrets = await SecretStore.open(config.daemon.dataDir, {});
  const setup = new SetupService({
    config,
    configPath: join(root, "config.toml"),
    dataDir: config.daemon.dataDir,
    agentsDir: config.daemon.agentsDir,
    secrets,
    providers: new ProviderRegistry(config.providers, secrets),
    registry: agents,
    userCount: () => 1,
  });
  return { agents, setup };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nouride-open-agent-"));
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  config.daemon.agentsDir = join(root, "agents");
  config.daemon.orchestrator = "nouva";
  config.daemon.timezone = "Asia/Jakarta";
  config.providers = {};
  config.gateways = [
    { id: "telegram:nora", platform: "telegram", enabled: true, agent: "nora" },
    { id: "whatsapp:nora", platform: "whatsapp", enabled: false, agent: "nora" },
    { id: "telegram:nouva", platform: "telegram", enabled: true, agent: "nouva" },
    { id: "discord:shared", platform: "discord", enabled: true },
  ] as GlobalConfig["gateways"];
  mkdirSync(config.daemon.dataDir, { recursive: true });
  db = await openAndMigrate(join(config.daemon.dataDir, "test.db"));
  pack("nouva", '[agent]\ndisplay_name = "Nouva"\n');
  pack("nora", NORA);
  pack("coder", '[agent]\ndisplay_name = "Coder"\n\n[external]\ncli = "codex"\n');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("opening an agent", () => {
  test("writes the word and both limits in one edit, and a sentence of the admin's own where one was given", async () => {
    const { agents, setup } = await service();
    expect(await setup.openAgent({ agentId: "nora", limits: { ...LIMITS, closedReply: "  Closed for today.  " }, actor: "admin" })).toEqual({ ok: true });
    expect(configOf("nora")).toBe(`${NORA}access = "open"\n\n[open]\nmax_daily_tokens = 200000\nmax_daily_messages_per_person = 30\nclosed_reply = "Closed for today."\n`);
    expect(agents.get("nora")?.config).toMatchObject({ access: "open", open: { ...LIMITS, closedReply: "Closed for today." } });
    // Opened again with other numbers and no sentence: the numbers are these, and Nouride's own sentence is said.
    expect(await setup.openAgent({ agentId: "nora", limits: { maxDailyTokens: 50_000, maxDailyMessagesPerPerson: 5 }, actor: "admin" })).toEqual({ ok: true });
    expect(agents.get("nora")?.config.open).toEqual({ maxDailyTokens: 50_000, maxDailyMessagesPerPerson: 5 });
    expect(configOf("nora")).not.toContain("closed_reply");
  });

  test("the pack it writes loads without a word: no line of it is called a key nothing reads", async () => {
    // Seen on a live install: `config check` and the log said `[open]` was an unknown key and ignored, of the very
    // table that held the agent's limits. Every load of the pack is listened to: the open, and a start after it.
    unknownKeys.length = 0;
    const { setup } = await service();
    expect(await setup.openAgent({ agentId: "nora", limits: { ...LIMITS, closedReply: "Closed for today." }, actor: "admin" })).toEqual({ ok: true });
    const { agents } = await service();
    expect(agents.get("nora")?.config.open).toEqual({ ...LIMITS, closedReply: "Closed for today." });
    expect(unknownKeys.map((entry) => entry.data?.key)).toEqual([]);
  });

  test("a number the loader refuses opens nothing, and the file is as it was", async () => {
    const { agents, setup } = await service();
    const refused = await setup.openAgent({ agentId: "nora", limits: { maxDailyTokens: 0, maxDailyMessagesPerPerson: 30 }, actor: "admin" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("[open] max_daily_tokens must be a whole number of 1 or more, got 0") });
    expect({ file: configOf("nora"), access: agents.get("nora")?.config.access }).toEqual({ file: NORA, access: undefined });
    expect(await setup.openAgent({ agentId: "ghost", limits: LIMITS, actor: "admin" })).toEqual({ ok: false, error: 'no agent "ghost"' });
  });

  test("an agent with notes of its own is opened only once the one opening it says they know what it may say", async () => {
    pack("nora", NORA, "# MEMORY\n\n## People\n- The owner's door code is 4471.\n");
    const { agents, setup } = await service();
    expect(await setup.openAgent({ agentId: "nora", limits: LIMITS, actor: "admin" })).toEqual({ ok: false, notes: true, error: NOTES_FIRST });
    expect(await setup.openAgent({ agentId: "nora", limits: LIMITS, knowsItsNotes: false, actor: "admin" })).toEqual({ ok: false, notes: true, error: NOTES_FIRST });
    expect({ file: configOf("nora"), access: agents.get("nora")?.config.access }).toEqual({ file: NORA, access: undefined });
    expect(await setup.openAgent({ agentId: "nora", limits: LIMITS, knowsItsNotes: true, actor: "admin" })).toEqual({ ok: true });
    expect(agents.get("nora")?.config.access).toBe("open");
    // Open already, new limits are only saved: the question was answered when it was opened.
    expect(await setup.openAgent({ agentId: "nora", limits: { maxDailyTokens: 9, maxDailyMessagesPerPerson: 9 }, actor: "admin" })).toEqual({ ok: true });
    expect(agents.get("nora")?.config.open).toEqual({ maxDailyTokens: 9, maxDailyMessagesPerPerson: 9 });
    // Closed and opened again, it is asked again.
    await setup.closeAgent({ agentId: "nora", actor: "admin" });
    expect(await setup.openAgent({ agentId: "nora", limits: LIMITS, actor: "admin" })).toEqual({ ok: false, notes: true, error: NOTES_FIRST });
  });

  test("notes are what an agent wrote down: headings, comments and blank lines are none", () => {
    expect(hasNotes(undefined)).toBe(false);
    expect(hasNotes("")).toBe(false);
    expect(hasNotes("# MEMORY\n\n## People\n\n<!-- what I learn about people goes here,\nline by line -->\n\n## Things\n")).toBe(false);
    expect(hasNotes("# MEMORY\n\n## People\n- Gading likes durian.\n")).toBe(true);
    expect(hasNotes("The shop opens at nine.")).toBe(true);
  });
});

describe("closing it again", () => {
  test("sets it to follow the install and keeps its limits for the next time; closing a closed agent changes nothing", async () => {
    const { agents, setup } = await service();
    await setup.openAgent({ agentId: "nora", limits: LIMITS, actor: "admin" });
    expect(await setup.closeAgent({ agentId: "nora", actor: "opal" })).toEqual({ ok: true });
    expect(configOf("nora")).toBe(`${NORA}access = "follow"\n\n[open]\nmax_daily_tokens = 200000\nmax_daily_messages_per_person = 30\n`);
    expect(agents.get("nora")?.config).toMatchObject({ access: "follow", open: LIMITS });
    const closed = configOf("nora");
    expect(await setup.closeAgent({ agentId: "nora", actor: "opal" })).toEqual({ ok: true });
    expect(configOf("nora")).toBe(closed);
    // An agent told whom it takes is not "closed" into following: only an open one is.
    await setup.setAgentAccess({ agentId: "nouva", access: "allowlist", actor: "admin" });
    await setup.closeAgent({ agentId: "nouva", actor: "opal" });
    expect(agents.get("nouva")?.config.access).toBe("allowlist");
    expect(await setup.closeAgent({ agentId: "ghost", actor: "opal" })).toEqual({ ok: false, error: 'no agent "ghost"' });
  });
});

describe("what an agent's page is told", () => {
  const NOW = Date.parse("2026-09-25T10:00:00+07:00");
  const told = async (id: string) => {
    const { agents } = await service();
    return openOf({ ctx: { config } as never, usage: new UsageStore(db, () => NOW), openDoor: new OpenDoorStore(db) }, agents.get(id)!, NOW);
  };

  test("whether it may ever be opened, where strangers would reach it, its notes, and the limits its pack holds", async () => {
    pack("nora", `${NORA}\n[open]\nmax_daily_tokens = 200000\nmax_daily_messages_per_person = 30\nclosed_reply = "Closed."\n`, "# MEMORY\n- The shop opens at nine.\n");
    // Its own connections that are switched on: not one that is off, another agent's, or one several agents share.
    expect(await told("nora")).toEqual({ never: null, notes: true, connections: ["telegram:nora"], limits: { ...LIMITS, closedReply: "Closed." } });
    expect(await told("nouva")).toEqual({ never: "orchestrator", notes: false, connections: ["telegram:nouva"], limits: null });
    expect(await told("coder")).toEqual({ never: "cli", notes: false, connections: [], limits: null });
  });

  test("the collections it would answer strangers from, as memory reads them for it; nothing said where memory is not wired", async () => {
    const { agents } = await service();
    const openTo = (agentId: string) => (agentId === "nora" ? ["Shop", "Menu"] : []);
    const memory = { knowledge: { openTo } } as never;
    const base = { ctx: { config } as never, usage: new UsageStore(db, () => NOW), openDoor: new OpenDoorStore(db) };
    expect(openOf({ ...base, memory }, agents.get("nora")!, NOW).collections).toEqual(["Shop", "Menu"]);
    expect(openOf({ ...base, memory }, agents.get("nouva")!, NOW).collections).toEqual([]);
    expect("collections" in openOf(base, agents.get("nora")!, NOW)).toBe(false);
  });

  test("while it is open, what was used of its day: its tokens, marked where part is the daemon's own count, and who wrote", async () => {
    pack("nora", `${NORA}access = "open"\n\n[open]\nmax_daily_tokens = 200000\nmax_daily_messages_per_person = 30\n`);
    const day = startOfLocalDay(NOW, "Asia/Jakarta");
    const usage = new UsageStore(db, () => NOW);
    usage.record({ agentId: "nora", model: "m", provider: "p", inputTokens: 900, outputTokens: 100 });
    usage.record({ agentId: "nouva", model: "m", provider: "p", inputTokens: 5_000, outputTokens: 500 });
    const door = new OpenDoorStore(db);
    for (const senderId of ["ana", "ana", "budi"]) door.take({ agentId: "nora", gatewayId: "telegram:nora", senderId, day, tokensToday: 0, limits: LIMITS });
    expect((await told("nora")).today).toEqual({ tokens: 1_000, estimated: false, people: 2, messages: 3 });
    usage.record({ agentId: "nora", model: "m", provider: "p", inputTokens: 40, outputTokens: 10, estimated: true });
    expect((await told("nora")).today).toEqual({ tokens: 1_050, estimated: true, people: 2, messages: 3 });
    // Yesterday's is not today's.
    new UsageStore(db, () => day - 60_000).record({ agentId: "nora", model: "m", provider: "p", inputTokens: 70_000, outputTokens: 0 });
    expect((await told("nora")).today?.tokens).toBe(1_050);
    // A closed agent has no day to show.
    expect((await told("nouva")).today).toBeUndefined();
  });
});
