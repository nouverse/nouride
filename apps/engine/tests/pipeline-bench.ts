/**
 * A `Pipeline` wired the way boot wires it — the one place a test builds one.
 *
 * Twenty test files built their own, each wiring config, registry, providers, sessions, turns, journal, inbox,
 * delivery, the transaction, approvals, tools and gateways by hand — so every change to the pipeline's dependencies
 * was twenty edits, and a harness that drifted from boot tested a path nobody runs (invariant 9). This builds one with
 * what boot gives every daemon — the real stores, one event stream that the turn store writes through and whose
 * transaction the durable stores share, the pause marks beside the database — and takes options for what a test is
 * about: the model's answers, the packs, the config as an operator writes it, the connections, any other dependency,
 * and the next process over the same install.
 *
 * It has the inbox boot has, so a message is answered only when it is fresh: one sent long ago is a backlog after
 * downtime and gets a notice instead. `envelope()`'s fixed timestamp is years old — a test that wants an answer sends
 * `timestamp: Date.now()`.
 */

import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { SecretStore } from "@nouride/secrets";
import type { Gateway, GlobalConfig } from "@nouride/shared";
import { durableStores } from "@/boot/durable.ts";
import { pausedAgentsState } from "@/commons/daemon-state.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { openAndMigrate } from "@/db/index.ts";
import { AccessStore } from "@/modules/access/access.store.ts";
import { parseConfig } from "@/modules/config/global/index.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import type { InboxStore } from "@/modules/pipeline/inbox.store.ts";
import { Pipeline } from "@/modules/pipeline/index.ts";
import { RoomMentionStore } from "@/modules/pipeline/room-mention.store.ts";
import { RoomNameStore } from "@/modules/rooms/room-names.store.ts";
import type { TurnJournalStore } from "@/modules/turns/journal.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { AutoApprovalGate, FakeGateway, isolateInstallPaths, noSleep, scriptedOpenAI, tempDir, writeAgentPack, type AgentPackSpec } from "./helpers.ts";

/** The bench's own provider, which every pack names unless told otherwise: answered by `scriptedOpenAI`. */
const BASE_CONFIG = {
  providers: { test: { kind: "openai", base_url: "https://fake.test/v1", api_key: "testkey" } },
  llm: { defaults: { provider: "test", model: "test-model" } },
};

export interface BenchOptions {
  /** What the model answers, request by request (`scriptedOpenAI`). */
  turns?: Parameters<typeof scriptedOpenAI>[0];
  /** Wraps the scripted provider — to fail from the n-th request, to hold one open — or stands in for it. */
  fetch?: (scripted: typeof fetch) => typeof fetch;
  /** What the provider's `/models` lists — none when unsaid. Answered before `fetch`, which sees only the turns' requests. */
  models?: Record<string, unknown>[];
  /** Provider attempts before a turn gives up; 1 when the provider fails on purpose. */
  maxAttempts?: number;
  /** The packs, by id or in full; `nouva` alone when unsaid. Each is brief, and on `agentToml` unless its spec says. */
  agents?: (string | AgentPackSpec)[];
  /** A pack's `config.toml`; by default the test provider and nothing else. */
  agentToml?: string;
  /**
   * `config.toml`'s sections, as an operator writes them: each one given replaces the bench's (a test provider and its
   * default model). Access is `open` unless `[security.access]` is among them — a test about the gate says so.
   */
  config?: Record<string, unknown>;
  /** Changes to the parsed config before anything reads it. */
  configure?: (config: GlobalConfig, db: SqliteDb) => void | Promise<void>;
  /** The fake platform; one is made when unsaid. Wired unless `gateways` says otherwise. */
  gateway?: FakeGateway;
  /** The connections the pipeline has, in place of `gateway` alone: the dashboard's, a bot per agent, or none. */
  gateways?: Gateway[];
  /** Wraps the database every store writes through — `countingDb`, to count commits. */
  db?: (opened: SqliteDb) => SqliteDb;
  /** Any dependency in place of the default — built over what the bench made, for one that needs the database. */
  deps?: Partial<PipelineDeps> | ((made: Made) => Partial<PipelineDeps> | Promise<Partial<PipelineDeps>>);
}

/** A process after the first, over the same install: its config, packs and database are the install's. */
export type RebootOptions = Omit<BenchOptions, "agents" | "agentToml" | "config" | "configure" | "db">;

/** What the bench made before the pipeline, which a dependency given to it may be built over. */
export interface Made {
  /** The database every store writes through — wrapped, when `db` asked for it. */
  db: SqliteDb;
  config: GlobalConfig;
  dataDir: string;
  agentsDir: string;
  gateways: Map<string, Gateway>;
  registry: AgentRegistry;
  providers: ProviderRegistry;
  sessions: SessionStore;
  turns: EventedTurnStore;
  events: EventStore;
  journal: TurnJournalStore;
  inbox: InboxStore;
  /** The journal, inbox, delivery and settle as `boot/durable.ts` makes them — what a restart's own steps are given. */
  durable: ReturnType<typeof durableStores>;
  access: AccessStore;
}

