/**
 * External agents (0.8.1, EXTERNAL_AGENTS RFC): a Nouride agent whose turns a coding CLI answers over the Agent Client
 * Protocol — Claude Code, Codex, or a CLI the person adds.
 *
 * From the outside it is any agent: its channel, rooms, schedules, missions, status, `ask_agent`. Inside, the CLI as it
 * is, on its own model and sign-in, run as the agent's own user. This holds the CLIs that are running — one process an
 * agent, started at its first turn, stopped after five quiet minutes with no command of its own still running — the
 * sessions they keep by conversation, and why an agent cannot answer when its CLI will not. With no external agent
 * configured, nothing here runs.
 *
 * - `launch.ts` — the command, environment and profile folder an agent's CLI starts with.
 * - `connection.ts` — one running CLI: its ACP client, its sessions, its stderr.
 * - `runner.ts` — one turn, prompted to the CLI and returned as the executor's `TurnResult`.
 * - `updates.ts` — what the CLI says while it works, read as the turn's steps and reply.
 * - `own-words.ts` — what it says between turns, by itself, kept for a turn that reads it.
 * - `left-running.ts` — the commands it leaves running in the background, which a restart waits for or reports.
 * - `permission.ts` — what the CLI asks permission for, asked as a Nouride approval.
 * - `instruction.ts` — the block it reads about itself, in its own instruction file.
 * - `instructed.ts` — what each session opened on, so one opened on other instructions is let go (0.8.8).
 * - `skills.ts` — its Nouride skills, copied where the CLI reads a project's.
 * - `login.ts` — a sign-in, run in a terminal as the agent, answered a line at a time.
 * - `profiles.ts` — the agent's sign-ins of its CLI, and whether each is signed in.
 * - `accounts.ts` — the accounts on the Models page: shared ones signed in once, the others once per agent.
 * - `scan.ts` — which CLIs this box has, and their versions.
 * - `newest.ts` — the newest version of each CLI's package, as the npm registry says, once a day.
 * - `cli-update.ts` — a CLI updated: held, installed, its new version's handshake checked, and the way back.
 * - `lent-tools.ts` — Nouride's tools, lent to the CLI over MCP while its turn runs.
 * - `usage.ts` — what it says it spent, and of its context, as Nouride records and shows them.
 */

import { BUILT_IN_CLIS, steeringOffered, type CliRow, type McpServer } from "@nouride/acp";
import { contained, createLogger, NourideError, type ExternalPermissions, type LoadedAgent, type Skill } from "@nouride/shared";
import { agentCommandsHaveOwnUsers, commandsRunningUnder, join, removePath, runCommand, sha256Text, spawnInteractive, spawnLongLived, statFile } from "@nouride/runtime";
import { privateWorkspace } from "@nouride/persona";
import type { ExecutorDeps, TurnBrain, TurnRequest } from "@/modules/llm/executor/types.ts";
import type { PlanStep } from "@/modules/notes/store.ts";
import type { CliModel } from "@/commons/daemon-state.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import { CliConnection, signedOut, unavailableReason, type Spawn } from "./connection.ts";
import { OfferedModels, offeredModels } from "./models.ts";
import { accountLaunch, launchFor, profileDirOf } from "./launch.ts";
import { FRESH_POLL_MS, FRESH_WAIT_MS, hashedEach, notStartedWith, pause } from "./fresh-secrets.ts";
import { CliAccounts, type AccountsDeps, type CliAccountsView } from "./accounts.ts";
import { LentTools } from "./lent-tools.ts";
import { CliLogin, type LoginView, type SignIn } from "./login.ts";
import { openOnBox, returnAddress } from "./callback.ts";
import { profileNames, type CliProfile } from "./profiles.ts";
import { cliSessionKey, ExternalTurnRunner, type RunnerHost } from "./runner.ts";
import { Instructed, type InstructedFile } from "./instructed.ts";
import { promptTakes, type PromptTakes } from "./prompt.ts";
import { scanCli, withStanding, type ScannedCli } from "./scan.ts";
import { CliUpdates } from "./cli-update.ts";
import type { NewestVersions } from "./newest.ts";
import type { Situation } from "./situation.ts";
import { OwnWords, ownKey, type OwnChat } from "./own-words.ts";
import { LeftRunning, type LeftRunningFile } from "./left-running.ts";
import { SkillCopies, syncSkills } from "./skills.ts";
import { answeringOf, CliContexts, CliSpending } from "./usage.ts";
import type { CliAnswering } from "@/modules/pipeline/brain.ts";

const log = createLogger("external-agents");

/** A CLI with no prompt running this long, and no command of its own, is stopped; the next message starts it again. */
const IDLE_MS = 5 * 60_000;
/** A sign-in nobody finished is stopped after this long: a device code is good for about fifteen minutes. */
const LOGIN_MS = 15 * 60_000;
/** How long a scan's answer stands: a CLI is installed or updated by hand, minutes apart, not seconds. */
const SCAN_MS = 60_000;
/** How long a profile's sign-in check stands: the Brain tab asks when it opens; a sign-in or a refused turn asks again. */
const CHECK_STANDS_MS = 10 * 60_000;
/** A session a CLI has not opened in this long will not open: the check says so rather than spin. */
const PROBE_MS = 60_000;
/**
 * What one CLI holds with a session open, before it has done any work — measured 2026-10-26 on macOS arm64, signed
 * out, the process and all it started: Claude Code 324 MB, Codex 187 MB (and omp, no longer built in, 493 MB). A
 * working session holds more, so this is a floor rather than a fit: with less room than this for the agents' commands,
 * not one session opens, and external agents are not offered (EXTERNAL_AGENTS §6). Rounded up from the largest.
 */
