#!/usr/bin/env bun
/**
 * Nouride engine entry point.
 *
 * Boot order follows §14.2 SPEC and shutdown follows §14.1. The *order* is the content of this
 * file — what a daemon starts, and in what sequence, is the part hardest to reason about from
 * scattered module side effects — so it stays one linear read, top to bottom.
 *
 * What has been lifted out is everything that is not ordering:
 *
 *   boot/preflight.ts      what must be true before a message can arrive
 *   boot/maintenance.ts    retention, backups, disk — the timers, and what they delete
 *   boot/tools.ts          the built-in toolset, wired to this daemon's stores
 *   boot/control-plane.ts  accounts, the setup wizard, config editing, the HTTP server
 *   boot/shutdown.ts       the signal handlers, and the order things stop in
 */

import { ensureDir, exitProcess, fileExists, isolateCommands, join, makeNonDumpable, setFileMode } from "@nouride/runtime";
import { privateWorkspace, skillsDirFor } from "@nouride/persona";
import { createGateways } from "@nouride/gateways";
import { bridgeOpener } from "@/modules/gateways/bridge.ts";
import { TransientSecrets } from "@nouride/secrets";
import { openSecretStore, settleSecretStore } from "@/boot/secret-store.ts";
import { installDirFor } from "@/modules/update/facts.ts";
import {
  addLogSink,
  configureLogger,
  createLogger,
  toUserMessage,
  ConfigError,
} from "@nouride/shared";
import { AgentRegistry } from "@nouride/persona";
import { resolveBuiltinSkillsDir } from "@nouride/persona";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import { FileService } from "@/modules/setup/files.ts";
import { setEffort } from "@/modules/setup/agent-effort.ts";
import { createPersonaTool } from "@/modules/tools/builtins/persona.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { SchemaDriftError } from "@/db/index.ts";
import { databaseEpoch } from "@/db/epoch.ts";
import { LOCAL_GATEWAY_ID, LocalGateway } from "@/modules/gateways/local.ts";
import { holdsDashboardLink, linksFor } from "@/modules/web/links.ts";
import { adminKeys, senderHasAccount } from "@/modules/people/match.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { Pipeline } from "@/modules/pipeline/index.ts";
import { McpManager } from "@/modules/tools/mcp.ts";
import { McpLogins } from "@/modules/mcp-oauth/index.ts";
import { McpLoginStore } from "@/modules/mcp-oauth/logins.store.ts";
import { ownSecretValues, setDataDir } from "@/modules/tools/credential-files.ts";
import { setSecretFields } from "@/modules/tools/exec-secrets.ts";
import { AutoApprove } from "@/modules/tools/auto-approve.store.ts";
import { RoomMentionStore } from "@/modules/pipeline/room-mention.store.ts";
import { LogBuffer } from "@/commons/log-buffer.ts";
import { LogStore } from "@/commons/logs.store.ts";
import { helperTrouble } from "@/modules/llm/helper-trouble.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { ChatEventStore } from "@/modules/chat-events/chat-events.store.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { RoomNameStore } from "@/modules/rooms/room-names.store.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { ChatAttachmentIndex } from "@/modules/attachments/chat-attachments.store.ts";
import { UploadStore } from "@/modules/web/control/uploads.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { todaysVerdict } from "@/modules/llm/budget.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { CandidateStore, DraftStore, ReflectionEngine, ReviewStore, ToolMemory } from "@/modules/reflection/index.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { keptApprovalsFile } from "@/modules/tools/approvals-kept.ts";
import { ToolGrantStore } from "@/modules/tools/tool-grants.store.ts";
import { GrantStore } from "@/modules/tools/grants.store.ts";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { AccessStore } from "@/modules/access/access.store.ts";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { JobWakeStore } from "@/modules/jobs/wakes.store.ts";
import { reportInterruptedJobs, wireJobs } from "@/boot/jobs.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { ProjectSkills } from "@nouride/persona";
import { CronScheduler } from "@/modules/cron/scheduler.ts";
import { detectSupervisor } from "@/service/supervisor.ts";
import { LAUNCHD_LOG_FILE } from "@/service/unit.ts";
import { Notifier } from "@/commons/notify.ts";
import { ApprovalPrompts } from "@/modules/tools/approval-prompts.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import { buildProposals } from "@/boot/proposals.ts";
import { startMorning } from "@/boot/morning-lines.ts";
import { agentsSeenState, alertCooldownsState, pausedAgentsState, spendAlertsState } from "@/commons/daemon-state.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { moveStateFiles } from "@/boot/state-files.ts";
import { settleInstallRoot } from "@/boot/install-root.ts";
import { AgentsSeen } from "@/commons/agents-seen.ts";
import { SpendAlerts } from "@/modules/llm/spend-alerts.ts";
import { bootMemory, checkMemoryVault, startKnowledgeLook } from "@/boot/memory.ts";
import { RoomWait } from "@/commons/room-wait.ts";
import { MemoryStateStore } from "@/modules/memory/memory-state.store.ts";
import { reportCommandIsolation } from "@/boot/commands-cgroup.ts";
import { catalogFromEnvironment } from "@/modules/mcp-registry/index.ts";
import { VaultFormatError } from "@/modules/memory/format.ts";
import { startMemoryPass } from "@/boot/memory-pass.ts";
import { BoxLoad } from "@/commons/box-load.ts";
import { ApprovalReach } from "@/modules/tools/reachability.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { NotesStore } from "@/modules/notes/store.ts";

