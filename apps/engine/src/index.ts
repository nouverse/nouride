#!/usr/bin/env bun
/**
 * Nouride engine entry point.
 *
 * Boot order follows §14.2 SPEC and shutdown follows §14.1. The *order* is the content of this
 * file — what a daemon starts, and in what sequence, is the part hardest to reason about from
 * scattered module side effects — so it stays one linear read, top to bottom.
 *
 * Its three long steps each have a file, and what is left here is the sequence around them:
 *
 *   boot/stores.ts         opening the stores: the database and everything kept in it or beside it
 *   boot/timers.ts         starting the timers: snapshots, sweeps, the night's pass, the morning lines
 *   boot/turn-machine.ts   building the turn machine: its parts, then the pipeline, the scheduler and the tools
 *
 * And what is not ordering at all:
 *
 *   boot/preflight.ts      what must be true before a message can arrive
 *   boot/maintenance.ts    retention, backups, disk — the timers, and what they delete
 *   boot/tools.ts          the built-in toolset, wired to this daemon's stores
 *   boot/control-plane.ts  accounts, the setup wizard, config editing, the HTTP server
 *   boot/shutdown.ts       the signal handlers, and the order things stop in
 */

import { ensureDir, exitProcess, fileExists, isolateCommands, join, makeNonDumpable } from "@nouride/runtime";
import { AgentRegistry, ProjectSkills, resolveBuiltinSkillsDir, skillsDirFor } from "@nouride/persona";
import { createGateways } from "@nouride/gateways";
import { configureLogger, createLogger, toUserMessage, ConfigError } from "@nouride/shared";
import { bridgeOpener } from "@/modules/gateways/bridge.ts";
import { settleSecretStore } from "@/boot/secret-store.ts";
import { installDirFor } from "@/modules/update/facts.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { SchemaDriftError } from "@/db/index.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { adminKeys } from "@/modules/people/match.ts";
import { helperTrouble } from "@/modules/llm/helper-trouble.ts";
import { reportInterruptedJobs } from "@/boot/jobs.ts";
import { detectSupervisor } from "@/service/supervisor.ts";
import { agentsSeenState, pausedAgentsState } from "@/commons/daemon-state.ts";
import { AgentsSeen } from "@/commons/agents-seen.ts";
import { bootMemory } from "@/boot/memory.ts";
import { reportCommandIsolation } from "@/boot/commands-cgroup.ts";
import { VaultFormatError } from "@/modules/memory/format.ts";
import { refusingExternalOrchestrator, runPreflightChecks } from "@/boot/preflight.ts";
import { oauthReady, resolveOauthSupport } from "@/modules/users/oidc.ts";
import { resolveMultiUserSupport } from "@/modules/users/multi-user.ts";
import { resolveLinkedPlugins } from "@/boot/linked-plugins.ts";
import { requestRestart } from "@/boot/restart.ts";
import { startPresence } from "@/boot/presence.ts";
import { startGateways } from "@/boot/gateways-start.ts";
import { SkillsWatch } from "@/boot/skills-watch.ts";
import { startControlPlane } from "@/boot/control-plane.ts";
import { maskOutbound } from "@/commons/egress.ts";
import { startBundledGateway } from "@/boot/embedded-gateway.ts";
import { installShutdown } from "@/boot/shutdown.ts";
import { startExternalAgents } from "@/boot/external-agents.ts";
import { takeDataDirLock } from "@/boot/lock.ts";
import { assertUpgradeFloor, loadConfigPastTheFloor } from "@/boot/upgrade-floor.ts";
import { startApplianceIfPresent } from "@/boot/appliance.ts";
import { resumeAfterBoot } from "@/boot/durable.ts";
import { askKeptApprovals } from "@/boot/approvals-kept.ts";
import { VERSION } from "@/cli/version.ts";
import { settleAgentHome } from "@/boot/agent-home.ts";
import { settleToolchain } from "@/boot/toolchain.ts";
import { openStores } from "@/boot/stores.ts";
import { startSnapshots, startUpkeep } from "@/boot/timers.ts";
import { buildTurnMachine, buildTurnParts } from "@/boot/turn-machine.ts";
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

  // The port, now: everything below can take a while on a Pi, and `/health` says "starting" and which step.
  const progress: BootProgress = { phase: "preparing the toolchain" };
  const web = config.dashboard.enabled ? bindWebServer(config, startedAt, progress) : undefined;

  // `.nouride/bin` on PATH, and `.nouride/home` as the agents' HOME — see the file for why both. Then
  // where installs land and the one PATH every command gets, which needs that HOME settled first.
  settleAgentHome(config);
  settleToolchain(config);

  // The config file this daemon reads and writes: the one it started from, or where one would be.
  const configPath = source ?? defaultConfigPath();

  // Opening the stores (`boot/stores.ts`). An agent is read from the registry, which loads below, only once a command runs.
  const stores = await openStores({ config, configPath, progress, agent: (id) => registry.get(id) });
  const {
    db, state, agentUsers, secrets, knownSecrets, providers, sessions, events, turns, durable, chatEvents, rooms,
    roomMessages, attachmentIndex, recoveredTurns, orphanedTurns, usage, integrity, audit, credentialsDir, childEnv, cron,
    logs, logStore, access, jobWakes, jobs, uploads, notes, accounts, autoApprove, grants, toolGrants,
  } = stores;

  const builtinSkillsDir = resolveBuiltinSkillsDir();
  // One cache for the daemon: entries are keyed by directory, so two agents naming the same project
  // share the scan rather than each paying for it.
  const projectSkills = new ProjectSkills();
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
    // Kept in the database, so `/stop` holds through a restart.
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
    people: { config, configPath, audit },
    vaultFormat: stores.vaultFormat,
    knowledge: { admins: () => adminKeys(config.people, (id) => knowledgeAt.roleOf?.(id)), room: knowledgeAt.room },
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    audit,
  });

  // Starting the timers, the snapshots first (`boot/timers.ts`): the first copy of a run is of what the boot found.
  progress.phase = "taking boot snapshots";
  const snapshotTimers = startSnapshots({ config, db, logStore, configPath, secrets, supervisor: supervisorInfo });

  // Children died with the previous daemon, so a row left `running` would have an agent waiting on a
  // wake-up that can never arrive. Held rather than discarded: fixing the row is not the same as
  // telling the person, and the wake-up goes out below once the pipeline exists to carry it.
  const orphanedJobs = jobs.interruptOrphaned();
  knowledgeAt.roleOf = (id) => accounts.byId(id)?.role;

  // Building the turn machine, its parts first (`boot/turn-machine.ts`): the timers below sweep and alert through them.
  // The context and the pipeline come after them, so each is read through its name only once it is used.
  const parts = buildTurnParts(stores, { config, contextConfig: () => ctx.config, registry, gateways, memory, externalAgents, builtinSkillsDir, pipeline: () => pipeline });
  const { missions, notifier, reflection, reach, proposals, approvals } = parts;

  if (!integrity.ok) {
    void notifier.alert(
      "db_integrity",
      `the database at ${stores.dbPath} failed its integrity check: ${integrity.detail}. Restore from a backup.`,
    );
  }

  // The rest of the timers, now what they sweep and alert through exists.
  const upkeep = startUpkeep(stores, {
    config, registry, gateways, memory, notifier, approvals, missions: missions.store, skillReview: reflection.library, knowledgeRoom: knowledgeAt.room, pipeline: () => pipeline,
  });
  const { memoryPass } = upkeep;
  // What a previous run left pending: kept when young enough to answer, expired when not — asked again, or said lost,
  // once the gateways are up (`boot/approvals-kept.ts`).
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
    backgroundTimers: [...snapshotTimers, ...upkeep.timers],
  };
  // The copy sealed to the backup password made again at each change, and `secrets.json` moved once no update is
  // pending (`boot/secret-store.ts`). After the context, which holds the seal as settings change it.
  const secretStoreTimer = settleSecretStore(secrets, { dataDir: config.daemon.dataDir, installDir: installDirFor(config.daemon.dataDir), version: VERSION, seal: () => ctx.config.daemon.backupSeal });
  if (secretStoreTimer) ctx.backgroundTimers.push(secretStoreTimer);

  // The machine itself: the MCP servers, the pipeline, the scheduler and the toolset, joined.
  const { mcp, mcpLogins, mcpCatalog, skillRoots, pipeline, scheduler, tools } = await buildTurnMachine(stores, parts, {
    ctx, config, configPath, progress, registry, gateways, memory, load: upkeep.load, externalAgents, projectSkills, builtinSkillsDir, supervisor: supervisorInfo, startedAt,
  });

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
    grants, toolGrants, access, memory, memoryPass, jobs, notifier, audit, logs, logStore, mcp, reach, projectSkills, skillRoots,
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

  // What each agent's gateway says about its models, asked now so the first turns are budgeted by it. In the
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