const CLI_SESSION_BYTES = 512 * 1024 * 1024;

/** A sign-in as it stands, and the profile it signs in. */
type ProfileLogin = LoginView & { profile: string };

/** Whether this box has room for a coding CLI, and the numbers that say so. */
export interface CliRoom {
  enough: boolean;
  /** What the agents' commands may hold together: their cgroup's limit, or the machine's memory. */
  bytes: number;
  needs: number;
}

export interface ExternalAgentsDeps {
  /** The CLIs this install knows: the built-in rows and the person's own. */
  rows?: () => readonly CliRow[];
  workspaceDir: () => string;
  /** The secrets bound to a command of the agent's (`[security.exec_secrets]`), as variables. */
  secretsFor: (agentId: string, argv: readonly string[]) => Record<string, string>;
  /** How long a turn waits for a busy CLI to start again with changed secrets (`forTurn`). Absent: two minutes. */
  freshWaitMs?: number;
  sessions: { load(): Record<string, string>; save(sessions: Record<string, string>): void };
  /** What each kept session opened on (`instructed.ts`), by the same key (0.8.8). Absent: held for the process alone. */
  instructions?: InstructedFile;
  /** The version of each CLI that last passed the check, by CLI id. Absent: no CLI is checked (a test's service). */
  versions?: { load(): Record<string, string>; save(versions: Record<string, string>): void };
  /** The models each agent's CLI offered when its last session opened, by agent id. Absent: none is kept. */
  models?: { load(): Record<string, CliModel[]>; save(models: Record<string, CliModel[]>): void };
  /** The efforts each agent's CLI offered for the model its last session was on, by agent id. Absent: none is kept. */
  efforts?: { load(): Record<string, CliModel[]>; save(efforts: Record<string, CliModel[]>): void };
  keepPlan?: (key: { agentId: string; gatewayId: string; chatId: string }, task: string, steps: PlanStep[]) => Promise<void>;
  /** The memory the agents' commands may hold together, in bytes: their cgroup's limit, else the machine's. */
  room?: () => number;
  /** The skills the folders in an agent's `skill_roots` bring, switched on for it. Absent: none. */
  projectSkills?: (agent: LoadedAgent) => Promise<Skill[]>;
  /** Where a CLI reaches Nouride's tools (`/mcp/agent`) on this box; absent where nothing serves HTTP. */
  mcpUrl?: () => string | undefined;
  spawn?: Spawn;
  interactive?: typeof spawnInteractive;
  /** The coding-CLI accounts added, and the secret store a shared one's token is kept in. */
  accounts?: AccountsDeps;
  /** Where a shared account's sign-in that kept a token is written down, with who started it (HARDENING §8). */
  audit?: Pick<AuditPort, "record">;
  /** Opens the page a sign-in sent the browser to, on this box. */
  openOnBox?: (url: URL) => Promise<string>;
  /** Runs a CLI's status words as the agent. */
  run?: typeof runCommand;
  scan?: (row: CliRow) => Promise<ScannedCli>;
  /** The newest version of each CLI's package, as the npm registry says (0.8.24). Absent: nothing is said of it. */
  newest?: Pick<NewestVersions, "of">;
  now?: () => number;
  idleMs?: number;
  /** How many commands a CLI's process still runs (`commandsRunningUnder`). */
  commandsUnder?: (pid: number) => number;
  /** The chats whose CLI was left running a command, by session (`left-running.ts`). */
  leftRunning?: LeftRunningFile;
  /** How long a CLI going on by itself is quiet before what it said is its answer (`own-words.ts`). */
  quietMs?: number;
  /** How long a CLI asked to stop has before it is stopped (`runner.ts`). */
  stopGraceMs?: number;
  /** How long a message for a running prompt waits for an open tool call (`steering.ts`). */
  steerHoldMs?: number;
}

export class ExternalAgents implements RunnerHost {
  private readonly running = new Map<string, CliConnection>();
  /** What each running CLI's secrets were when it started, as a hash of their names and values — in memory (0.8.11). */
  private readonly startedWith = new Map<string, string>();
  /** The same, one hash per variable, so a turn can be told which of them its shell lacks (0.8.15). Never a value. */
  private readonly startedWithEach = new Map<string, Record<string, string>>();
  private readonly starting = new Map<string, Promise<CliConnection>>();
  private readonly reasons = new Map<string, string>();
  private readonly logins = new Map<string, { login: SignIn; profile: string }>();
  /** Each profile's sign-in check, by `agent|profile`. */
  private readonly checks = new Map<string, { at: number; check: Promise<Pick<CliProfile, "signedIn" | "reason">>; settled: boolean }>();
  private readonly skillCopies = new SkillCopies();
  /** The models each agent's CLI offered when its last session opened, and the one it opened on. */
  readonly models: OfferedModels;
  /** The efforts each agent's CLI offered for the model its last session was on, the one it is set to marked. */
  readonly efforts: OfferedModels;
  /** Nouride's tools as the CLIs reach them, for `/mcp/agent`. */
  readonly lent = new LentTools();
  /** What each CLI session was last told of who is here (`situation.ts`). */
  readonly told = new Map<string, Situation>();
  /** What the CLIs say between turns, by themselves, and the chat each wakes for it. */
  readonly ownWords: OwnWords;
  /** Wakes an agent's chat for what its CLI said by itself: a turn there reads it. Set once the pipeline is up. */
  onOwnWords?: (chat: OwnChat) => void;
  private scanned: { at: number; clis: Promise<ScannedCli[]> } | null = null;
  /** What the CLIs leave running in the background, and the chats owed what came of it. */
  private readonly left: LeftRunning;
  /** A CLI being updated, held while its new version installs, and checked after (`cli-update.ts`, 0.8.24). */
  readonly updates: CliUpdates;
  /** What each conversation's CLI session last said of its context (`usage.ts`). */
  readonly contexts = new CliContexts();
  /** What each conversation's running CLI turn has spent so far, estimated (`usage.ts` `PromptSpend`). */
  readonly spending = new CliSpending();
  /** Told when a conversation's running CLI turn has spent more: a mission reads its limits then. Set once missions exist. */
  onSpent?: (agentId: string, gatewayId: string, chatId: string) => void;
  private kept: Record<string, string>;
  private readonly instructed: Instructed;

