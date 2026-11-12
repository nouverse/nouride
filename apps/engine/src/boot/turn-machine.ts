/**
 * Building the turn machine: the pipeline that runs every turn, what it is made of, and what it is joined to.
 *
 * Two steps, at their places in the boot (`index.ts`). The parts come first — the missions, the notifier, the
 * reflection loop, the approval gate and its prompts — because the upkeep timers sweep and alert through them
 * (`boot/timers.ts`). The machine comes once the context exists: the MCP servers connected, the pipeline built from the
 * parts and the stores, then the scheduler, the toolset, and every connection's presses.
 *
 * The pipeline is built after the parts that call it, so they reach it through a getter read only when a message, a
 * press or a late answer arrives — none can before the gateways start.
 */

import { privateWorkspace, type AgentRegistry, type ProjectSkills } from "@nouride/persona";
import { createLogger, type Gateway, type GlobalConfig } from "@nouride/shared";
import { VERSION } from "@/commons/version.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { alertCooldownsState, spendAlertsState } from "@/commons/daemon-state.ts";
import { Notifier } from "@/commons/notify.ts";
import type { BoxBusy } from "@/commons/box-load.ts";
import type { Machine } from "@/commons/machine.ts";
import { buildScheduler } from "./scheduler.ts";
import type { ExternalAgents } from "@/modules/external-agents/index.ts";
import { LOCAL_GATEWAY_ID } from "@/modules/gateways/local.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import { continuePresses } from "@/modules/pipeline/resume-ask.ts";
import { todaysVerdict } from "@/modules/llm/budget.ts";
import { SpendAlerts } from "@/modules/llm/spend-alerts.ts";
import { McpLogins } from "@/modules/mcp-oauth/index.ts";
import { McpLoginStore } from "@/modules/mcp-oauth/logins.store.ts";
import { catalogFromEnvironment } from "@/modules/mcp-registry/index.ts";
import type { Memory } from "@/modules/memory/index.ts";
import { senderHasAccount } from "@/modules/people/match.ts";
import { Pipeline } from "@/modules/pipeline/index.ts";
import { RoomMentionStore } from "@/modules/pipeline/room-mention.store.ts";
import { CandidateStore, ReflectionEngine, ReviewStore, ToolMemory } from "@/modules/reflection/index.ts";
import { RoomNameStore } from "@/modules/rooms/room-names.store.ts";
import { setEffort } from "@/modules/setup/agent-effort.ts";
import { FileService } from "@/modules/setup/files.ts";
import { SkillRoots } from "@/modules/setup/skill-roots.ts";
import { ApprovalPrompts } from "@/modules/tools/approval-prompts.ts";
import { keptApprovalsFile } from "@/modules/tools/approvals-kept.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { createPersonaTool } from "@/modules/tools/builtins/persona.ts";
import { createSkillRootTool } from "@/modules/tools/builtins/skill-root.ts";
import { McpManager } from "@/modules/tools/mcp.ts";
import { ApprovalReach } from "@/modules/tools/reachability.ts";
import { DaemonRestart } from "@/modules/update/restart.ts";
import { busyWith, updateToolOptions, workingJobs } from "@/modules/update/self-update.ts";
import { holdsDashboardLink, linksFor } from "@/modules/web/links.ts";
import type { BootProgress } from "@/modules/web/server.ts";
import type { SupervisorInfo } from "@/service/supervisor.ts";
import { adminChatsOf } from "./admin-chats.ts";
import { wireJobs } from "./jobs.ts";
import { buildMissions } from "./missions.ts";
import { buildProposals } from "./proposals.ts";
import { requestRestart } from "./restart.ts";
import { secretKeepingFor } from "./secret-keeping.ts";
import type { Stores } from "./stores.ts";
import { buildTools } from "./tools.ts";

const log = createLogger("daemon");

/** What the parts read of the stores. */
type PartsStores = Pick<Stores, "db" | "state" | "cron" | "notes" | "jobs" | "chatEvents" | "turns" | "usage" | "audit" | "childEnv" | "accounts" | "drafts" | "grants" | "toolGrants" | "providers">;

/** The parts the turn machine is built from, and the timers sweep. */
export type TurnParts = ReturnType<typeof buildTurnParts>;