export interface Bench extends Made {
  pipeline: Pipeline;
  /** The fake platform — wired, unless `gateways` named the connections. */
  gateway: FakeGateway;
  /** Every request the scripted provider was sent, in order. */
  requests: ReturnType<typeof scriptedOpenAI>["requests"];
  /** Removes what it made; call it from `afterEach`. A rebooted bench's removes nothing — the first one owns the install. */
  dispose: () => void;
  /** The next process over this install, as a restart brings it up: the same database, data and packs, the rest made again. */
  reboot: (options?: RebootOptions) => Promise<Bench>;
}

interface Install {
  config: GlobalConfig;
  db: SqliteDb;
  dataDir: string;
  agentsDir: string;
}

export async function pipelineBench(options: BenchOptions = {}): Promise<Bench> {
  const agentsDir = tempDir("agents");
  const dataDir = tempDir("data");
  for (const agent of options.agents ?? ["nouva"]) {
    const spec = typeof agent === "string" ? { id: agent } : agent;
    await writeAgentPack(agentsDir, { soul: "Be brief.", configToml: options.agentToml ?? '[llm]\nprovider = "test"\n', ...spec });
  }
  const config = parseConfig({ ...BASE_CONFIG, ...options.config });
  if ((options.config?.security as { access?: unknown } | undefined)?.access === undefined) config.security.access.mode = "open";
  config.daemon.agentsDir = agentsDir;
  isolateInstallPaths(config, dataDir);
  const opened = await openAndMigrate(join(dataDir, "test.db"));
  const db = options.db ? options.db(opened) : opened;
  await options.configure?.(config, db);

  const bench = await boot({ config, db, dataDir, agentsDir }, options);
  bench.dispose = () => {
    opened.close();
    removePath(agentsDir);
    removePath(dataDir);
  };
  return bench;
}

/** One process over `install`: everything boot makes per process, made now. */
async function boot(install: Install, options: RebootOptions): Promise<Bench> {
  const { config, db, dataDir, agentsDir } = install;
  const secrets = await SecretStore.open(dataDir, { TESTKEY: "sk-test" });
  const { fetchImpl, requests } = scriptedOpenAI(options.turns ?? [], options.models ? { models: options.models } : {});
  const providers = new ProviderRegistry(config.providers, secrets, {
    fetchImpl: listing(options.fetch ? options.fetch(fetchImpl) : fetchImpl, options.models ?? []),
    sleep: noSleep,
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
  });
  const gateway = options.gateway ?? new FakeGateway();
  const gateways = new Map((options.gateways ?? [gateway]).map((connection): [string, Gateway] => [connection.id, connection]));
  const registry = await AgentRegistry.create({
    agentsDir,
    llmDefaults: config.llm.defaults,
    knownProviders: () => providers.names(),
    // The configured connections, as boot has them, and any the test wired without configuring.
    knownGateways: [...new Set([...config.gateways.map((g) => g.id), ...gateways.keys()])],
    skillsOffGlobally: () => config.skills.off,
    pauses: pausedAgentsState(new DaemonStateStore(db)),
  });
  // As boot has it: one event stream, which the turn store writes through and whose transaction the durable stores share.
  const events = new EventStore(db, Date.now, { strict: true });
  const turns = new EventedTurnStore(db, events);
  const durable = durableStores(db, events);
  const sessions = new SessionStore(db);
  const access = new AccessStore({ db, ...config.security.access });
  const made: Made = { db, config, dataDir, agentsDir, gateways, registry, providers, sessions, turns, events, journal: durable.journal, inbox: durable.inbox, durable, access };
  const given = typeof options.deps === "function" ? await options.deps(made) : options.deps;
  const pipeline = new Pipeline({
    config,
    access,
    registry,
    providers,
    sessions,
    turns,
    ...durable,
    approvals: new AutoApprovalGate(),
    roomMention: new RoomMentionStore(db),
    roomNames: new RoomNameStore(db),
    tools: new Map(),
    gateways,
    startedAt: Date.now(),
    version: "test",
    ...given,
  });
  return { ...made, pipeline, gateway, requests, dispose: () => {}, reboot: (next = {}) => boot(install, next) };
}

/**
 * The endpoint's listing, answered before a test's own `fetch` sees anything: the daemon asks for it by itself
 * (`llm/catalog.ts`), and a test counting the provider's requests counts the turns' requests.
 */
function listing(fetchImpl: typeof fetch, models: Record<string, unknown>[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const asked = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if ((init?.method ?? "GET") === "GET" && /\/models$/.test(asked)) return Response.json({ data: models });
    return await fetchImpl(url, init);
  }) as typeof fetch;
}