  readonly accounts: CliAccounts;

  get steerHoldMs(): number | undefined {
    return this.deps.steerHoldMs;
  }

  get stopGraceMs(): number | undefined {
    return this.deps.stopGraceMs;
  }

  constructor(private readonly deps: ExternalAgentsDeps) {
    this.kept = deps.sessions.load();
    this.instructed = new Instructed(deps.instructions);
    this.models = new OfferedModels(deps.models);
    this.efforts = new OfferedModels(deps.efforts);
    this.accounts = new CliAccounts(deps.accounts ?? {});
    this.ownWords = new OwnWords((chat) => this.onOwnWords?.(chat), deps.quietMs);
    this.left = new LeftRunning(deps.leftRunning, deps.commandsUnder ?? commandsRunningUnder);
    this.updates = new CliUpdates({
      runningEntries: () => [...this.running],
      occupied: (cli) => cli.busy || cli.held || this.left.commandsOf(cli) > 0,
      stopAgent: async (agentId) => {
        const cli = this.running.get(agentId);
        this.running.delete(agentId);
        await cli?.close();
      },
      connection: (agent) => this.connection(agent),
      setUnavailable: (agentId, reason) => this.setUnavailable(agentId, reason),
      forgetScan: () => void (this.scanned = null),
      ...(deps.versions ? { versions: deps.versions } : {}),
    });
  }

  /** Every CLI this install knows, built-in first. */
  rows(): readonly CliRow[] {
    return this.deps.rows?.() ?? BUILT_IN_CLIS;
  }

  row(id: string): CliRow | undefined {
    return this.rows().find((row) => row.id === id);
  }

  /** The turn's brain for an external agent; null for any other, which the executor answers. */
  runnerFor(agent: LoadedAgent, deps: ExecutorDeps): TurnBrain | null {
    return agent.config.external ? new ExternalTurnRunner(agent, deps, this) : null;
  }

  /** The efforts the agent's CLI offered for the model its last session opened on (`ExternalBrains.offeredEfforts`). */
  offeredEfforts(agentId: string): string[] {
    return this.efforts.of(agentId).map((effort) => effort.value);
  }

  /** Whether the agent's CLI takes a message mid-prompt, as its handshake said (`ExternalBrains.steersMidPrompt`). */
  steersMidPrompt(agentId: string): boolean {
    const open = this.running.get(agentId);
    return open !== undefined && !open.closed && steeringOffered(open.info);
  }

  /** What answers the agent in a conversation, for `/status` (0.8.8) — never the pack's `[llm]`; null for an agent no CLI answers. */
  answering(agent: LoadedAgent, gatewayId: string, chatId: string): CliAnswering | null {
    const external = agent.config.external;
    if (!external) return null;
    const open = this.running.get(agent.config.id);
    const handshake = open && !open.closed ? open.info?.agentInfo : undefined;
    return answeringOf(this.row(external.cli)?.name ?? external.cli, external.model, handshake, this.models.runsOn(agent.config.id), this.contexts.of(agent.config.id, cliSessionKey(gatewayId, chatId)));
  }

  /**
   * What the agent's CLI turn running in a conversation has spent so far, estimated — 0 where none runs (0.8.8): what a
   * mission's token limit reads before the CLI says what the prompt spent, at its end.
   */
  spentNow(agentId: string, gatewayId: string, chatId: string): number {
    return this.spending.of(agentId, cliSessionKey(gatewayId, chatId));
  }

  spent(agentId: string, gatewayId: string, chatId: string): void {
    this.onSpent?.(agentId, gatewayId, chatId);
  }

  /** Why an agent cannot answer now — its CLI missing, signed out, failing to start — or null. */
  unavailable(agentId: string): string | null {
    return this.reasons.get(agentId) ?? null;
  }

  setUnavailable(agentId: string, reason: string | null): void {
    // A turn that found the CLI signed out, or answering again, is newer than what a check said.
    if ((this.reasons.get(agentId) ?? null) !== reason) for (const key of this.checks.keys()) if (key.startsWith(`${agentId}|`)) this.checks.delete(key);
    this.noteUnavailable(agentId, reason);
  }

