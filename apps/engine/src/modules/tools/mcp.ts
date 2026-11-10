/**
 * MCP servers as Nouride tools — §7.4 SPEC.
 *
 * The split from `@nouride/mcp` is deliberate. That package knows how to talk JSON-RPC and nothing
 * else; the engine knows the two things that make an external tool safe to offer an agent, and both
 * belong to it:
 *
 * - **The approval gate.** An MCP tool carries its own `gate`, but only to hold a grant the generic
 *   path cannot express — see `mcp-tools.ts`. *Whether* it asks is the agent's `approval_required`, the same
 *   question asked of every built-in.
 *
 *   It used to ask unconditionally, on the reasoning that third-party code with uninspectable side
 *   effects should default closed. That reasoning survives; the rule did not. Asking unconditionally
 *   meant `approval_required` did nothing here — an operator could neither add a tool to it nor take
 *   one off — so the only available answer was the standing per-tool grant, and a server with a dozen
 *   tools trained people to grant all twelve on sight. A prompt nobody reads is not a gate.
 *
 *   So the default is now "run", and an operator who wants a gate names the tool the way they would
 *   name `write`. The cost is real and worth stating: a freshly added server's tools run without
 *   asking, including destructive ones. What did not change is that `exec` is still gated on its own
 *   policy and `hardline` still applies to it — an MCP server cannot launder a command through this
 *   file, because it does not go through this file.
 * - **The untrusted-content convention.** A server's tool *descriptions* enter the system prompt and
 *   its results enter the conversation. Both are written by somebody else. `web_fetch` already
 *   established the marker convention for exactly this, and it applies here for the same reason.
 *
 * This file is the connections: connecting, supervising, reconnecting, and taking up a server's tools again when it
 * says they changed. The tools it builds over each are `mcp-tools.ts`'s; how each server is reached, `mcp-transport.ts`'s.
 *
 * Connecting is per agent, because each agent switches on its own servers from the library — one agent's `mcp.toml`
 * has nothing to do with another's.
 */

import { contained, createLogger, MCP_SCHEMA_WARN_BYTES, type LoadedAgent, type McpServerConfig, type Tool } from "@nouride/shared";
import { McpAuthRequiredError, McpClient, McpError, type McpAuth, type McpTool, type McpTransportFactory } from "@nouride/mcp";
import type { ReadImages } from "./builtins/read-image.ts";
import { audited } from "./audited.ts";
import { buildMcpTools, offered, schemaBytesOf, toolRows, unknownChosenTools, type McpToolCaller, type McpToolRow } from "./mcp-tools.ts";
import { transportFor, withAgentSocket } from "./mcp-transport.ts";
import type { AuditPort } from "@/commons/audit.store.ts";

const log = createLogger("tools.mcp");

/** First reconnect delay, doubling to `RECONNECT_MAX_MS`. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * The longest wait between starts of a server that never came up (0.8.10): a lost one waits `RECONNECT_MAX_MS`, and one
 * that is wrong for good — a mistyped package — is started, and its failure logged, this often rather than that.
 */
const START_AGAIN_MAX_MS = 5 * 60_000;
/**
 * How long a stdio server may take to answer the handshake (0.8.10). Its command may fetch the server before it starts
 * it — `uvx` and `npx` do the first time, `uvx` a Python with it: tens of megabytes, minutes on a slow link. At the
 * request timeout it was killed mid-download, and the next start began the download again.
 */
const STDIO_START_MS = 5 * 60_000;

/**
 * Why a handshake came to nothing: `again` — a later start may bring the server up (it exited, it did not answer, the
 * network was not up yet); `stays` — only an edit to its block, or a person's login, mends it.
 */
type NotUp = "again" | "stays";

/** Handshakes at once. Each is a process starting — often `npx` resolving a package — and on a Pi they queue for the CPU. */
const CONNECT_CONCURRENCY = 4;
/**
 * How long boot, or a reload, waits on one server before going on without it. The handshake keeps its own
 * timeout and joins when it finishes: a server slow to start is late, not gone — the tools come with the next turn.
 */
const CONNECT_WAIT_MS = 10_000;

export { MCP_SCHEMA_WARN_BYTES };