export function buildTurnParts(
  stores: PartsStores,
  input: {
    config: GlobalConfig;
    /** The context's config, read when a link is made, a preview judged or a mission reads it: the context comes later. */
    contextConfig: () => GlobalConfig;
    /** The machine as boot read it: the missions' slots follow it while none is set. */
    machine: Machine;
    registry: AgentRegistry;
    gateways: Map<string, Gateway>;
    memory: Memory;
    externalAgents: ExternalAgents;
    builtinSkillsDir: string | undefined;
    pipeline: () => Pipeline;
  },
) {
  const { config, registry, gateways, externalAgents, builtinSkillsDir } = input;
  const { db, cron, turns, usage, audit, accounts } = stores;
  // The one rule for a dashboard link in a chat (0.8.11, `web/links.ts`): a DM's person who holds an account, any group,
  // the dashboard's own chat.
  const linkFor = linksFor({
    dashboard: () => input.contextConfig().dashboard,
    hasAccount: (who) => who.gatewayId === LOCAL_GATEWAY_ID || senderHasAccount(input.contextConfig().people, who, (id) => accounts.byId(id)?.role),
    chatTypeOf: (gatewayId, chatId) => input.pipeline().chatTypeOf(gatewayId, chatId),
  });
  // Long work an agent finishes alone (0.8.0): built before the pipeline, which shapes their turns — `boot/missions.ts`.
  const missions = buildMissions({
    db, config: input.contextConfig, machine: input.machine, registry, notes: stores.notes, jobs: stores.jobs, approvals: () => approvals, notifier: { toChat: (to, text) => notifier.toChat(to, text), ask: (to, text, buttons) => notifier.ask(to, text, buttons), edit: (to, id, text) => notifier.edit(to, id, text) }, chatEvents: stores.chatEvents, memory: input.memory,
    jobAllowed: (jobId) => cron.get(jobId)?.allowed?.flatMap((allowance) => allowance.keys) ?? [],
    roomForCli: () => externalAgents.room().enough,
    forgetCliSession: (agentId, gatewayId, chatId) => externalAgents.forgetSession(agentId, gatewayId, chatId),
    freeToDelete: (agent) => externalAgents.freeToDelete(agent),
    cliSpentNow: (agentId, gatewayId, chatId) => externalAgents.spentNow(agentId, gatewayId, chatId),
    lastSaid: (gatewayId, chatId, senderId) => turns.lastSaid(gatewayId, chatId, senderId),
    turnStartedAt: (turnId) => turns.get(turnId)?.startedAt ?? null,
    childEnv: stores.childEnv,
    linkFor,
    audit,
  });
  gateways.set(missions.gateway.id, missions.gateway);

  // After the gateways exist, because both of the daemon's outward paths need them: `canAsk` reads
  // their live status, and an approval notice has to be delivered through one. The previous order
  // put this first and reached forward to a `gateways` that was still undefined.
  const notifier = new Notifier({
    gateways,
    previewOff: (text) => holdsDashboardLink(input.contextConfig().dashboard, text),
    ...(config.alerts.gateway && config.alerts.chatId
      ? { owner: { gatewayId: config.alerts.gateway, chatId: config.alerts.chatId } }
      : {}),
    alertCooldownMs: config.alerts.cooldownMs,
    cooldowns: alertCooldownsState(stores.state),
  });
  const spendAlerts = new SpendAlerts({
    alert: (key, text) => notifier.alert(key, text),
    spenders: (from) => usage.spenders(from),
    file: spendAlertsState(stores.state),
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
    drafts: stores.drafts,
    toolMemory: new ToolMemory(db),
    candidates: new CandidateStore(db),
    reviews: new ReviewStore(db),
    lastRead: (paths) => audit.skillReads(paths),
    registry,
    providers: stores.providers,
    agentsDir: config.daemon.agentsDir,
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    audit,
    usage,
    spend: () => todaysVerdict(usage, config),
    notifier,
  });

  // The prompt in the chat — with Approve and Deny where the connection carries buttons — its presses, and its rewrite
  // once settled. Reads the gate and the pipeline, built below, only when a question or a press comes.
  const prompts = new ApprovalPrompts({
    gateways,
    notifier,
    approvals: () => approvals,
    voice: (agentId, gatewayId) => input.pipeline().voiceGatewayId(agentId, gatewayId),
    isAdmin: (who) => input.pipeline().isAdmin(who),
    askedIn: missions.askedIn,
    missionOf: missions.missionOf,
    similar: missions.similar,
    // A question only an admin answers, in each admin's own chat too (0.8.10).
    adminChats: adminChatsOf({ config: () => config, gateways, turns, isAdmin: (who) => input.pipeline().isAdmin(who) }),
  });
  // A proposed job's card, with Turn on and Discard, and the `schedule` tool that posts it (0.8.0).
  const proposals = buildProposals({ cron, notifier, registry, timezone: () => config.daemon.timezone, pipeline: input.pipeline, linkFor });
  // Whether anyone could answer an approval now: a chat connected, or a client that just asked for them (`reachability.ts`).
  const reach = new ApprovalReach();
  const approvals = new SqliteApprovalGate({
    db,
    timeoutMs: config.security.approvalTimeoutMs,
    audit,
    grants: stores.grants,
    toolGrants: stores.toolGrants,
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
      input.pipeline().resumeAfterApproval(request, decision, by);
    },
  });
  return { linkFor, missions, notifier, spendAlerts, reflection, prompts, proposals, reach, approvals };
}