  private noteUnavailable(agentId: string, reason: string | null): void {
    if (reason) {
      if (this.reasons.get(agentId) !== reason) log.warn("an external agent cannot answer", { agent_id: agentId, reason });
      this.reasons.set(agentId, reason);
    } else this.reasons.delete(agentId);
  }

  preset(chosen?: ExternalPermissions): ExternalPermissions {
    // Free in its folder is a wall only where the CLI is the agent's own user: elsewhere it is the daemon's, which reads
    // the database and the secret store, and a pack's "folder" asks as "risky" does — as the Brain tab says.
    if (!agentCommandsHaveOwnUsers()) return chosen === "all" ? "all" : "risky";
    return chosen ?? "folder";
  }

  /** Whether nothing asks before the agent deletes (0.8.8): its CLI in `folder`, where its user's rights are the limit. */
  freeToDelete(agent: LoadedAgent | undefined): boolean {
    const external = agent?.config.external;
    // A CLI of the person's own with no `folder` mode keeps its default there, which may ask (Nox's review).
    return external !== undefined && this.preset(external.permissions) === "folder" && this.row(external.cli)?.modes?.folder !== undefined;
  }

  keptSession(agentId: string, key: string): string | undefined {
    return this.kept[`${agentId}|${key}`];
  }

  keepSession(agentId: string, key: string, sessionId: string, instructions: string | null): void {
    this.kept = { ...this.kept, [`${agentId}|${key}`]: sessionId };
    this.deps.sessions.save(this.kept);
    this.instructed.keep(`${agentId}|${key}`, instructions);
  }

  instructedWith(agentId: string, key: string): string | undefined {
    return this.instructed.of(`${agentId}|${key}`);
  }

  /**
   * Each of the agent's sessions let go at its conversation's next turn, none cut off (0.8.8): what they opened on is
   * no longer known. `agent reload` — config and instructions both — and a person's save of its MEMORY.md, which the
   * fingerprint leaves out (`writeInstruction`).
   */
  renew(agentId: string): void {
    this.instructed.forget((at) => at.startsWith(`${agentId}|`));
  }

  /**
   * Whether a session still owes its chat something of its own (0.8.8): words it said by itself that no turn has read,
   * or a command its prompt left running that the CLI still runs. Closed, the words go with it and the CLI ends the
   * command, so it is let go for other instructions only at a turn where it owes nothing (Nox's review).
   */
  owes(agentId: string, cli: CliConnection, sessionId: string): boolean {
    const key = ownKey(agentId, sessionId);
    return this.ownWords.unread(key) || (this.left.has(key) && this.left.commandsOf(cli) > 0);
  }

  /** A conversation ended — `/new`, `/reset`, a rollover, a delete — and its CLI session with it, kept or open. */
  forgetSession(agentId: string, gatewayId: string, chatId: string): void {
    const key = cliSessionKey(gatewayId, chatId);
    this.contexts.forget(agentId, key);
    const open = this.running.get(agentId);
    const sessionId = open?.sessionOf(key);
    if (sessionId) this.ownWords.forget(ownKey(agentId, sessionId));
    open?.forget(key);
    this.instructed.forget((at) => at === `${agentId}|${key}`);
    if (!(`${agentId}|${key}` in this.kept)) return;
    this.kept = Object.fromEntries(Object.entries(this.kept).filter(([kept]) => kept !== `${agentId}|${key}`));
    this.deps.sessions.save(this.kept);
  }

  lend(agentId: string, key: string, req: TurnRequest, deps: ExecutorDeps): () => void {
    return this.lent.begin(agentId, key, req, deps);
  }

  /**
   * Nouride's MCP server, as a session of this conversation is given it: only to a CLI that speaks MCP over HTTP, and
   * only where this box serves HTTP — without either, the CLI works without Nouride's tools.
   */
  mcpServers(agentId: string, key: string, connection: CliConnection): McpServer[] {
    const url = this.deps.mcpUrl?.();
    if (!url || !connection.info?.agentCapabilities?.mcpCapabilities?.http) return [];
    return [{ type: "http", name: "nouride", url, headers: this.lent.headers(agentId, key, connection.row.mcpEnvHeaders === true) }];
  }

  async keepPlan(key: { agentId: string; gatewayId: string; chatId: string }, steps: PlanStep[]): Promise<void> {
    await this.deps.keepPlan?.(key, "Current work", steps);
  }

  /** The agent's skills copied where its CLI reads them (`skills.ts`), one copy at a time per agent. */
  syncSkills(agent: LoadedAgent, row: CliRow): Promise<string[]> {
    return this.skillCopies.run(agent.config.id, async () => {
      // Read at each copy, as the prompt reads them at each turn: a SKILL.md added to the repository reaches the next one.
      const project = await (this.deps.projectSkills?.(agent) ?? Promise.resolve([])).catch(() => [] as Skill[]);
      return syncSkills(agent, row, this.skillsHome(agent, row), undefined, project);
    });
  }

  /**
   * A pack reloaded — a skill switched on or off on the Skills tab is one — and its skills copied now, so a CLI that
   * watches its skills folder (Claude Code does) has them before the next message rather than as it arrives.
   */
  reloaded(agent: LoadedAgent): void {
    const row = agent.config.external && this.row(agent.config.external.cli);
    // A profile not made yet — an agent that has not answered — gets its skills at its first message.
    if (!row?.skillsDir || statFile(this.skillsHome(agent, row))?.isDirectory !== true) return;
    void this.syncSkills(agent, row)
      .then((skipped) => skipped.length > 0 && log.warn("could not read some skills to give an external agent's CLI", { agent_id: agent.config.id, skills: skipped }))
      .catch((err: unknown) => log.warn("could not copy an external agent's skills to its CLI", { agent_id: agent.config.id, error: String(err) }));
  }