export interface McpManagerOptions {
  /** Per-call ceiling, so a silent server cannot park a turn. Defaults to the tool timeout. */
  timeoutMs?: number;
  /** Standing per-tool grants, so `allow-always` on an MCP tool means something. */
  liveToolGrants?: (agentId: string) => Set<string>;
  /**
   * Resolves `auth_secret` for an HTTP server. Absent means no server may name one.
   *
   * Typed as the one method used rather than `SecretStore` itself, so the tests that exercise
   * connection failures do not have to open a store on disk.
   */
  secrets?: { require(name: string, usedBy: string): string };
  /** `CONNECT_WAIT_MS`, for tests that cannot wait ten seconds to see a server be late. */
  connectWaitMs?: number;
  /** `CONNECT_CONCURRENCY`, for the same tests. */
  connectConcurrency?: number;
  /** Where each call is written down, as a built-in's is. Absent in a test that does not read it. */
  audit?: AuditPort;
  /** Remote servers' logins (`modules/mcp-oauth`, 0.7.19). Absent: a server is reached with what its block says, as before. */
  logins?: McpLoginPort;
  /** An agent's own folder: its stdio servers' HOME and working folder where each agent is its own user. */
  privateDir?: (agentId: string) => string;
}

/** One server, as `status()` reports it. */
export interface McpServerStatus {
  agentId: string;
  server: string;
  connected: boolean;
  tools: number;
  schemaBytes: number;
  /** It waits for a person to log in — `nouride mcp login`, or Connect on the MCP page. */
  needsLogin?: boolean;
  /**
   * Set when the agent's `tools` list chooses (0.7.21): every tool the server offers — `tools` and `schemaBytes` are
   * then what the agent is sent — and what the ones left out would have cost, measured the same way.
   */
  toolsTotal?: number;
  withheldBytes?: number;
  /** Names the agent's `tools` list gives that this server does not offer: renamed, or never there. */
  unknownTools?: string[];
}

/** What the connections need from the logins: the credential to send, and to say when a server wants a person. */
export interface McpLoginPort {
  /** A remote server's credential: its login's, none to find out whether it wants one, or undefined for its own. */
  credentialFor(agentId: string, config: McpServerConfig): McpAuth | undefined;
  /** The server refused for want of a login, at connect or a call. What the agent is told is returned. */
  refused(agentId: string, server: string, challenge: string | null): string;
  /** The server connected with what it was sent. */
  accepted(agentId: string, server: string): void;
  /** Servers waiting for a person to log in. */
  waiting(): { agentId: string; server: string }[];
}

interface Connection {
  client: McpClient;
  config: McpServerConfig;
  tools: Map<string, Tool>;
  /** What the server listed, as it listed it: the names an agent's `tools` list is checked against. */
  listed: McpTool[];
  /** Kept so a reconnect rebuilds the tools under the same gate the agent was loaded with. */
  approvalRequired: string[];
  /** Pending reconnect, cleared when it fires or when the agent is disconnected. */
  retry?: ReturnType<typeof setTimeout>;
  attempt: number;
}

/**
 * Every MCP connection this daemon holds, keyed by agent.
 *
 * One manager for the process rather than one per agent: shutdown has to be able to close all of them,
 * and a registry that only some callers know about is one nobody closes.
 */
export class McpManager {
  /**
   * How a picture a server returns is shown — set once the pipeline exists (`boot/tools.ts`), after the
   * first servers have connected, so each tool reads it per call rather than at build time.
   */
  private images: ReadImages | undefined;

  /** See `images`: the `[media]` answers `read` and `attachment_read` give. */
  showImagesWith(images: ReadImages): void {
    this.images = images;
  }

  private readonly byAgent = new Map<string, Connection[]>();
  /** Bumped on every connect and disconnect of an agent: a late handshake for an older one is closed, not joined. */
  private readonly generations = new Map<string, number>();
  /** Starts waiting to be tried again, by agent (`startAgain`): cleared when the agent is disconnected. */
  private readonly restarts = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  /** Handshakes running, and the ones waiting for a turn — `CONNECT_CONCURRENCY`. */
  private running = 0;
  private readonly queued: (() => void)[] = [];

  constructor(private readonly options: McpManagerOptions = {}) {}

  /**
   * Every agent's servers at once, four handshakes at a time. Boot connected them one agent after another,
   * each server waited out to the tool timeout — thirty seconds for every one that did not answer.
   */
  async connectAll(agents: readonly LoadedAgent[]): Promise<void> {
    await Promise.all(
      agents.map((agent) =>
        this.connectAgent(agent).catch((err: unknown) =>
          log.error("mcp setup failed", { agent_id: agent.config.id, error: String(err) }),
        ),
      ),
    );
  }