import { refusingExternalOrchestrator, runPreflightChecks } from "@/boot/preflight.ts";
import { oauthReady, resolveOauthSupport } from "@/modules/users/oidc.ts";
import { resolveMultiUserSupport } from "@/modules/users/multi-user.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { resolveLinkedPlugins } from "@/boot/linked-plugins.ts";
import { busyWith, updateToolOptions, workingJobs } from "@/modules/update/self-update.ts";
import { DaemonRestart } from "@/modules/update/restart.ts";
import { requestRestart } from "@/boot/restart.ts";
import {
  checkDisk,
  startAgentBackups,
  startDatabaseBackups,
  startVaultBackups,
  startKnowledgeBackups,
  startConfigBackups,
  startDiskAlerts,
  startLogFileRotation,
  startRetentionSweep,
} from "@/boot/maintenance.ts";
import { buildTools } from "@/boot/tools.ts";
import { buildMissions } from "@/boot/missions.ts";
import { startPresence } from "@/boot/presence.ts";
import { startGateways } from "@/boot/gateways-start.ts";
import { SkillsWatch } from "@/boot/skills-watch.ts";
import { startControlPlane } from "@/boot/control-plane.ts";
import { secretKeepingFor } from "@/boot/secret-keeping.ts";
import { maskOutbound } from "@/commons/egress.ts";
import { startBundledGateway } from "@/boot/embedded-gateway.ts";
import { installShutdown } from "@/boot/shutdown.ts";
import { startExternalAgents } from "@/boot/external-agents.ts";
import { adminChatsOf } from "@/boot/admin-chats.ts";
import { takeDataDirLock } from "@/boot/lock.ts";
import { openRecorded } from "@/boot/last-run.ts";
import { assertUpgradeFloor, loadConfigPastTheFloor } from "@/boot/upgrade-floor.ts";
import { startApplianceIfPresent } from "@/boot/appliance.ts";
import { durableStores, recoverTurns, resumeAfterBoot } from "@/boot/durable.ts";
import { askKeptApprovals } from "@/boot/approvals-kept.ts";
import { VERSION } from "@/cli/version.ts";
import { settleAgentHome } from "@/boot/agent-home.ts";
import { settleToolchain } from "@/boot/toolchain.ts";
import { keptFolders, settleKeptFolders } from "@/boot/kept-folders.ts";
import { settleAgentUsers } from "@/boot/agent-users.ts";
import { childEnvFor } from "@/boot/child-env.ts";
import { checkAtBoot } from "@/boot/integrity.ts";
import { bindWebServer, type BootProgress } from "@/modules/web/server.ts";

export { drain } from "@/boot/shutdown.ts";

const log = createLogger("daemon");