  /**
   * What the agent's CLI takes in a prompt besides text, as it said at its handshake — null for an agent no CLI
   * answers. Started for the asking: what a message's pictures are told depends on it, before the turn prompts. One
   * that will not start takes nothing; its turn says why.
   */
  async takes(agent: LoadedAgent): Promise<PromptTakes | null> {
    if (!agent.config.external) return null;
    return promptTakes(await this.connection(agent).then((cli) => cli.info, () => null));
  }

  /**
   * The agent's CLI, running: started on first use, started again when it exited or its pack changed what it runs — and
   * (0.8.11, RFC Part C §C.6) when the secrets it starts with changed, at a turn where nothing else of the agent is at
   * work. Its shell's environment is the one its process started with: a credential kept with `secret_save`, or set on
   * the Secrets page, reached it only when the process happened to start again. Its sessions reopen where the CLI keeps
   * them. Not while another turn works in one of its sessions, a session goes on by itself, or a command it left running
   * would end with it: a later turn starts it again.
   */
  async connection(agent: LoadedAgent): Promise<CliConnection> {
    const external = agent.config.external;
    if (!external) throw new Error(`${agent.config.id} is not an external agent`);
    const agentId = agent.config.id;
    const row = this.row(external.cli);
    if (!row) throw new Error(`${agentId}'s CLI "${external.cli}" is not one this install knows`);
    const held = this.updates.heldFor(row);
    if (held) throw new NourideError("external_agent", held, held);
    const profile = external.profile ?? "default";
    const secrets = this.deps.secretsFor(agentId, [row.command, ...row.args]);
    const stamp = secretsStamp(secrets);
    const current = this.running.get(agentId);
    if (current && !current.closed && current.row.id === row.id && current.launch.profileDir === launchFor({ row, profile, privateDir: this.privateDir(agentId), secrets: {} }).profileDir) {
      if (this.startedWith.get(agentId) === stamp || current.busy || current.held || this.left.commandsOf(current) > 0) return current;
      log.info("an external agent's CLI is started again: the secrets it starts with changed", { agent_id: agentId, cli: row.id });
    }
    if (current) {
      this.running.delete(agentId);
      void current.close();
    }
    const pending = this.starting.get(agentId);
    if (pending) return pending;
    const start = (async () => {
      const lent = row.mcpEnvHeaders && this.deps.mcpUrl?.() ? this.lent.env(agentId) : {};
      const launch = launchFor({ row, profile, privateDir: this.privateDir(agentId), secrets: { ...secrets, ...this.tokenEnv(row, profile), ...lent } });
      const connection = new CliConnection(row, launch, agentId, this.deps.spawn ?? spawnLongLived, this.deps.now);
      connection.onOwnWords = (sessionId, update) => {
        // It says what came of it: a stop from here cuts nothing of that session's off.
        if (update.sessionUpdate === "agent_message_chunk") this.left.reported(ownKey(agentId, sessionId));
        this.ownWords.heard(ownKey(agentId, sessionId), update);
      };
      try {
        await connection.open();
      } catch (err) {
        await connection.close();
        // Said as the person reads it — not installed, not signed in, what it printed — and kept as the agent's status.
        const reason = unavailableReason(row, err, connection.stderrTail);
        this.setUnavailable(agentId, reason);
        throw new NourideError("external_agent", reason, reason, { cause: err });
      }
      const failed = await this.updates.checkVersion(row, connection);
      if (failed) {
        await connection.close();
        this.setUnavailable(agentId, failed);
        throw new NourideError("external_agent", failed, failed);
      }
      this.running.set(agentId, connection);
      this.startedWith.set(agentId, stamp);
      this.startedWithEach.set(agentId, hashedEach(secrets));
      return connection;
    })();
    this.starting.set(agentId, start);
    try {
      return await start;
    } finally {
      this.starting.delete(agentId);
    }
  }

  /**
   * The CLI a turn prompts on (0.8.15, `fresh-secrets.ts`): where a secret changed since it started and another turn
   * still works in it, the turn waits for that one, so that the CLI starts again with it — up to `freshWaitMs` — and past
   * that goes on, told which variables its shell does not have yet. Not for a command the CLI left running: that may go
   * on for hours, and the turn is told at once instead.
   */
  async forTurn(agent: LoadedAgent, signal?: AbortSignal): Promise<{ cli: CliConnection; notYet: string[] }> {
    const now = this.deps.now ?? Date.now;
    const deadline = now() + (this.deps.freshWaitMs ?? FRESH_WAIT_MS);
    for (;;) {
      const cli = await this.connection(agent);
      const notYet = this.notYet(agent.config.id, cli);
      const blocked = cli.busy || cli.held;
      if (notYet.length === 0 || !blocked || this.left.commandsOf(cli) > 0 || now() >= deadline || signal?.aborted) return { cli, notYet };
      await pause(FRESH_POLL_MS, signal);
    }
  }

  private notYet(agentId: string, cli: CliConnection): string[] {
    const started = this.startedWithEach.get(agentId);
    return started && this.running.get(agentId) === cli ? notStartedWith(started, this.deps.secretsFor(agentId, [cli.row.command, ...cli.row.args])) : [];
  }