/** What the machine reads of the stores. */
type MachineStores = Pick<
  Stores,
  | "db" | "secrets" | "accounts" | "cron" | "watch" | "jobWakes" | "providers" | "sessions" | "turns" | "durable" | "chatEvents" | "rooms"
  | "roomMessages" | "grants" | "toolGrants" | "attachments" | "attachmentIndex" | "access" | "jobs" | "spill" | "notes"
  | "usage" | "autoApprove" | "childEnv" | "heldSecrets" | "ownSecrets" | "audit" | "credentialsDir"
>;

export async function buildTurnMachine(
  stores: MachineStores,
  parts: TurnParts,
  input: {
    ctx: DaemonContext;
    config: GlobalConfig;
    /** The machine as boot read it: what an agent is told of it, and its helpers' limit where none is set. */
    machine: Machine;
    configPath: string;
    progress: BootProgress;
    registry: AgentRegistry;
    gateways: Map<string, Gateway>;
    memory: Memory;
    load: BoxBusy;
    externalAgents: ExternalAgents;
    projectSkills: ProjectSkills;
    builtinSkillsDir: string | undefined;
    supervisor: SupervisorInfo;
    startedAt: number;
  },
) {
  const { ctx, config, registry, externalAgents, builtinSkillsDir } = input;
  const { secrets, audit, jobs, usage } = stores;
  const { missions, proposals, approvals } = parts;
  // Before the pipeline, because the toolset it hands to every turn has to be able to reach these.
  // Connecting is per agent and never fatal: a server that will not start takes its own tools out of
  // circulation and leaves everything else running.
  // Remote servers' logins (0.7.19): the credential each is reached with, and the logins a person makes from the MCP page.
  const mcpLogins = new McpLogins({ store: new McpLoginStore(stores.db), secrets, registry, agentsDir: config.daemon.agentsDir, dashboard: config.dashboard, audit, notifier: parts.notifier });
  const mcp = new McpManager({
    timeoutMs: config.security.toolTimeoutMs,
    liveToolGrants: (agentId) => stores.toolGrants.liveKeys(agentId),
    // Only an HTTP server with `auth_secret` reaches for this; a stdio server never does.
    secrets,
    audit,
    logins: mcpLogins,
    privateDir: (agentId) => privateWorkspace(config.daemon.workspaceDir, agentId),
  });
  input.progress.phase = "connecting MCP servers";
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

  // The Files tab's one write to an agent's pack, for what writes it from elsewhere: an agent's persona change once an
  // admin approves it (0.8.8), and its skill roots from its Skills page, the CLI and its own request (0.8.24).
  const packFiles = new FileService({ agentsDir: config.daemon.agentsDir, configPath: input.configPath, registry, config, audit });
  const skillRoots = new SkillRoots({ registry, files: packFiles, credentialsDir: stores.credentialsDir, projectSkills: input.projectSkills });

  // The pipeline is constructed before the tools that reference it: `session_status` needs
  // live session facts, and the pipeline needs the tool map. The cycle is broken by passing
  // a closure rather than the object.
  const pipeline = new Pipeline({
    // Read for a role only: whether a chat sender is an admin, for `/daemon-restart`.
    users: stores.accounts,
    memory: input.memory,
    load: input.load,
    cronJobs: stores.cron,
    jobWakes: stores.jobWakes,
    config,
    machine: input.machine,
    registry,
    providers: stores.providers,
    sessions: stores.sessions,
    turns: stores.turns,
    ...stores.durable,
    chatEvents: stores.chatEvents,
    rooms: stores.rooms,
    roomMessages: stores.roomMessages,
    approvals,
    grants: stores.grants,
    toolGrants: stores.toolGrants,
    notifier: parts.notifier,
    spendAlerts: parts.spendAlerts,
    attachments: stores.attachments,
    attachmentIndex: stores.attachmentIndex,
    access: stores.access,
    jobs,
    spill: stores.spill,
    notes: stores.notes,
    shaper: missions.missions,
    missionCommands: missions.missions,
    scheduleCommands: proposals.cards,
    missionTools: missions.tools,
    scheduleTool: proposals.tool,
    // An agent's change to its own persona goes to an admin, and through the Files tab's one write once approved (0.8.8).
    personaTool: createPersonaTool({ files: packFiles }),
    skillRootTool: createSkillRootTool({ roots: skillRoots }),
    externalAgents,
    // `/effort … lock` (0.8.17) writes the agent's own effort the way its Model tab does, audited.
    agentEffort: (agentId, effort, actor) => setEffort({ registry, audit }, { agentId, effort, actor }),
    usage,
    mcp,
    autoApprove: stores.autoApprove,
    roomMention: new RoomMentionStore(stores.db),
    roomNames: new RoomNameStore(stores.db),
    childEnv: stores.childEnv,
    heldSecrets: stores.heldSecrets,
    ownSecrets: stores.ownSecrets,
    secretKeeping: secretKeepingFor({ secrets, audit, registry }),
    credentialsDir: stores.credentialsDir,
    projectSkills: input.projectSkills,
    // So `read` can open the skills this build ships with — they are advertised by path and were
    // refused by the sandbox. See `PipelineDeps.builtinSkillsDir`.
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    reflection: parts.reflection,
    tools: new Map(),
    gateways: input.gateways,
    startedAt: input.startedAt,
    version: VERSION,
    providerErrors: ctx.providerErrors,
    // A Box writes a partial answer less often — set once the plugin has loaded, after this is built.
    appliance: () => ctx.appliance !== undefined,
  });

  // One restart for the dashboard, `nouride restart`, `/daemon-restart` and an agent's `--then`, waiting for this
  // pipeline to go idle — so built after it, and handed back to it for the chat command. `modules/update/restart.ts`.
  pipeline.restart = new DaemonRestart({ requestRestart, supervisor: () => input.supervisor, busy: busyWith(pipeline, jobs), jobs: workingJobs(jobs, pipeline), audit, ...(config.cron.enabled ? { cron: stores.cron } : {}) });

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
  const { scheduler, stepAsks } = buildScheduler({ cron: stores.cron, watch: stores.watch, config: () => ctx.config, notifier: parts.notifier, pipeline, missions, audit });

  // Built after the pipeline and handed back to it: `session_status` needs live session facts
  // while the pipeline needs the tool map. See `boot/tools.ts`.
  // The agent asking for an update is in a turn of its own: waiting for idle lets it answer before the restart.
  // The MCP catalog, asked of Nouverse (`modules/mcp-registry`): the Explore tab, the CLI, `mcp_search`.
  const mcpCatalog = catalogFromEnvironment(process.env);
  const updateTool = updateToolOptions({ dataDir: config.daemon.dataDir, cron: stores.cron, requestRestart, busy: busyWith(pipeline, jobs), jobs: workingJobs(jobs, pipeline) });
  const tools = buildTools({
    config, secrets, registry, providers: stores.providers, pipeline, approvals, grants: stores.grants, toolGrants: stores.toolGrants,
    jobs, memory: input.memory, turns: stores.turns, audit, childEnv: stores.childEnv, heldSecrets: stores.heldSecrets, ownSecrets: stores.ownSecrets,
    reflection: parts.reflection, mcp, mcpCatalog, notes: stores.notes, linkFor: parts.linkFor,
    configPath: input.configPath,
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
  // Every connection's presses: an approval's to its prompt, a proposal's to its card, and Continue under the question
  // a boot asks about a turn cut off a while ago.
  // And the ways on for work that stopped in a room: Continue under a chain at its budget, Continue and Hand to under
  // handed-over work that ended early.
  const waysOn = pipeline.waysOn();
  const carryOn = continuePresses({ turns: stores.turns, resume: (turn) => pipeline.resumeTurn(turn, "asked"), isAdmin: (who) => pipeline.isAdmin(who), handedOver: waysOn.handedOver });
  routePresses(input.gateways.values(), [parts.prompts, proposals.cards, stepAsks, ...missions.presses(pipeline), carryOn, waysOn.presses]);
  return { mcp, mcpLogins, mcpCatalog, skillRoots, pipeline, scheduler, tools };
}