export async function runDaemon(): Promise<void> {
  const startedAt = Date.now();
  // First, before anything is read into memory: no command the daemon starts may read its environment or memory
  // through `/proc` — see the function.
  const sealed = makeNonDumpable();
  // Before anything is spawned, and as early as it can be: what the daemon touches before it moves stays charged to
  // the unit, not to the cgroup that protects it (`process-cgroup.ts`).
  const commands = isolateCommands();
  const { config, source } = await loadConfigPastTheFloor();

  configureLogger({ level: config.daemon.logLevel, pretty: config.daemon.logPretty });
  log.info("starting", {
    name: config.daemon.name,
    config: source ?? "built-in defaults",
    data_dir: config.daemon.dataDir,
  });
  reportCommandIsolation(commands);
  if (!sealed && process.platform === "linux") {
    log.warn("could not make the daemon non-dumpable: the commands it runs may read its environment through /proc", {
      hint: "the exec gate still asks about /proc/<pid>/environ when it can see the path",
    });
  }

  ensureDir(config.daemon.dataDir);
  // Before anything is written or locked: data the last 0.7.x has not finished with is refused, with the way across
  // (`boot/upgrade-floor.ts`).
  await assertUpgradeFloor(config.daemon.dataDir);
  const lock = takeDataDirLock(config.daemon.dataDir);
  ensureDir(config.daemon.agentsDir);
  // The skill pool, so a fresh install has the directory a human is told to drop skills into. Created
  // rather than left to `skill_create`: an empty directory answers "where do these go", and a missing
  // one makes the documented path look wrong on every new box.
  ensureDir(skillsDirFor(config.daemon.agentsDir));
  // The shared directory has to exist before the first turn, not on first write: the prompt names it
  // as the working directory, and an agent told it is working somewhere that does not exist gets a
  // failure from its first relative path. `private/<id>/` is per-agent and created with the turn.
  ensureDir(join(config.daemon.workspaceDir, "shared"));

  // The port, now: everything below can take a while on a Pi, and `/health` says "starting" and which step (D1).
  const progress: BootProgress = { phase: "preparing the toolchain" };
  const web = config.dashboard.enabled ? bindWebServer(config, startedAt, progress) : undefined;

  // `.nouride/bin` on PATH, and `.nouride/home` as the agents' HOME — see the file for why both. Then
  // where installs land and the one PATH every command gets, which needs that HOME settled first.
  settleAgentHome(config);
  settleToolchain(config);

  const dbPath = join(config.daemon.dataDir, "nouride.db");
  progress.phase = "opening the database";
  // The vault's format before the schema: data this build refuses leaves both as they were, so the release that
  // brings it forward still starts on the database (`boot/memory.ts`).
  const vaultFormat = await checkMemoryVault(config);
  // Which version last ran here — for install.sh and the upgrade floor — recorded with the migration (`boot/last-run.ts`).
  const db = await openRecorded(config.daemon.dataDir, VERSION);
  // The daemon's own small state, in the database since 0.8.18: its files at the root of `data/` moved in by the first
  // start that has the table, before anything reads one; then where the install is, and every path the database names
  // renamed when it was moved from another folder (`boot/state-files.ts`, `boot/install-root.ts`).
  const state = new DaemonStateStore(db);
  moveStateFiles(config.daemon.dataDir, state);
  settleInstallRoot(config.daemon, db, state);
  // What agents' commands read, beside `data/` rather than in it, moved once with the rows that name it; then whether
  // each agent's commands run as its own user — before anything is handed a path in them (`boot/kept-folders.ts`,
  // `boot/agent-users.ts`).
  const kept = settleKeptFolders(config, db);
  for (const dir of [kept.jobs, kept.attachments, kept.toolOutput]) ensureDir(dir);
  const agentUsers = await settleAgentUsers({ config, kept: keptFolders(config), agent: (id) => registry.get(id) });
  // Encrypted at rest, its key from where the install keeps it; `secrets.json` moved once no update is pending (0.8.19).
  const secrets = await openSecretStore({ dataDir: config.daemon.dataDir, configPath: source ?? defaultConfigPath(), ...(process.env.HOME ? { home: process.env.HOME } : {}) });
  // Where the store and the control token are, so a command that names either is refused (`tools/credential-files.ts`).
  setDataDir(config.daemon.dataDir);
  // What is said about each secret, told with its name where an agent is told its credentials (0.8.19).
  setSecretFields((name) => secrets.describe(name)?.fields);
  // What people send in chat as secrets, held in memory under handles for an hour — `pipeline/chat-secrets.ts`. One, for
  // the pipeline that takes them, the tools that use them, and what leaves the daemon, which is masked of them.
  const heldSecrets = new TransientSecrets();
  // Every credential the daemon holds itself — the store's values, what the control token and the credentials
  // directory's files hold — which every tool's result is masked of; and with what was sent in chat, every credential it
  // knows: what each request a model is sent and each line a chat is sent is masked of (`commons/egress.ts`).
  const ownSecrets = () => ({ ...secrets.knownValues(), ...ownSecretValues() });
  const knownSecrets = () => ({ ...ownSecrets(), ...heldSecrets.values() });
  const providers = new ProviderRegistry(config.providers, secrets, undefined, knownSecrets);
  const sessions = new SessionStore(db);
  /**
   * What each turn did — steps, timings, and the answer as it is written.
   *
   * Beside the session store because it is the same history from the other side, and `interruptOrphaned`
   * runs here for the same reason the job store's does: rows left `running` by a daemon that died are a
   * client polling forever, and "still working" is the one lie a progress indicator must not tell.
   */
  // What turns do, as one stream a watcher subscribes to — and where their steps are kept (`turn-events.store.ts`).
  const events = new EventStore(db, Date.now, { epoch: databaseEpoch(dbPath) });
  const turns = new EventedTurnStore(db, events);
  // Turns committed as they run, messages written down on arrival, replies marked once they land — `boot/durable.ts`.
  const durable = durableStores(db, events);
  const chatEvents = new ChatEventStore(db);
  const rooms = new RoomStore(db);
  const roomMessages = new RoomMessageStore(db);
  // The conversation's list of files, which is what lets one agent open a file another one received
  // — see `ChatAttachmentIndex`. An index, not a second copy of the bytes.
  const attachmentIndex = new ChatAttachmentIndex(db);
  /**
   * First, the turns a dead process left with a journal: each is closed into its conversation with
   * everything it did, so the next message has it — `boot/durable.ts`. What is left `running` after this
   * has no journal (a build from before one existed) and is swept as before.
   */
  const recoveredTurns = recoverTurns({ ...durable, sessions, turns, maxTurns: config.security.maxConversationTurns });
  /**
   * Swept here, reported much later.
   *
   * The rows have to be marked before anything else boots — a dashboard polling one of them must not
   * be told "still working" for a second longer than necessary. But the people who were waiting on
   * those turns are on platforms this daemon has not connected to yet, so the addresses are held
   * until the gateways are up. See `boot/interrupted.ts`.
   */
  const orphanedTurns = turns.interruptOrphaned();
  // Recorded per provider call, each through `llm/metered.ts`. `llm_usage` had indexes and zero rows for the whole
  // of Phase 1, so `max_daily_cost_usd` described a budget nothing could enforce. Constructed here rather than beside
  // the pipeline because the retention sweep below runs before that point. Billing is read from the live profiles.
  const usage = new UsageStore(db, Date.now, events, (provider) => config.providers[provider]?.billing ?? "metered");

  // Checked at boot, before anything writes — unless the last run stopped cleanly and a check ran this week (E10).
  //
  // A corrupt page is silent until something reads it, so on a conversation store the failure
  // surfaces weeks later as turns that die for no visible reason — long after the backup that would
  // have fixed it was rotated away. Advisory, not fatal: refusing to start would take a daemon that
  // is mostly working entirely offline, and the operator can still read the alert and act.
  progress.phase = "checking the database";
  const integrity = checkAtBoot(db, config.daemon.dataDir);

  // Disk space, at boot and on the heartbeat — the check itself lives in `boot/maintenance.ts`.
  checkDisk(config);

  const reach = new ApprovalReach();

  const audit = new AuditLog(db, Date.now);
  audit.start();

  // The scheduler's jobs. Constructed here with the other stores, and started much later: reading
  // and validating the table costs nothing, while *firing* a job needs the gateways up — a reminder
  // that fires into a Discord instance still connecting is delivered nowhere.
  // One cache for the daemon: entries are keyed by directory, so two agents naming the same project
  // share the scan rather than each paying for it.
  const projectSkills = new ProjectSkills();

  const credentialsDir = kept.credentials;
  ensureDir(credentialsDir);
  // 0700: the daemon's own, and nobody else's. A world-readable credentials directory on a shared
  // box is the whole exercise undone. Where each agent is its own user, the helper keeps it `2750`, group `nr-creds`:
  // read by the agents allowed it, and by nobody else either.
  if (!agentUsers.finding.users) setFileMode(credentialsDir, 0o700);

  // What a command an agent runs may see of its credentials — see `boot/child-env.ts`.
  const childEnv = childEnvFor({
    credentialsDir,
    execSecrets: (agentId) => registry.get(agentId)?.config.execSecrets ?? [],
    sshAgent: (agentId) => registry.get(agentId)?.config.sshAgent === true,
    resolve: (name) => secrets.resolve(name),
  });

  const cron = new CronStore({ db, config: config.cron, timezone: config.daemon.timezone, audit });

  // Error-level logs also land in the audit table (§15.3 SPEC).
  addLogSink(audit.logSink);

  // Recent lines kept in memory so `nouride logs` works where there is no journal — Docker, macOS, an
  // LXC without systemd — and works remotely, which `journalctl` never does. A second reader, not a
  // replacement: everything still goes to stdout, so the platform keeps the full history.
  const logs = new LogBuffer();
  logs.attach();

  /**
   * …and the same lines on disk, so the window survives a restart.
   *
   * The ring above covers the last 2000 entries, which a reconnect storm can burn through in
   * minutes and a restart empties entirely — and both of those describe the moments somebody
   * actually needs the log. `[retention] log_days` bounds the table; the daily sweep enforces it.
   */
  const logStore = new LogStore(db);
  logStore.start();
  addLogSink(logStore.sink);

  const builtinSkillsDir = resolveBuiltinSkillsDir();
  const externalAgents = startExternalAgents({ config, state, childEnv, notes: () => notes, port: () => web?.server.port, commands, secrets, audit, projectSkills });
  progress.phase = "loading agents";
  const registry = await AgentRegistry.create({
    agentsDir: config.daemon.agentsDir,
    llmDefaults: config.llm.defaults,
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    knownProviders: () => providers.names(),
    knownGateways: config.gateways.map((g) => g.id),
    knownClis: () => externalAgents.rows().map((row) => row.id),
    // Read on every reload rather than captured: the dashboard's global switch edits this array in
    // place and then reloads the packs, and a snapshot would leave the change waiting for a restart.
    skillsOffGlobally: () => config.skills.off,
    // Kept in the database, so `/stop` holds through a restart (D15).
    pauses: pausedAgentsState(state),
    refuse: refusingExternalOrchestrator(config),
  });
  // Each agent's user and folders; an agent loaded later, when it loads. Not waited on: the first start hands every
  // agent's folders over — on the live box some 450,000 files — and the gateways connect meanwhile; a command that
  // comes first gets its folders from the helper itself, which does the same.
  const readyAgents = (agents: Parameters<typeof agentUsers.ready>[0]) =>
    void agentUsers.ready(agents).catch((err: unknown) => log.warn("could not make the agents ready as their own users", { error: String(err) }));
  readyAgents(registry.all());
  registry.onReloaded((agent) => readyAgents([agent]));
  // The order agents were made in, for Nouride Office (0.8.1): those here now at this start, each new one as it loads.
  const agentsSeen = new AgentsSeen(agentsSeenState(state));
  agentsSeen.note(registry.all().map((agent) => agent.config.id));
  registry.onReloaded((agent) => agentsSeen.note([agent.config.id]));
  // A skill switched on or off reaches an external agent's CLI as it is saved, not as its next message arrives (0.8.1).
  registry.onReloaded((agent) => externalAgents.reloaded(agent));
  // And a skill changed on disk, read again without a reload (0.8.13), reaches it the same way.
  registry.onSkillsChanged((agent) => externalAgents.reloaded(agent));
  const skillsWatch = new SkillsWatch({
    dirs: () => [skillsDirFor(config.daemon.agentsDir), ...(builtinSkillsDir ? [builtinSkillsDir] : [])],
    refresh: () => registry.refreshSkills(),
  });

  // Everything that has to be true before a message can arrive — see `boot/preflight.ts`.
  /**
   * The in-process LLM gateway, before anything asks a model anything — see `boot/embedded-gateway.ts`
   * for why it starts here, and for the first-run password it shares with the dashboard.
   */
  const { gateway: nougate, initialAdminPassword, credentialSharing } = await startBundledGateway({ config, db });

  /**
   * An edition that cannot do external sign-in, asked to do external sign-in.
   *
   * Refused rather than warned, and refused HERE rather than in `validate()`,
   * which is synchronous and runs before anything can ask the artefact what it
   * contains. The question is not "is this configured" — it is "does this build
   * carry the flow", and only a resolved import can answer that.
   *
   * The alternative is a daemon that boots on a config naming an issuer, a
   * client id and a secret, shows a password form and nothing else, and never
   * says why. Somebody would check the provider, the redirect URL and the
   * secret before suspecting the download.
   */
  if (!(await resolveOauthSupport()) && oauthReady(config.dashboard)) {
    throw new ConfigError(
      `[dashboard.oauth] is configured, but this build has no external sign-in. ` +
        `The Community and Router editions are built without it. Only the Pro editions carry ` +
        `the flow. Either clear the issuer, or run a Pro build.`,
    );
  }

  /**
   * Resolve multi-user support once, before any route can answer a `POST /users`.
   *
   * `multiUserSupported()` is synchronous and called from route handlers; the
   * dynamic import that backs it cannot be awaited there. Resolved here so the
   * answer is cached and ready before the server accepts anything.
   *
   * No refusal on missing support: the absence of the plugin is the correct
   * state for a Basic build, not a misconfiguration.
   */
  await resolveMultiUserSupport();

  // The same, for the plugins every edition links: a failure is a broken build, not a mode.
  await resolveLinkedPlugins(config);

  runPreflightChecks({ config, registry, providers, credentialsDir, state });

  const gateways = await createGateways(
    config.gateways,
    (name, usedBy) => secrets.require(name, usedBy),
    bridgeOpener,
  );

  // Registered like any other gateway so a CLI message takes the identical path.
  const localGateway = config.control.enabled && config.control.chat ? new LocalGateway() : undefined;
  if (localGateway) gateways.set(localGateway.id, localGateway);
  // Every line any of them is handed is masked of what the daemon knows — the CLI's own connection too.
  for (const gateway of gateways.values()) maskOutbound(gateway, knownSecrets);

  // Detected once at boot: the markers are set by whatever started this process and do not change
  // while it runs.
  const supervisorInfo = detectSupervisor({ inContainer: await fileExists("/.dockerenv") });
  log.info("supervisor detected", {
    kind: supervisorInfo.kind,
    restarts_on_exit: supervisorInfo.restartsOnExit,
    ...(supervisorInfo.evidence ? { evidence: supervisorInfo.evidence } : {}),
  });

  const attachments = new AttachmentStore({
    rootDir: kept.attachments,
    maxBytes: config.attachments.maxSizeMb * 1024 * 1024,
  });

  const { codeTtlMs, notifyCooldownMs, denyCooldownMs } = config.security.access;
  const access = new AccessStore({ db, audit, codeTtlMs, notifyCooldownMs, denyCooldownMs });
  // Expired codes and finished denials are noise on the Access page, and the useful signal gets buried
  // under them.
  access.tidy();

  // What the agents remember — one for the process. See `boot/memory.ts`.
  progress.phase = "loading memory";
  // The knowledge base's admins and its wait for room: who holds an admin's account is known once the accounts are
  // opened, and the box's load once it is sampled, both after memory is built (0.8.20).
  const knowledgeAt: { roleOf?: (accountId: string) => string | undefined; room: { wait?: () => Promise<unknown> } } = { room: {} };
  const memory = await bootMemory(config, db, {
    turns,
    roomMessages,
    providers,
    usage,
    people: { config, configPath: source ?? defaultConfigPath(), audit },
    vaultFormat,
    knowledge: { admins: () => adminKeys(config.people, (id) => knowledgeAt.roleOf?.(id)), room: knowledgeAt.room },
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    audit,
  });
  const knowledgeTimer = startKnowledgeLook(memory);

  // Snapshotted at boot and daily, because the most likely moment to lose a pack is while
  // somebody is editing it.
  progress.phase = "taking boot snapshots";
  const backupTimer = startAgentBackups(config);

  /**
   * And the database, which until now was the one thing here with no copy at all.
   *
   * After the boot check has run on the live file — or a clean stop has vouched for it — so the first
   * snapshot of each run is one taken with the original known good. And the memory vault beside it: the database only
   * indexes it, so the vault is the half of memory that cannot be rebuilt.
   */
  const dbBackupTimers = [
    startDatabaseBackups(config, db, Date.now, () => db.totalChanges() - logStore.rowsWritten()),
    startVaultBackups(config),
    startKnowledgeBackups(config),
    ...startConfigBackups(config, source ?? defaultConfigPath(), () => secrets.sealedCopyText()),
  ];
  // launchd has no journal: its log is a file, kept to one size here (E14).
  const logFileTimers = supervisorInfo.kind === "launchd" ? [startLogFileRotation(join(process.cwd(), LAUNCHD_LOG_FILE))] : [];

  // Constructed before the pipeline, and given its wake-up callback afterwards: the job store needs to
  // reach the pipeline, and the pipeline needs the job store for `exec background: true`.
  const jobWakes = new JobWakeStore(db);
  const jobs = new JobStore({ db, logDir: kept.jobs, audit, maxConcurrentPerAgent: 4, secrets: childEnv, limits: () => config.security.exec, maxMs: () => config.security.jobMaxMs });
  // Children died with the previous daemon, so a row left `running` would have an agent waiting on a
  // wake-up that can never arrive. Held rather than discarded: fixing the row is not the same as
  // telling the person, and the wake-up goes out below once the pipeline exists to carry it.
  const orphanedJobs = jobs.interruptOrphaned();

  /**
   * Where the dashboard's files land on the way to becoming attachments.
   *
   * In `data/`, unlike the jobs' logs and the tools' long output: what is here is the daemon's to read, copied into the
   * agent's attachments before any command is handed a path. Swept by the same daily pass.
   */
  const uploads = new UploadStore(join(config.daemon.dataDir, "uploads"));

  // Where a tool result too big for the context goes. Beside the jobs' logs because it is the same kind of
  // thing — a file the daemon wrote and handed the agent a path to — and swept by the same pass below.
  const spill = new ToolOutputSpill(kept.toolOutput);
  // Each conversation's work notes (0.7.26): read at every step of a turn, written by `notes` and `plan`, shown on the
  // dashboard, cleared by `/reset` — one store for all of them, so every write meets the same checks.
  const notes = new NotesStore(join(config.daemon.dataDir, "notes"));
  // The dashboard's accounts, read for a role and for who holds one; and the one rule for a dashboard link in a chat
  // (0.8.11, `web/links.ts`): a DM's person who holds an account, any group, the dashboard's own chat.
  const accounts = new UserStore({ db });
  knowledgeAt.roleOf = (id) => accounts.byId(id)?.role;
  const linkFor = linksFor({
    dashboard: () => ctx.config.dashboard,
    hasAccount: (who) => who.gatewayId === LOCAL_GATEWAY_ID || senderHasAccount(ctx.config.people, who, (id) => accounts.byId(id)?.role),
    chatTypeOf: (gatewayId, chatId) => pipeline.chatTypeOf(gatewayId, chatId),
  });
  // Long work an agent finishes alone (0.8.0): built before the pipeline, which shapes their turns — `boot/missions.ts`.
  const missions = buildMissions({
    db, config: () => ctx.config, registry, notes, jobs, approvals: () => approvals, notifier: { toChat: (to, text) => notifier.toChat(to, text), ask: (to, text, buttons) => notifier.ask(to, text, buttons), edit: (to, id, text) => notifier.edit(to, id, text) }, chatEvents, memory,
    jobAllowed: (jobId) => cron.get(jobId)?.allowed?.flatMap((allowance) => allowance.keys) ?? [],
    roomForCli: () => externalAgents.room().enough,
    forgetCliSession: (agentId, gatewayId, chatId) => externalAgents.forgetSession(agentId, gatewayId, chatId),
    freeToDelete: (agent) => externalAgents.freeToDelete(agent),
    cliSpentNow: (agentId, gatewayId, chatId) => externalAgents.spentNow(agentId, gatewayId, chatId),
    lastSaid: (gatewayId, chatId, senderId) => turns.lastSaid(gatewayId, chatId, senderId),
    turnStartedAt: (turnId) => turns.get(turnId)?.startedAt ?? null,
    childEnv,
    linkFor,
    audit,
  });
  gateways.set(missions.gateway.id, missions.gateway);

  // Swept at boot and daily. `retention_days` was a config value that deleted nothing for the whole

  /**
   * Where a proposed skill waits for a human — see `modules/reflection/`.
   *
   * Opened here rather than beside the engine it belongs to, because the retention sweep two lines
   * down prunes *decided* drafts and the sweep is built before the notifier the engine needs. The
   * table outlives the loop in any case: switch `[skills.learning]` off and the queue still has to be readable.
   */
  const drafts = new DraftStore(db);

  // Standing "stop asking me", per person. Constructed here beside the other stores so the pipeline
  // is handed one rather than reaching for a database handle it otherwise has no use for.
  const autoApprove = new AutoApprove({ db, audit });

  const grants = new GrantStore(db, audit);
  // Directory-scoped grants for tools that are not `exec`, so `always` on a `write` prompt means
  // something bounded rather than a policy change.
  const toolGrants = new ToolGrantStore({ db, audit });

  // After the gateways exist, because both of the daemon's outward paths need them: `canAsk` reads
  // their live status, and an approval notice has to be delivered through one. The previous order
  // put this first and reached forward to a `gateways` that was still undefined.
  const notifier = new Notifier({
    gateways,
    previewOff: (text) => holdsDashboardLink(ctx.config.dashboard, text),
    ...(config.alerts.gateway && config.alerts.chatId
      ? { owner: { gatewayId: config.alerts.gateway, chatId: config.alerts.chatId } }
      : {}),
    alertCooldownMs: config.alerts.cooldownMs,
    cooldowns: alertCooldownsState(state),
  });
  const spendAlerts = new SpendAlerts({
    alert: (key, text) => notifier.alert(key, text),
    spenders: (from) => usage.spenders(from),
    file: spendAlertsState(state),
    timezone: () => config.daemon.timezone,
  });

  /**
   * The supervised self-improvement loop.
   *
   * After the notifier because a new draft is announced in the conversation that produced it, and
   * before the pipeline because the pipeline hands it every finished turn. Constructed even when
   * `[skills.learning] mode = "off"`: the drafts already in the table still have to be listable and decidable
   * after somebody switches the loop off, and a queue that becomes unreachable is a queue that
   * silently keeps whatever was in it.
   */
  const reflection = new ReflectionEngine({
    config: config.skills.learning,
    // Held by reference, as the section above: a save changes it in place (`config/follow.ts`).
    llmDefaults: config.llm.defaults,
    drafts,
    toolMemory: new ToolMemory(db),
    candidates: new CandidateStore(db),
    reviews: new ReviewStore(db),
    lastRead: (paths) => audit.skillReads(paths),
    registry,
    providers,
    agentsDir: config.daemon.agentsDir,
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    audit,
    usage,
    spend: () => todaysVerdict(usage, config),
    notifier,
  });

  // On the heartbeat, alerted rather than only logged: a full disk makes every other symptom
  // confusing, and it is entirely preventable with warning.
  const diskTimer = startDiskAlerts(config, notifier);

  if (!integrity.ok) {
    void notifier.alert(
      "db_integrity",
      `the database at ${dbPath} failed its integrity check: ${integrity.detail}. Restore from a backup.`,
    );
  }

  // The prompt in the chat — with Approve and Deny where the connection carries buttons — its presses, and its rewrite
  // once settled (G11). Reads the gate and the pipeline, built below, only when a question or a press comes.
  const prompts = new ApprovalPrompts({
    gateways,
    notifier,
    approvals: () => approvals,
    voice: (agentId, gatewayId) => pipeline.voiceGatewayId(agentId, gatewayId),
    isAdmin: (who) => pipeline.isAdmin(who),
    askedIn: missions.askedIn,
    missionOf: missions.missionOf,
    similar: missions.similar,
    // A question only an admin answers, in each admin's own chat too (0.8.10).
    adminChats: adminChatsOf({ config: () => config, gateways, turns, isAdmin: (who) => pipeline.isAdmin(who) }),
  });
  // A proposed job's card, with Turn on and Discard, and the `schedule` tool that posts it (0.8.0).
  const proposals = buildProposals({ cron, notifier, registry, timezone: () => config.daemon.timezone, pipeline: () => pipeline, linkFor });
  const approvals = new SqliteApprovalGate({
    db,
    timeoutMs: config.security.approvalTimeoutMs,
    audit,
    grants,
    toolGrants,
    // A job's guard answered "always" (0.8.0): on the job, a standing yes for its runs to send there.
    jobGrants: { allow: (grant, by) => void cron.allow(grant.jobId, grant, by) },
    // What 0.8.17 handed over at its last clean shutdown, for requests asked before the upgrade: read once (0.9.0 deletes).
    oldHandOver: keptApprovalsFile(config.daemon.dataDir),
    allowedBefore: missions.allowedBefore,
    // Not "is a gateway connected": the local gateway is an in-process object and reports connected
    // unconditionally, so that test was always true and nothing was ever refused for want of anyone to ask. Real chat
    // gateways count because a prompt would land in front of somebody; the local one counts only when
    // something is actually polling for approvals. See `ApprovalReach`.
    canAsk: () =>
      reach.canAsk(
        [...gateways.values()].some(
          (gateway) => gateway.platform !== "web" && gateway.status === "connected",
        ),
      ),
    // Into the conversation the turn belongs to, under the asking agent's own name — `approval-prompts.ts` says why. One
    // question at a time in the chat it is put to, a mission's as well (`askedIn`); the one shown says how many wait.
    onRequest: (notice) => void prompts.post(notice),
    onBehind: (id, behind) => prompts.behind(id, behind),
    askedIn: missions.askedIn,
    onSettled: (request, settlement) => prompts.settled(request, settlement),
    /**
     * A `yes` that arrived after the turn stopped waiting.
     *
     * The turn holds back a slice of its own deadline so the model can report and carry on rather
     * than dying mid-call — but the question stays open, and an answer to it is worth nothing unless
     * something acts on it. This puts the agent back on the job: same conversation, as a system
     * event, so a reply is optional and nothing is said if there is nothing to add.
     *
     * Denials wake it too. "They said no" is information the agent should have before it plans its
     * next move, and finding out by trying again is how an agent argues with a person who has
     * already answered.
     */
    onLateAnswer: (request, decision, by) => {
      pipeline.resumeAfterApproval(request, decision, by);
    },
  });

  /**
   * At boot and daily. Everything this daemon writes that only ever grows is swept here.
   *
   * After the approval gate rather than before it, which is why this moved: the first sweep runs
   * immediately, and it now prunes settled approvals too.
   */
  const retentionTimer = startRetentionSweep({
    config, attachments, attachmentIndex, usage, sessions, turns, chatEvents, roomMessages, jobs, spill, uploads, audit, approvals, logs: logStore, cron, drafts, inbox: durable.inbox, missions: missions.store,
    memoryChanges: new MemoryStateStore(db),
    notes,
    skillReview: reflection.library,
  });
  // Whether the machine is busy, for the night's pass and background helpers to make room for it (0.8.0) — sampled from
  // here, so the first look has the minute before it.
  const load = new BoxLoad();
  const loadTimer = load.start();
  // Embedding new documents waits while the box is busy, as the night's pass does, for at most two hours a run.
  knowledgeAt.room.wait = () => new RoomWait(load, { what: "embedding the knowledge base", ceilingMs: 2 * 3_600_000, now: Date.now }).wait();
  const memoryPass = startMemoryPass({ config, registry, providers, usage, turns, memory, db, load });
  // Each person's morning line, at the time they set (0.8.0): what happened while they were away.
  const morningTimer = startMorning({ config: () => config, gateways, notifier, turns, cron, missions: missions.store, approvals: () => approvals, usage, pipeline: () => pipeline, state });
  // What a previous run left pending: kept when young enough to answer, expired when not — asked again, or said lost,
  // once the gateways are up (D8, `boot/approvals-kept.ts`).
  const keptApprovals = approvals.carryOver();

  const ctx: DaemonContext = {
    config,
    db,
    gateways,
    startedAt,
    configSource: source,
    status: "starting",
    integrity,
    agentCount: registry.active().length,
    agents: { active: () => registry.active().length, failed: () => registry.loadFailures().map((failure) => failure.id) },
    providerErrors: new Map(),
    journal: durable.journal,
    events,
    helpers: () => helperTrouble(logStore, config, Date.now()),
    commands,
    agentUsers: { through: agentUsers.finding.users?.through ?? null, reason: agentUsers.finding.reason },
    backgroundTimers: [retentionTimer, backupTimer, ...dbBackupTimers, ...logFileTimers, diskTimer, memoryPass.timer, morningTimer, knowledgeTimer, ...(loadTimer ? [loadTimer] : [])],
  };
  // The copy sealed to the backup password made again at each change, and `secrets.json` moved once no update is
  // pending (`boot/secret-store.ts`). After the context, which holds the seal as settings change it.
  const secretStoreTimer = settleSecretStore(secrets, { dataDir: config.daemon.dataDir, installDir: installDirFor(config.daemon.dataDir), version: VERSION, seal: () => ctx.config.daemon.backupSeal });
  if (secretStoreTimer) ctx.backgroundTimers.push(secretStoreTimer);

  // The pipeline is constructed before the tools that reference it: `session_status` needs
  // live session facts, and the pipeline needs the tool map. The cycle is broken by passing
  // a closure rather than the object.
  // Before the pipeline, because the toolset it hands to every turn has to be able to reach these.
  // Connecting is per agent and never fatal: a server that will not start takes its own tools out of
  // circulation and leaves everything else running.
  // Remote servers' logins (0.7.19): the credential each is reached with, and the logins a person makes from the MCP page.
  const mcpLogins = new McpLogins({ store: new McpLoginStore(db), secrets, registry, agentsDir: config.daemon.agentsDir, dashboard: config.dashboard, audit, notifier });
  const mcp = new McpManager({
    timeoutMs: config.security.toolTimeoutMs,
    liveToolGrants: (agentId) => toolGrants.liveKeys(agentId),
    // Only an HTTP server with `auth_secret` reaches for this; a stdio server never does.
    secrets,
    audit,
    logins: mcpLogins,
    privateDir: (agentId) => privateWorkspace(config.daemon.workspaceDir, agentId),
  });
  progress.phase = "connecting MCP servers";
  await mcp.connectAll(registry.all());

  // Reconnect whenever a pack is reloaded, so an agent's edited MCP switches (`mcp.toml`) actually take effect.
  // `connectAgent` disconnects first, so this replaces the old child rather than accumulating them.
  registry.onReloaded((agent) => {
    void mcp
      .connectAgent(agent)
      .catch((err: unknown) =>
        log.error("mcp reconnect after reload failed", {
          agent_id: agent.config.id,
          error: String(err),
        }),
      );
  });

  ctx.mcp = mcp;

  const pipeline = new Pipeline({
    // Read for a role only: whether a chat sender is an admin, for `/daemon-restart`.
    users: accounts,
    memory,
    load,
    cronJobs: cron,
    jobWakes,
    config,
    registry,
    providers,
    sessions,
    turns,
    ...durable,
    chatEvents,
    rooms,
    roomMessages,
    approvals,
    grants,
    toolGrants,
    notifier,
    spendAlerts,
    attachments,
    attachmentIndex,
    access,
    jobs,
    spill,
    notes,
    shaper: missions.missions,
    missionCommands: missions.missions,
    scheduleCommands: proposals.cards,
    missionTools: missions.tools,
    scheduleTool: proposals.tool,
    // An agent's change to its own persona goes to an admin, and through the Files tab's one write once approved (0.8.8).
    personaTool: createPersonaTool({ files: new FileService({ agentsDir: config.daemon.agentsDir, configPath: source ?? defaultConfigPath(), registry, config, audit }) }),
    externalAgents,
    // `/effort … lock` (0.8.17) writes the agent's own effort the way its Model tab does, audited.
    agentEffort: (agentId, effort, actor) => setEffort({ registry, audit }, { agentId, effort, actor }),
    usage,
    mcp,
    autoApprove,
    roomMention: new RoomMentionStore(db),
    roomNames: new RoomNameStore(db),
    childEnv,
    heldSecrets,
    ownSecrets,
    secretKeeping: secretKeepingFor({ secrets, audit, registry }),
    credentialsDir,
    projectSkills,
    // So `read` can open the skills this build ships with — they are advertised by path and were
    // refused by the sandbox. See `PipelineDeps.builtinSkillsDir`.
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    reflection,
    tools: new Map(),
    gateways,
    startedAt,
    version: VERSION,
    providerErrors: ctx.providerErrors,
    // A Box writes a partial answer less often — set once the plugin has loaded, after this is built (E7).
    appliance: () => ctx.appliance !== undefined,
  });

  // One restart for the dashboard, `nouride restart`, `/daemon-restart` and an agent's `--then`, waiting for this
  // pipeline to go idle — so built after it, and handed back to it for the chat command. `modules/update/restart.ts`.
  pipeline.restart = new DaemonRestart({ requestRestart, supervisor: () => supervisorInfo, busy: busyWith(pipeline, jobs), jobs: workingJobs(jobs, pipeline), audit, ...(config.cron.enabled ? { cron } : {}) });

  // The job store and the pipeline, joined now that both exist: completions, and the watchdog for the
  // ones still running. The jobs the previous daemon left behind wait for the inbox. See `boot/jobs.ts`.
  ctx.backgroundTimers.push(wireJobs({ jobs, registry, config: () => ctx.config, pipeline }));
  // What an external agent's CLI says by itself, between turns, wakes its chat as a job's end does.
  externalAgents.onOwnWords = (chat) => pipeline.wakeForOwnWords(chat);
  // What a mission's CLI turn has spent, as the CLI says it: its limits read then, not only at the minute's check.
  externalAgents.onSpent = (_agentId, gatewayId, chatId) => missions.cliSpent(gatewayId, chatId);

  // Constructed here and started much later. It needs the pipeline (to run turns) and the tool
  // registry needs it (so a job can be forced to run), which is a cycle only if construction and
  // starting are the same act. They are not: building it touches nothing.
  const scheduler = new CronScheduler({
    store: cron,
    config: config.cron,
    // A `mission` job's run starts a mission (0.8.0); the rest run through the pipeline.
    executors: { ...pipeline.cronExecutors(), startMission: missions.runJob },
    audit,
  });


  // Built after the pipeline and handed back to it: `session_status` needs live session facts
  // while the pipeline needs the tool map. See `boot/tools.ts`.
  // The agent asking for an update is in a turn of its own: waiting for idle lets it answer before the restart.
  // The MCP catalog, asked of Nouverse (`modules/mcp-registry`): the Explore tab, the CLI, `mcp_search`.
  const mcpCatalog = catalogFromEnvironment(process.env);
  const updateTool = updateToolOptions({ dataDir: config.daemon.dataDir, cron, requestRestart, busy: busyWith(pipeline, jobs), jobs: workingJobs(jobs, pipeline) });
  const tools = buildTools({
    config, secrets, registry, providers, pipeline, approvals, grants, toolGrants,
    jobs, memory, turns, audit, childEnv, heldSecrets, ownSecrets, reflection, mcp, mcpCatalog, notes, linkFor,
    configPath: source ?? defaultConfigPath(),
    isolateHelper: missions.isolateHelper,
    // Fresh each time: a CLI installed a minute ago is one an agent can be made on now.
    clis: () => externalAgents.scan(true),
    cliModels: (agentId, cli) => ({ name: externalAgents.row(cli)?.name ?? cli, offered: externalAgents.models.of(agentId), runsOn: externalAgents.models.runsOn(agentId) }),
    // Undefined when this build has no update provider, and then the tool is not offered at all
    // rather than offered and answering "not available in this build".
    ...(updateTool ? { update: updateTool } : {}),
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
  });
  pipeline.setTools(tools);
  missions.connect(pipeline, tools, usage);
  pipeline.attach();
  // Every connection's presses: an approval's to its prompt, a proposal's to its card.
  routePresses(gateways.values(), [prompts, proposals.cards, ...missions.presses(pipeline)]);

  // Gateways start concurrently and independently, and the boot waits for them a bounded time: one slow to connect
  // keeps connecting on its own instead of holding up the others, the dashboard and everything below.
  progress.phase = "connecting gateways";
  await startGateways(gateways);
  if (gateways.size === 0) {
    log.info("no gateways enabled: add a [gateways.<platform>.<name>] block to config.toml");
  }

  /**
   * Now that there is something to send it through: tell whoever was waiting on a turn the last
   * process did not live to finish.
   *
   * Not awaited. A platform that is slow to accept this must not delay the daemon reaching `ready`,
   * and there is nothing further that depends on it — the rows were already corrected above.
   */
  // The approvals it kept, first, so a turn taken up below finds its question already back in front of the person.
  askKeptApprovals({ approvals, ...keptApprovals, notifier, chatEvents, voice: (agentId, gatewayId) => pipeline.voiceGatewayId(agentId, gatewayId) });
  // Then what else the restart owes: reports, undelivered replies, the inbox — `boot/durable.ts`.
  void resumeAfterBoot({ recovered: recoveredTurns, orphaned: orphanedTurns.conversations, stores: durable, startedAt, pipeline, turns, notifier, chatEvents, keptFor: (turn) => approvals.keptFor(turn) });
  // After the inbox it reopened, so a message from before the restart is ahead of these.
  reportInterruptedJobs({ jobs, orphanedJobs, pipeline, wakes: jobWakes, audit });
  // And the commands external agents' CLIs had left running, which the last process was stopped with.
  for (const chat of externalAgents.interrupted()) pipeline.wakeForCliStopped(chat);
  // Then the missions that were running: each goes on from its page, and their timer starts — and each bot shows its agent.
  ctx.backgroundTimers.push(
    missions.begin(recoveredTurns),
    startPresence({ gateways, config: () => ctx.config, status: (id) => pipeline.agentStatus(id) }),
    skillsWatch.start(),
  );


  // Started only now, and the ordering is the whole point: a job due the moment the daemon comes up
  // would otherwise fire into a Discord client still connecting and be recorded as delivered. Its
  // catch-up logic then decides what to do about anything that came due while the process was down.
  scheduler.start();

  progress.phase = "starting the control plane";
  const controlPlane = await startControlPlane({
    ...(web ? { web } : {}),
    initialAdminPassword,
    gatewayUrl: nougate?.url,
    ...(nougate ? { gateway: nougate } : {}),
    ...(credentialSharing ? { credentialSharing } : {}),
    ctx, db, config, configSource: source, secrets, registry, providers, pipeline, approvals,
    grants, toolGrants, access, memory, memoryPass, jobs, notifier, audit, logs, logStore, mcp, reach, projectSkills,
    builtinSkillsDir, autoApprove, sessions, notes, missions: missions.missions, externalAgents, turns, events, chatEvents, roomMessages, attachmentIndex, rooms, usage, uploads, cron, scheduler, proposals: proposals.cards, localGateway,
    supervisorInfo, reflection, mcpCatalog, mcpLogins, agentsSeen, state,
    builtinTools: tools,
  });
  const { server, streams } = controlPlane;

  ctx.status = "ready";

  log.info("nouride ready", {
    agents: registry.active().map((a) => a.config.id),
    gateways: [...gateways.keys()],
    providers: providers.available().filter((p) => p.hasCredential).map((p) => p.name),
    uptime_ms: Date.now() - startedAt,
  });

  // What each agent's gateway says about its models, asked now so the first turns are budgeted by it (G2). In the
  // background, after the bundled gateway is up: one that is down costs the boot nothing, and the table answers till then.
  for (const profile of new Set(registry.active().map((agent) => agent.config.llm.provider))) void providers.catalog.listing(profile);

  await startApplianceIfPresent(ctx, VERSION, nougate, { pipeline, jobs, requestRestart });

  installShutdown(ctx, db, pipeline, audit, approvals, jobs, server, lock, scheduler, nougate, logStore, streams);
}

/**
 * Only boot when this file *is* the program.
 *
 * `nouride start` imports `runDaemon` from here, and without this guard the import alone started a
 * daemon — then the CLI started a second one, which failed with a bare EADDRINUSE and a stack
 * trace pointing at the HTTP adapter rather than at the double boot.
 */
if (import.meta.main) {
  runDaemon().catch((err) => {
    /**
     * A refusal is not a crash, and printing it as one buries the answer.
     *
     * `SchemaDriftError` is a paragraph written for the person looking at a box that will not
     * start, naming both ways out — and so is `VaultFormatError`, for a memory vault this build does not
     * read. Under a stack trace, on a systemd unit restarting every five seconds, that paragraph is
     * four lines of journal among forty of trace.
     */
    if (err instanceof SchemaDriftError || err instanceof VaultFormatError) {
      log.error("fatal: boot refused", { error: err.message });
      console.error(`\n${err.message}\n`);
      exitProcess(1);
      return;
    }
    // Boot failures are the one place a stack trace belongs in the log: there is no chat user to
    // protect yet, and the alternative is a daemon that exits silently.
    log.error("fatal: boot failed", { error: String(err), user_message: toUserMessage(err) });
    console.error(err);
    exitProcess(1);
  });
}