  /** Whether this box can hold a CLI's session — what Agents → Add → External and `nouride agents scan` ask first. */
  room(): CliRoom {
    const bytes = this.deps.room?.() ?? 0;
    // A box that will not say what it has is not refused on a number it never gave.
    return { enough: bytes === 0 || bytes >= CLI_SESSION_BYTES, bytes, needs: CLI_SESSION_BYTES };
  }

  /**
   * Every CLI this install knows, as this box has it: installed or not, which version, and where that version stands
   * against the ones this Nouride was tested with and the newest out (0.8.24). `check` asks the registry now, where it is
   * otherwise asked once a day (`newest.ts`); only about the CLIs installed here.
   */
  async scan(fresh = false, check = false): Promise<ScannedCli[]> {
    const now = (this.deps.now ?? Date.now)();
    if (fresh || !this.scanned || now - this.scanned.at > SCAN_MS) {
      const scan = this.deps.scan ?? ((row: CliRow) => scanCli(row));
      this.scanned = { at: now, clis: Promise.all(this.rows().map(scan)) };
    }
    return withStanding(await this.scanned.clis, this.deps.newest, check);
  }

  /**
   * Start a sign-in of the agent's CLI on one of its profiles — the one it answers with unless another is named — or
   * show the one running. When it ends signed in, that profile's check is asked again; on the profile in use, the CLI
   * that was running is stopped so the next turn starts it with the new sign-in.
   */
  startLogin(agent: LoadedAgent, profile?: string): ProfileLogin {
    const agentId = agent.config.id;
    const running = this.logins.get(agentId);
    if (running?.login.running) return { ...running.login.view(), profile: running.profile };
    const external = agent.config.external;
    if (!external) throw new NourideError("external_agent", `${agentId} is not an external agent`);
    const row = this.row(external.cli);
    if (!row) throw new NourideError("external_agent", `${agentId}'s CLI "${external.cli}" is not one this install knows`);
    if (!row.login?.length) {
      const why = `${row.name} has no sign-in Nouride can run${row.loginNote ? `. ${row.loginNote}` : ""}`;
      throw new NourideError("external_agent", why, why);
    }
    const inUse = external.profile ?? "default";
    const on = profile ?? inUse;
    const launch = launchFor({ row, profile: on, privateDir: this.privateDir(agentId), secrets: this.deps.secretsFor(agentId, [row.command, ...row.login]), args: row.login });
    const login = new CliLogin((this.deps.interactive ?? spawnInteractive)(launch.cmd, { cwd: launch.cwd, env: launch.env, agent: agentId }));
    this.logins.set(agentId, { login, profile: on });
    log.info("an external agent's sign-in started", { agent_id: agentId, cli: row.id, profile: on });
    const giveUp = setTimeout(contained(log, "could not stop a sign-in nobody finished", () => login.stop()), LOGIN_MS);
    void login.exited.then(
      async (code) => {
        clearTimeout(giveUp);
        log.info("an external agent's sign-in ended", { agent_id: agentId, cli: row.id, code, signed_in: login.signedIn });
        if (!login.signedIn) return;
        this.checks.delete(`${agentId}|${on}`);
        if (on !== inUse) return;
        this.setUnavailable(agentId, null);
        await this.stop(agentId);
      },
      () => clearTimeout(giveUp),
    ).catch((err: unknown) => log.warn("could not restart a CLI after its sign-in", { agent_id: agentId, error: String(err) }));
    return { ...login.view(), profile: on };
  }

  /** The agent's sign-in as it stands, or null where none was started since the daemon did. */
  login(agentId: string): ProfileLogin | null {
    const kept = this.logins.get(agentId);
    return kept ? { ...kept.login.view(), profile: kept.profile } : null;
  }

  /**
   * What the person sent back: a line for the sign-in — or, where it is the address of a page on this box the sign-in
   * sent the browser to (`callback.ts`), that page opened here, where the CLI is waiting for it.
   */
  async answerLogin(agentId: string, text: string): Promise<ProfileLogin> {
    const kept = this.logins.get(agentId);
    if (!kept) throw new NourideError("external_agent", `${agentId} has no sign-in running`, "No sign-in is running.");
    if (!kept.login.running) throw new NourideError("external_agent", "the sign-in has ended", "The sign-in has ended.");
    const address = returnAddress(text, kept.login.view().output);
    if (address) kept.login.say(await (this.deps.openOnBox ?? openOnBox)(address));
    else kept.login.answer(text);
    return { ...kept.login.view(), profile: kept.profile };
  }

  stopLogin(agentId: string): void {
    this.logins.get(agentId)?.login.stop();
  }

  /** A shared account's token, as the variable its CLI reads — for an agent on that account; none for any other. */
  private tokenEnv(row: CliRow, account: string): Record<string, string> {
    const token = this.accounts.token(row, account);
    return token && row.sharedLogin ? { [row.sharedLogin.env]: token } : {};
  }

  /** Every CLI with its accounts and the agents on each, for the Models page; `fresh` (Check again) asks the registry too. */
  async accountList(agents: readonly LoadedAgent[], fresh = false): Promise<CliAccountsView[]> {
    return this.accounts.list(this.rows(), await this.scan(fresh, fresh), agents, (agent) => this.profiles(agent, fresh));
  }