  /**
   * Connect every server an agent declares, and discover their tools.
   *
   * A server that will not start is logged and skipped, never fatal. The alternative is a daemon that
   * refuses to boot because a third-party binary moved — with every *other* agent down as collateral.
   */
  async connectAgent(agent: LoadedAgent): Promise<void> {
    const agentId = agent.config.id;
    const servers = agent.config.mcpServers.map((server) => withAgentSocket(server, agent.config.sshAgent === true));
    // Before the empty check, not after: a reload that removed the last server has to close it, and
    // returning first left that process running with its tools still offered.
    await this.disconnectAgent(agentId);
    if (servers.length === 0) return;
    const generation = this.bump(agentId);
    const ready = await Promise.all(servers.map((config) => this.join(agentId, config, agent.config.tools.approvalRequired, generation)));
    for (const connection of ready) if (connection) this.seat(agentId, connection, generation);
  }

  /** One server, waited on for `CONNECT_WAIT_MS` at most. A handshake still going after that joins when it is done. */
  private async join(agentId: string, config: McpServerConfig, approvalRequired: string[], generation: number): Promise<Connection | null> {
    await this.slot();
    const handshake = this.connect(agentId, config, approvalRequired);
    const waitMs = this.options.connectWaitMs ?? CONNECT_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), waitMs)));
    const first = await Promise.race([handshake, late]);
    clearTimeout(timer);
    // Free at the wait's end, not the handshake's: a server that is slow has already started, and holding its
    // turn would make every server after it wait out the full handshake timeout as well.
    this.release();
    if (first !== "late") return this.up(agentId, config, approvalRequired, generation, first, 0);
    log.warn("mcp server slow to start, going on without it; its tools join when it is ready", {
      agent_id: agentId,
      server: config.name,
      waited_ms: waitMs,
    });
    void handshake.then((result) => {
      const connection = this.up(agentId, config, approvalRequired, generation, result, 0);
      if (connection) this.seat(agentId, connection, generation);
    });
    return null;
  }

  /** A start's result as a connection, or null — and a server that may yet come up, started again (`startAgain`). */
  private up(agentId: string, config: McpServerConfig, approvalRequired: string[], generation: number, result: Connection | NotUp, attempt: number): Connection | null {
    if (typeof result !== "string") return result;
    if (result === "again") this.startAgain(agentId, config, approvalRequired, generation, attempt);
    return null;
  }

  /**
   * A server whose start failed is started again, on a backoff that never gives up, until it comes up or a reload or the
   * shutdown replaces this generation (0.8.10). It was left out until the agent was reloaded: a box that booted before
   * its network was up, or a `uvx` that took longer to fetch its server than the handshake waited, kept that server's
   * tools away until a restart — while one lost after it had connected came back by itself.
   */
  private startAgain(agentId: string, config: McpServerConfig, approvalRequired: string[], generation: number, attempt: number): void {
    if (this.generations.get(agentId) !== generation) return;
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** attempt, START_AGAIN_MAX_MS);
    log.warn("mcp server did not start, trying again", { agent_id: agentId, server: config.name, in_ms: delayMs, attempt: attempt + 1 });
    const timers = this.restarts.get(agentId) ?? new Set();
    const timer = setTimeout(
      contained(log, "an MCP server's start threw, trying again", () => {
        timers.delete(timer);
        if (this.generations.get(agentId) !== generation) return;
        return this.connect(agentId, config, approvalRequired).then(
          (result) => {
            const connection = this.up(agentId, config, approvalRequired, generation, result, attempt + 1);
            if (connection) this.seat(agentId, connection, generation);
          },
          (err: unknown) => {
            this.startAgain(agentId, config, approvalRequired, generation, attempt + 1);
            throw err;
          },
        );
      }, { agent_id: agentId, server: config.name }),
      delayMs,
    );
    // Unref'd, as a reconnect's is: a server that never comes up cannot hold the process open at shutdown.
    timer.unref?.();
    timers.add(timer);
    this.restarts.set(agentId, timers);
  }

  /** Into the agent's list, supervised — unless a reload or a shutdown has replaced this generation since. */
  private seat(agentId: string, connection: Connection, generation: number): void {
    if (this.generations.get(agentId) !== generation) {
      void connection.client.close().catch(() => {});
      return;
    }
    const list = this.byAgent.get(agentId) ?? [];
    list.push(connection);
    this.byAgent.set(agentId, list);
    this.superviseSlot(agentId, connection);
  }

  private bump(agentId: string): number {
    const next = (this.generations.get(agentId) ?? 0) + 1;
    this.generations.set(agentId, next);
    return next;
  }

  private async slot(): Promise<void> {
    if (this.running < (this.options.connectConcurrency ?? CONNECT_CONCURRENCY)) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queued.push(resolve));
  }

  /** The turn passes straight to the next one waiting, so `running` only falls when nobody is. */
  private release(): void {
    const next = this.queued.shift();
    if (next) next();
    else this.running -= 1;
  }

  /**
   * Bring one server back after its peer goes away.
   *
   * Needed because a transport that dies stays dead: `McpClient` cannot rebuild its own transport,
   * and its tools close over the client, so both have to be replaced together. Without this the SSE
   * transport is unusable in practice — an idle HTTP stream is closed routinely, by the server or by
   * anything between us and it, and the first such close would silently end the connection while the
   * tools stayed listed.
   *
   * Backoff is capped and never gives up. A server that is down for an hour is a server that comes
   * back, and the alternative — stopping after N tries — needs a human to notice and restart the
   * daemon, which is the failure this exists to avoid.
   */
  private superviseSlot(agentId: string, slot: Connection): void {
    slot.client.onPeerLost((reason) => {
      // A slot dropped by `disconnectAgent` must not resurrect itself and leak a connection nothing
      // holds. The map is the authority on what is still live.
      if (!this.byAgent.get(agentId)?.includes(slot)) return;

      const delayMs = this.retryLater(agentId, slot);
      log.warn("mcp server lost, reconnecting", {
        agent_id: agentId,
        server: slot.config.name,
        reason,
        in_ms: delayMs,
        attempt: slot.attempt,
      });
    });
  }

  /**
   * The next attempt on the backoff's curve, and how long until it.
   *
   * `connect` catches what a server does to it, so a reconnect that throws is this file's own fault. Out of the timer
   * that was a rejection nobody caught, and the server's retries ended there; now it is logged with the server and
   * tried again all the same — the backoff never gives up. Unref'd, so a server that never comes back cannot hold the
   * process open at shutdown.
   */
  private retryLater(agentId: string, slot: Connection): number {
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** slot.attempt, RECONNECT_MAX_MS);
    slot.attempt += 1;
    slot.retry = setTimeout(
      contained(log, "an MCP server's reconnect threw, trying again", () =>
        this.reseat(agentId, slot).catch((err: unknown) => {
          this.retryLater(agentId, slot);
          throw err;
        }),
      { agent_id: agentId, server: slot.config.name }),
      delayMs,
    );
    slot.retry.unref?.();
    return delayMs;
  }

  /** Replace a dead slot's client and tools in place, or schedule another attempt. */
  private async reseat(agentId: string, slot: Connection): Promise<void> {
    if (!this.byAgent.get(agentId)?.includes(slot)) return;

    const replacement = await this.connect(agentId, slot.config, slot.approvalRequired);
    if (typeof replacement === "string") {
      // `connect` already logged why. Try again on the same curve rather than dropping the server:
      // the usual cause is the peer still being down, which is temporary by definition.
      this.retryLater(agentId, slot);
      return;
    }

    // Written into the existing slot rather than swapped for a new one, so `toolsFor` and `status`
    // — which hold the array, not the entry — see the new client without being told.
    slot.client = replacement.client;
    slot.tools = replacement.tools;
    slot.listed = replacement.listed;
    slot.attempt = 0;
    delete slot.retry;
    this.superviseSlot(agentId, slot);
    log.info("mcp server reconnected", { agent_id: agentId, server: slot.config.name });
  }

  /**
   * A server's tools, listed again after it said they changed (`tools/list_changed`), and put where the next turn
   * reads them — with what was added and removed said in the log.
   *
   * Replaced, never edited in place. A turn already running resolved its toolset when it began (`resolveToolset`), and
   * keeps it: the definitions its model was given, and the tools those name — a removed one still calls its server and
   * hears that it is gone. The next turn sees the new list.
   *
   * The slot is found by its client, because a reconnect writes a new client into the slot it replaces; until it is
   * seated, the connection being built is the slot. A client that slot no longer holds is not listened to.
   */
  private retool(agentId: string, client: McpClient, connection: Connection, listed: McpTool[]): void {
    const slot = this.byAgent.get(agentId)?.find((entry) => entry.client === client) ?? (connection.client === client ? connection : undefined);
    if (!slot) return;
    const before = slot.tools;
    const after = this.buildTools(agentId, slot.config, client, listed, slot.approvalRequired);
    slot.tools = after;
    slot.listed = listed;

    const added = [...after.keys()].filter((name) => !before.has(name));
    const removed = [...before.keys()].filter((name) => !after.has(name));
    const changed = [...after.keys()].filter((name) => before.has(name) && JSON.stringify(before.get(name)!.definition) !== JSON.stringify(after.get(name)!.definition));
    const where = { agent_id: agentId, server: slot.config.name };
    if (added.length + removed.length + changed.length === 0) {
      log.debug("mcp server said its tools changed: listed again, and they had not", where);
      return;
    }
    const schemaBytes = schemaBytesOf(offered(after));
    log.info("mcp server's tools changed: the next turn has the new list", { ...where, added, removed, changed, tools: after.size, schema_bytes: schemaBytes });
    this.warnIfLarge(agentId, slot.config.name, [...offered(after)].length, schemaBytes);
  }

  /** The tools this agent's servers offer, already named and gated. */
  toolsFor(agentId: string): Map<string, Tool> {
    const merged = new Map<string, Tool>();
    for (const connection of this.byAgent.get(agentId) ?? []) {
      for (const [name, tool] of connection.tools) merged.set(name, tool);
    }
    return merged;
  }

  /**
   * What `/status` and the dashboard report — with what each server's tools cost every request, and which wait
   * for a person to log in: seated ones whose login stopped working, and ones that never connected for want of one.
   */
  status(): McpServerStatus[] {
    const waiting = new Set((this.options.logins?.waiting() ?? []).map(({ agentId, server }) => `${agentId}\u0000${server}`));
    const seated = [...this.byAgent.entries()].flatMap(([agentId, connections]) =>
      connections.map((connection) => ({
        agentId,
        server: connection.config.name,
        connected: connection.client.connected,
        tools: [...offered(connection.tools)].length,
        schemaBytes: schemaBytesOf(offered(connection.tools)),
        ...(connection.config.tools ? chosenStatus(connection) : {}),
        ...(waiting.delete(`${agentId}\u0000${connection.config.name}`) ? { needsLogin: true } : {}),
      })),
    );
    const unseated = [...waiting].map((key) => {
      const [agentId = "", server = ""] = key.split("\u0000");
      return { agentId, server, connected: false, tools: 0, schemaBytes: 0, needsLogin: true };
    });
    return [...seated, ...unseated];
  }

  /**
   * Every tool a server offers this agent, with what each adds to a request and whether the agent's `tools` list gives
   * it — for the page and the command that choose them. Undefined while the server is not connected for it.
   */
  toolList(agentId: string, server: string): McpToolRow[] | undefined {
    const connection = this.byAgent.get(agentId)?.find((entry) => entry.config.name === server);
    return connection ? toolRows(connection.listed, connection.tools, server) : undefined;
  }

  async disconnectAgent(agentId: string): Promise<void> {
    // First, so a handshake still going for what is being closed is closed when it lands rather than joined.
    this.bump(agentId);
    for (const timer of this.restarts.get(agentId) ?? []) clearTimeout(timer);
    this.restarts.delete(agentId);
    const connections = this.byAgent.get(agentId);
    if (!connections) return;
    // Deleted first: a peer that dies *because* we closed it fires `onPeerLost`, and the supervisor
    // checks this map to tell a real loss from a shutdown we asked for.
    this.byAgent.delete(agentId);
    for (const connection of connections) {
      if (connection.retry) clearTimeout(connection.retry);
    }
    await Promise.all(connections.map((connection) => connection.client.close()));
  }

  /** Called during drain, before the database closes. */
  async close(): Promise<void> {
    // With the ones still handshaking, which are in no list yet and would otherwise join after the drain.
    const ids = new Set([...this.byAgent.keys(), ...this.generations.keys()]);
    await Promise.all([...ids].map((id) => this.disconnectAgent(id)));
  }

  private async connect(
    agentId: string,
    config: McpServerConfig,
    approvalRequired: string[],
  ): Promise<Connection | NotUp> {
    let transport: McpTransportFactory;
    try {
      transport = transportFor(agentId, config, this.options);
    } catch (err) {
      // A misconfigured server takes only itself out of circulation. Loud, because the symptom
      // otherwise is an agent quietly missing tools it was promised.
      log.error("mcp server misconfigured, so its tools are not offered", {
        agent_id: agentId,
        server: config.name,
        transport: config.transport,
        error: err instanceof Error ? err.message : String(err),
      });
      return "stays";
    }

    const client = new McpClient({
      name: config.name,
      transport,
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(config.transport === "stdio" ? { initializeTimeoutMs: Math.max(STDIO_START_MS, this.options.timeoutMs ?? 0) } : {}),
    });

    try {
      await client.connect();
      const discovered = await client.listTools();
      const tools = this.buildTools(agentId, config, client, discovered, approvalRequired);

      const schemaBytes = schemaBytesOf(offered(tools));
      log.info("mcp server ready", {
        agent_id: agentId,
        server: config.name,
        tools: [...tools].filter(([, tool]) => !tool.withheld).map(([name]) => name),
        schema_bytes: schemaBytes,
      });
      this.warnIfLarge(agentId, config.name, [...offered(tools)].length, schemaBytes);
      const connection: Connection = { client, config, tools, listed: discovered, approvalRequired, attempt: 0 };
      // With nothing awaited since the listing above, so no change the server announces after it can be missed.
      client.onToolsChanged((listed) => this.retool(agentId, client, connection, listed));
      this.options.logins?.accepted(agentId, config.name);
      return connection;
    } catch (err) {
      if (err instanceof McpAuthRequiredError && this.options.logins) {
        // Not a fault to fix in the file: the server waits for a person to log it in, and the MCP page says so.
        this.options.logins.refused(agentId, config.name, err.challenge);
        log.warn("mcp server needs a login: its tools are offered once a person logs it in", { agent_id: agentId, server: config.name });
        await client.close().catch(() => {});
        return "stays";
      }
      log.error("mcp server unavailable, so its tools are not offered", {
        agent_id: agentId,
        server: config.name,
        error: err instanceof McpError ? err.message : String(err),
      });
      // Closed rather than left dangling: a failed handshake can still have spawned a child, and a
      // process nobody holds a reference to is one nothing will ever reap.
      await client.close().catch(() => {});
      return "again";
    }
  }

  private warnIfLarge(agentId: string, server: string, toolCount: number, schemaBytes: number): void {
    if (schemaBytes <= MCP_SCHEMA_WARN_BYTES) return;
    log.warn("an MCP server's tool schemas are large, and every request this agent makes carries them", {
      agent_id: agentId,
      server,
      tool_count: toolCount,
      schema_bytes: schemaBytes,
      hint: `Give this agent only the tools it needs: nouride mcp tools ${server} --agent ${agentId} --only <tool,…> (or the agent's MCP tab in the dashboard), or give the server only to the agent that does.`,
    });
  }

  private buildTools(
    agentId: string,
    config: McpServerConfig,
    client: McpToolCaller,
    discovered: McpTool[],
    approvalRequired: string[],
  ): Map<string, Tool> {
    const built = buildMcpTools({
      server: config.name,
      client,
      tools: discovered,
      approvalRequired,
      ...(config.parallelSafe === undefined ? {} : { parallelSafe: config.parallelSafe }),
      ...(this.options.liveToolGrants ? { liveToolGrants: this.options.liveToolGrants } : {}),
      ...(this.options.logins ? { loginNeeded: (challenge: string | null) => this.options.logins!.refused(agentId, config.name, challenge) } : {}),
      images: () => this.images,
      onSkipped: (tool, why) =>
        log.warn("mcp tool skipped", { agent_id: agentId, server: config.name, tool, hint: why }),
      ...(config.tools ? { only: { tools: config.tools, where: `agents/${agentId}/mcp.toml` } } : {}),
    });
    const unknown = unknownChosenTools(config.tools, discovered);
    if (unknown.length > 0) {
      // Said, never fatal (invariant 7's spirit, without its crash): a server that renamed a tool still serves the rest.
      log.warn("an agent's MCP tools list names tools its server does not offer, so they are not there", {
        agent_id: agentId,
        server: config.name,
        unknown,
        hint: `nouride mcp tools ${config.name} --agent ${agentId} lists the ones it has`,
      });
    }
    const audit = this.options.audit;
    return audit ? new Map([...built].map(([name, tool]) => [name, audited(name, tool, audit)])) : built;
  }
}

/** A server whose agent chose its tools, as `status()` adds it: how many there are, what the rest cost, and what is not there. */
function chosenStatus(connection: Connection): Pick<McpServerStatus, "toolsTotal" | "withheldBytes" | "unknownTools"> {
  const held = [...connection.tools.values()].filter((tool) => tool.withheld);
  const unknown = unknownChosenTools(connection.config.tools, connection.listed);
  return { toolsTotal: connection.tools.size, withheldBytes: schemaBytesOf(held), ...(unknown.length > 0 ? { unknownTools: unknown } : {}) };
}