  /**
   * Sign a shared account in, or show the sign-in running: the CLI's `sharedLogin` words in a terminal, keyed
   * `@<cli>/<account>` beside the agents' own. Its token never reaches the page; once it ends signed in the token is
   * kept, and the CLIs of the agents on the account start again with it — and audited, with `actor`, who started it:
   * the CLI and the account, never the token or any part of it.
   */
  startAccountLogin(cli: string, account: string, actor: string): ProfileLogin {
    const key = `@${cli}/${account}`;
    const running = this.logins.get(key);
    if (running?.login.running) return { ...running.login.view(), profile: account };
    const row = this.row(cli);
    if (!row?.sharedLogin) throw new NourideError("external_agent", `${row?.name ?? cli} signs in once per agent, on the agent's Brain tab`, `${row?.name ?? cli} signs in once per agent, on the agent's Brain tab.`);
    const home = join(this.deps.workspaceDir(), ".cli-sign-in", `${cli}-${account}`);
    const launch = accountLaunch(row, home);
    const login = new CliLogin((this.deps.interactive ?? spawnInteractive)(launch.cmd, { cwd: launch.cwd, env: launch.env }), row.sharedLogin.tokenPrefix);
    this.logins.set(key, { login, profile: account });
    log.info("a coding-CLI account's sign-in started", { cli, account });
    const giveUp = setTimeout(contained(log, "could not stop a sign-in nobody finished", () => login.stop()), LOGIN_MS);
    void login.exited
      .then(async (code) => {
        clearTimeout(giveUp);
        const token = login.token();
        log.info("a coding-CLI account's sign-in ended", { cli, account, code, token_kept: Boolean(token && login.signedIn) });
        removePath(home);
        if (!login.signedIn || !token) return;
        await this.accounts.keepToken(row, account, token);
        this.deps.audit?.record({ action: "cli_account_signed_in", actor, details: { cli, account } });
        // Every check of this account is older than its sign-in, and its agents' CLIs started without it.
        for (const checked of this.checks.keys()) if (checked.endsWith(`|${account}`)) this.checks.delete(checked);
        for (const [agentId, connection] of this.running) {
          if (connection.row.id === cli && connection.launch.profileDir?.endsWith(`/${account}`)) await this.stop(agentId);
        }
      })
      .catch((err: unknown) => log.warn("could not keep an account's sign-in", { cli, account, error: String(err) }));
    return { ...login.view(), profile: account };
  }

  /**
   * The agent's profiles for its CLI, the one in use first, each with whether it is signed in. One at a time: each check
   * starts the CLI on its profile, a few hundred MB. A CLI whose profile is its HOME has the one.
   */
  async profiles(agent: LoadedAgent, fresh = false): Promise<CliProfile[]> {
    const external = agent.config.external;
    if (!external) throw new NourideError("external_agent", `${agent.config.id} is not an external agent`);
    const inUse = external.profile ?? "default";
    const row = this.row(external.cli);
    // Its own sign-in folders, and the accounts added on the Models page — any of which it may pick.
    const names = row?.profileEnv ? [...new Set([...profileNames(this.privateDir(agent.config.id), row.id, inUse), ...this.accounts.names(row.id)])] : [inUse];
    const profiles: CliProfile[] = [];
    for (const name of names) profiles.push({ name, inUse: name === inUse, ...(await this.check(agent, name, fresh)) });
    return profiles;
  }

  private check(agent: LoadedAgent, profile: string, fresh: boolean): Promise<Pick<CliProfile, "signedIn" | "reason">> {
    const key = `${agent.config.id}|${profile}`;
    const now = (this.deps.now ?? Date.now)();
    const kept = this.checks.get(key);
    // One still running is the answer to a fresh ask too: each ask started a CLI of its own, a few hundred MB each.
    if (kept && (!kept.settled || (!fresh && now - kept.at < CHECK_STANDS_MS))) return kept.check;
    const entry = { at: now, check: this.probe(agent, profile), settled: false };
    const settled = () => void (entry.settled = true);
    entry.check.then(settled, settled);
    this.checks.set(key, entry);
    return entry.check;
  }

  /**
   * Whether the CLI is signed in on a profile: its status words where its row has them, run as the agent on that
   * profile; then a session opened in the agent's folder, which a signed-out CLI refuses — no model is called. On the
   * profile in use it is the agent's own CLI, kept running as after a turn, and what it offers is kept for the model
   * field; another profile's is started for the check and stopped after it.
   */
  private async probe(agent: LoadedAgent, profile: string): Promise<Pick<CliProfile, "signedIn" | "reason">> {
    const agentId = agent.config.id;
    const row = this.row(agent.config.external?.cli ?? "");
    if (!row) return { signedIn: null, reason: `${agentId}'s CLI is not one this install knows` };
    const inUse = profile === (agent.config.external?.profile ?? "default");
    if (row.status?.length) {
      const said = await this.status(row, agentId, profile);
      if (said.signedIn !== true) {
        if (inUse && said.signedIn === false) this.noteUnavailable(agentId, said.reason);
        return said;
      }
      if (!inUse) return said;
    }
    let connection: CliConnection | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      connection = inUse ? await this.connection(agent) : await this.started(row, agentId, profile);
      const late = new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`it did not open a session in ${PROBE_MS / 1000} s`)), PROBE_MS);
      });
      const opened = await Promise.race([connection.probe(this.privateDir(agentId)), late]);
      const offered = inUse ? offeredModels(opened) : null;
      if (offered) this.models.keep(agentId, offered);
      if (inUse) this.noteUnavailable(agentId, null);
      return { signedIn: true, reason: null };
    } catch (err) {
      // `connection()` says why in its own words, the CLI's refusal its cause.
      const cause = err instanceof NourideError && err.cause !== undefined ? err.cause : err;
      const out = signedOut(row, cause);
      const reason = err instanceof NourideError ? err.message : unavailableReason(row, err, connection?.stderrTail ?? []);
      if (inUse && out) this.noteUnavailable(agentId, reason);
      return { signedIn: out ? false : null, reason };
    } finally {
      clearTimeout(timer);
      if (!inUse) await connection?.close();
    }
  }

  /** The row's status words, run as the agent on the profile: exit 0 signed in, a missing program not installed. */
  private async status(row: CliRow, agentId: string, profile: string): Promise<Pick<CliProfile, "signedIn" | "reason">> {
    const launch = launchFor({ row, profile, privateDir: this.privateDir(agentId), secrets: { ...this.deps.secretsFor(agentId, [row.command, ...(row.status ?? [])]), ...this.tokenEnv(row, profile) }, args: row.status ?? [] });
    try {
      // What it prints may name the account: only the exit is read.
      const out = await (this.deps.run ?? runCommand)(launch.cmd, { cwd: launch.cwd, env: launch.env, timeoutMs: PROBE_MS, maxOutputBytes: 4096, agent: agentId });
      if (out.exitCode === 0) return { signedIn: true, reason: null };
      if (out.exitCode === 127) return { signedIn: null, reason: unavailableReason(row, new Error("exit code 127"), []) };
      return { signedIn: false, reason: `${row.name} is not signed in. Sign in on the agent's Brain tab` };
    } catch (err) {
      return { signedIn: null, reason: unavailableReason(row, err, []) };
    }
  }

  /** The CLI on a profile the agent does not answer with, started for a check. */
  private async started(row: CliRow, agentId: string, profile: string): Promise<CliConnection> {
    const launch = launchFor({ row, profile, privateDir: this.privateDir(agentId), secrets: { ...this.deps.secretsFor(agentId, [row.command, ...row.args]), ...this.tokenEnv(row, profile) } });
    const connection = new CliConnection(row, launch, agentId, this.deps.spawn ?? spawnLongLived, this.deps.now);
    try {
      await connection.open();
      return connection;
    } catch (err) {
      await connection.close();
      throw new NourideError("external_agent", unavailableReason(row, err, connection.stderrTail), undefined, { cause: err });
    }
  }

  /** Stop the CLIs no prompt has used for the idle time. Each start again at the agent's next turn. */
  async stopIdle(now = (this.deps.now ?? Date.now)()): Promise<number> {
    let stopped = 0;
    for (const [agentId, connection] of this.running) {
      if (connection.closed) {
        this.running.delete(agentId);
        continue;
      }
      if (connection.busy || now - connection.lastUsed < (this.deps.idleMs ?? IDLE_MS)) continue;
      // A command it left running in the background would end with it, and what it says when that ends never come.
      if (this.left.commandsOf(connection) > 0) continue;
      this.left.ended(agentId);
      this.running.delete(agentId);
      await connection.close();
      stopped += 1;
      log.info("an external agent's CLI was stopped after a quiet spell", { agent_id: agentId, cli: connection.row.id });
    }
    return stopped;
  }

  /** The CLIs a restart waits for, as for a background job (0.8.6): stopped, a CLI takes its commands with it. */
  working(now = (this.deps.now ?? Date.now)()): { id: string; command: string; startedAt: number }[] {
    return this.left.working(this.running, now);
  }

  commandsOf(connection: CliConnection): number {
    return this.left.commandsOf(connection);
  }

  leftRunning(key: string, chat: OwnChat): void {
    this.left.note(key, chat);
  }

  /** The chats whose CLI's command the last process was stopped with — taken at the start, to be told. */
  interrupted(): OwnChat[] {
    return this.left.interrupted();
  }

  /** Stop one agent's CLI — its pack changed, it was put to sleep. */
  async stop(agentId: string): Promise<void> {
    const connection = this.running.get(agentId);
    this.running.delete(agentId);
    await connection?.close();
  }

  async stopAll(): Promise<void> {
    for (const { login } of this.logins.values()) login.stop();
    await Promise.all([...this.running.keys()].map((agentId) => this.stop(agentId)));
  }

  /** The idle sweep, every minute. */
  start(): ReturnType<typeof setInterval> {
    return setInterval(contained(log, "could not stop the idle external agents' CLIs", () => this.stopIdle()), 60_000);
  }

  private privateDir(agentId: string): string {
    return privateWorkspace(this.deps.workspaceDir(), agentId);
  }

  /** Where the agent's CLI keeps its own skills: under its profile folder, or its HOME — the agent's folder — where it has none. */
  private skillsHome(agent: LoadedAgent, row: CliRow): string {
    const privateDir = this.privateDir(agent.config.id);
    return row.profileEnv ? profileDirOf(privateDir, row.id, agent.config.external?.profile ?? "default") : privateDir;
  }
}

/** The secrets a CLI starts with, as one hash of their names and values: compared, never kept as they are (0.8.11). */
function secretsStamp(secrets: Record<string, string>): string {
  return sha256Text(JSON.stringify(Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))));
}
