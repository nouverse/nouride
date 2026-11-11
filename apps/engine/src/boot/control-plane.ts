/**
 * The HTTP surface: accounts, the setup wizard, config editing, and the app the server serves.
 *
 * Last in the boot order on purpose. The port was bound at the start of boot (`bindWebServer`), but it
 * answers only "starting" until this hands it the app — and everything the app can reach must already
 * exist by then: an account created after the app went live is an account the first request could
 * arrive before.
 */

import type { AgentsSeen } from "@/commons/agents-seen.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import type { Missions } from "@/modules/missions/missions.ts";
import type { ExternalAgents } from "@/modules/external-agents/index.ts";
import type { NotesPort } from "@/modules/notes/store.ts";
import type { McpCatalog } from "@/modules/mcp-registry/index.ts";
import type { McpLogins } from "@/modules/mcp-oauth/index.ts";
import { requestRestart } from "@/boot/restart.ts";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import { WhatsAppGateway } from "@nouride/gateways";
import type { Memory } from "@/modules/memory/index.ts";
import type { MemoryPass } from "@/boot/memory-pass.ts";
import type { SecretStore } from "@nouride/secrets";
import type { SqliteDb } from "@nouride/runtime";
import type { AgentRegistry } from "@nouride/persona";
import type { ProjectSkills } from "@nouride/persona";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import { dashboardLink } from "@/modules/web/links.ts";
import { SettingsService } from "@/modules/config/settings/index.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { DaemonContext } from "@/commons/context.ts";
import type { LogBuffer } from "@/commons/log-buffer.ts";
import type { LogsPort } from "@/commons/logs.store.ts";
import type { Notifier } from "@/commons/notify.ts";
import type { AccessPort } from "@/modules/access/access.store.ts";
import type { CronScheduler } from "@/modules/cron/scheduler.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import type { LocalGateway } from "@/modules/gateways/local.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { Pipeline } from "@/modules/pipeline/index.ts";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";
import { createSkillHub } from "@/modules/skills-hub/index.ts";
import type { Tool } from "@nouride/shared";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import type { EventsPort } from "@/modules/events/events.store.ts";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import type { RoomsPort } from "@/modules/rooms/rooms.store.ts";
import type { RoomMessagesPort } from "@/modules/chat-events/room-messages.store.ts";
import type { ChatAttachmentsPort } from "@/modules/attachments/chat-attachments.store.ts";
import type { UploadStore } from "@/modules/web/control/uploads.ts";
import { FileService } from "@/modules/setup/files.ts";
import type { SkillRoots } from "@/modules/setup/skill-roots.ts";
import { SetupService } from "@/modules/setup/service.ts";
import type { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { AutoApprovePort } from "@/modules/tools/auto-approve.store.ts";
import type { GrantsPort } from "@/modules/tools/grants.store.ts";
import type { McpManager } from "@/modules/tools/mcp.ts";
import type { ApprovalReach } from "@/modules/tools/reachability.ts";
import type { ToolGrantsPort } from "@/modules/tools/tool-grants.store.ts";
import { ensureInitialAdmin, firstRunBanner } from "@/modules/users/bootstrap.ts";
import { personForEachAccount } from "./account-people.ts";
import type { GatewayPort } from "@/boot/gateway-switch.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { ensureControlToken, mountControlRoutes } from "@/modules/web/control/index.ts";
import { resolveOauthSupport } from "@/modules/users/oidc.ts";
import { mountHooks } from "@/modules/web/hooks.ts";
import { HookTests } from "@/modules/web/hook-reach.ts";
import type { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import { mountMcp } from "@/modules/web/mcp/index.ts";
import { mountAgentMcp } from "@/modules/web/mcp/agent.ts";
import { createSurface } from "@/modules/mcp-server/surface.ts";
import { McpTokenStore } from "@/modules/mcp-server/tokens.store.ts";
import { VERSION } from "@/commons/version.ts";
import type { WebServer } from "@/modules/web/server.ts";
import { LLM_GATEWAY_PREFIX, mountLlmGateway } from "@/modules/web/llm-gateway.ts";
import type { SupervisorInfo } from "@/service/supervisor.ts";
import { join, localIPv4Addresses } from "@nouride/runtime";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { OpenStreams } from "@/modules/web/control/streams.ts";

const log = createLogger("daemon");

export interface ControlPlane {
  settings: SettingsService;
  server: WebServer["server"] | undefined;
  /** The event streams open on it, for the shutdown to end before it stops the server. */
  streams: OpenStreams;
}

export async function startControlPlane(deps: {
  /** The port, bound at the start of boot — absent when `[dashboard] enabled = false`. */
  web?: WebServer;
  /**
   * A first-run password already generated and lent to the bundled gateway, so this account is
   * created with the same one — see `seedSharedInitialAdmin`.
   */
  initialAdminPassword?: string;
  /**
   * The LLM gateway this build carries, on or off (`boot/gateway-switch.ts`): its dashboard is the LLM Gateway page
   * (`web/llm-gateway.ts`), the setup wizard connects the daemon to it without a typed key, and either turns it on.
   * The first-run banner says the credential reaches it too, when it came up with this boot.
   */
  gateway?: GatewayPort;
  ctx: DaemonContext;
  db: SqliteDb;
  /** Nouverse's MCP catalog, for the Explore tab and `nouride mcp search` (0.7.19). Undefined: turned off. */
  mcpCatalog?: McpCatalog | undefined;
  /** Remote MCP servers' logins, for Connect on the MCP page and `nouride mcp login` (0.7.19). */
  mcpLogins?: McpLogins;
  config: GlobalConfig;
  configSource: string | null;
  secrets: SecretStore;
  registry: AgentRegistry;
  providers: ProviderRegistry;
  pipeline: Pipeline;
  approvals: SqliteApprovalGate;
  grants: GrantsPort;
  toolGrants: ToolGrantsPort;
  access: AccessPort;
  /** What is remembered about people — the Memory routes (`nouride memory`). */
  memory: Memory;
  /** Memory's nightly pass: run on demand, reported on, and the model call forgetting someone needs. */
  memoryPass: Pick<MemoryPass, "run" | "status" | "ask">;
  jobs: JobsPort;
  notifier: Notifier;
  audit: AuditPort;
  logs: LogBuffer;
  /** The same lines on disk, for System Logs. */
  logStore: LogsPort;
  mcp: McpManager;
  reach: ApprovalReach;
  projectSkills: ProjectSkills;
  /** An agent's skill roots, for its Skills page and `nouride agent skill-root add|rm` (0.8.24). */
  skillRoots: SkillRoots;
  /** `skills/` beside the executable, so `/skills` lists built-in skills the same way the loader does. */
  builtinSkillsDir: string | undefined;
  autoApprove: AutoApprovePort;
  sessions: SessionsPort;
  /** Each conversation's work notes, for the chat page's Notes panel (`routes/notes.ts`). */
  notes?: NotesPort;
  /** The missions, for the Missions page and `nouride mission` (`routes/missions.ts`). */
  missions?: Missions;
  /** External agents' CLIs, for an agent's Brain tab and `nouride agents scan|login`. */
  externalAgents?: ExternalAgents;
  /** When each agent was first seen (0.8.1): `/status` carries it, for Nouride Office's order. */
  agentsSeen?: Pick<AgentsSeen, "since">;
  /** The daemon's own state rows (0.8.18): what the last boot advised, which the Overview lists. */
  state?: Pick<StateRows, "get">;
  turns: TurnsPort;
  /** What turns do, as one stream — `GET /events`, followed or paged. */
  events: EventsPort;
  /** Things that happened *to* a conversation — see `ChatEventStore`. */
  chatEvents: ChatEventsPort;
  /** Who is in a room, where the daemon owns that answer — see `RoomStore`. */
  rooms: RoomsPort;
  /** What people said in a room — see `RoomMessageStore`. */
  roomMessages: RoomMessagesPort;
  attachmentIndex: ChatAttachmentsPort;
  uploads: UploadStore;
  usage: UsagePort;
  cron: CronPort;
  scheduler: CronScheduler;
  /** Proposed jobs' cards in the chats they were asked in (0.8.0): answered from the dashboard, a card follows. */
  proposals?: Pick<ProposalCards, "settled">;
  localGateway: LocalGateway | undefined;
  supervisorInfo: SupervisorInfo;
  /** Skill drafts and the two decisions on them — the dashboard's half of the RSI gate. */
  reflection: ReflectionEngine;
  /**
   * Every tool this build registered, for the first agent the setup wizard creates.
   *
   * The live map rather than a list: a tool added later is offered to the next agent created, with
   * nothing to remember. See `FALLBACK_TOOLS` in `setup/service.ts` for the path that has no
   * registry to ask.
   */
  builtinTools: Map<string, Tool>;
}): Promise<ControlPlane> {
  /**
   * Does this build carry the external sign-in flow?
   *
   * Resolved once, here, before anything can be served. `/setup/state` is a
   * synchronous handler and a dynamic import is not — so the question is
   * answered while nothing is listening, and the routes read a cached boolean.
   *
   * In every edition but `--pro` the module is externalised out of the
   * artefact and this is false. That is not a failure: it is the build.
   */
  await resolveOauthSupport();

  const {
    ctx,
    db,
    config,
    configSource,
    secrets,
    registry,
    providers,
    pipeline,
    approvals,
    grants,
    toolGrants,
    access,
    memory,
    memoryPass,
    jobs,
    notifier,
    audit,
    logs,
    logStore,
    mcp,
    reach,
    projectSkills,
    builtinSkillsDir,
    autoApprove,
    sessions,
    notes,
    turns,
    events,
    chatEvents,
    rooms,
    roomMessages,
    attachmentIndex,
    uploads,
    usage,
    cron,
    scheduler,
    proposals,
    localGateway,
    supervisorInfo,
    reflection,
    builtinTools,
  } = deps;
  const source = configSource;
  // One store for the tokens: `/mcp` reads it, the MCP server routes make and revoke them.
  const mcpTokens = new McpTokenStore(deps.db);
  // The webhook tests in flight: sent from the Webhooks page through the public address, counted by the hook route.
  const hookTests = new HookTests();

  const controlToken = config.control.enabled
    ? await ensureControlToken(config.daemon.dataDir)
    : undefined;

  // Accounts exist whenever the dashboard is served: a browser cannot present the control token, so
  // without an account there is no way into the UI at all. Created before the server starts, so the
  // first request can never arrive at a half-initialised instance.
  const users = config.dashboard.enabled ? new UserStore({ db, audit }) : undefined;
  const bootstrap = users
    ? await ensureInitialAdmin(users, process.env, deps.initialAdminPassword)
    : undefined;

  /**
   * Which file is this daemon's config, answered once.
   *
   * Three consumers below need it, and the two that derived their own answer drifted apart — see the
   * note on `FileServiceDeps.configPath` for the one that read a config nobody had written.
   */
  const configPath = source ?? defaultConfigPath();

  const files = config.dashboard.enabled
    ? new FileService({
        agentsDir: config.daemon.agentsDir,
        configPath,
        registry,
        config,
        audit,
      })
    : undefined;

  const setup = users
    ? new SetupService({
        config,
        // Where it was loaded from, or where it will be created — `loadGlobalConfig` returns null
        // when running on built-in defaults, which is exactly the fresh install the wizard is for.
        configPath,
        dataDir: config.daemon.dataDir,
        agentsDir: config.daemon.agentsDir,
        secrets,
        providers,
        registry,
        audit,
        autoApprove,
        userCount: () => users.count(),
        // The live map, so the first agent created from the dashboard is offered every tool this
        // build actually has — including one added after this line was written.
        builtinToolNames: () => [...builtinTools.keys()],
        ...(deps.gateway ? { bundledGateway: () => deps.gateway?.current() ?? null } : {}),
      })
    : undefined;

  /**
   * Gateway and provider editing.
   *
   * Shares the wizard's config path rather than deriving its own: two answers to "which file is this
   * daemon's config" is one answer too many, and the wrong one writes settings nothing ever reads.
   */
  // The event streams open on the control API, which the shutdown ends before it stops the server.
  const streams = new OpenStreams();
  const settings = new SettingsService({
    config,
    configPath,
    secrets,
    providers,
    gatewayStatus: () => ctx.gateways,
    // What names a secret besides this config, and what deleting one takes it out of: each pack's `exec_secrets`.
    packs: () =>
      registry.all().map((agent) => ({
        agentId: agent.config.id,
        configPath: join(agent.dir, "config.toml"),
        reload: () => registry.reload(agent.config.id),
        secrets: agent.config.execSecrets.map((secret) => secret.name),
      })),
    /**
     * Take a connection down for real, so removing it does not need a restart.
     *
     * WhatsApp gets the full treatment: unlink the device from the phone and stop the bridge, both
     * *before* `removeGateway` deletes the session. The other platforms have no session on disk and
     * nothing to log out of, so stopping is the whole job.
     *
     * Dropped from `ctx.gateways` last. While it is still in there the pipeline can route to it, the
     * dashboard reports it, and the health check counts it — all describing something that no longer
     * has a config entry.
     */
    retireGateway: async (id: string) => {
      const gateway = ctx.gateways.get(id);
      if (!gateway) return { stopped: false, loggedOut: false, reason: "it was not running" };

      let loggedOut = false;
      let reason: string | undefined;
      try {
        if (gateway instanceof WhatsAppGateway) {
          const outcome = await gateway.logoutAndStop();
          loggedOut = outcome.loggedOut;
          reason = outcome.reason;
        } else {
          await gateway.stop();
        }
      } catch (err) {
        // Still dropped below. A gateway that refused to stop cleanly is worse to keep than to
        // forget: it holds a socket and a token for a connection the operator has deleted.
        reason = String(err);
        log.warn("gateway did not stop cleanly while being removed", { gateway: id, error: reason });
      }

      ctx.gateways.delete(id);
      return { stopped: true, loggedOut, ...(reason ? { reason } : {}) };
    },
    // A key someone removed from People left memory or a live MCP token under: not handed to somebody new unasked.
    keyHeld: (key: string) => memory.keyHeld(key) ?? (mcpTokens.list().some((token) => token.person === key) ? "a live MCP token is still theirs" : null),
    audit,
  });

  // Each account someone in People: whose chats an account reads is read by its person (`account-people.ts`).
  if (users && source) {
    await personForEachAccount({ accounts: users.list(), people: () => config.people, link: (params) => settings.linkAccount(params) }).catch((err: unknown) =>
      log.warn("could not give each account its person", { error: String(err) }),
    );
  }

  deps.web?.serve(ctx, {
    ...(controlToken
      ? {
          mountControl: (app) =>
            mountControlRoutes(app, {
              ctx,
              token: controlToken,
              ...(deps.gateway ? { llmGateway: deps.gateway } : {}),
              // Said only where it is mounted below — both need a build that carries the gateway and the users store.
              ...(deps.gateway?.carried && users ? { llmGatewayMount: LLM_GATEWAY_PREFIX } : {}),
              // For `auth/oauth/callback`, which presents a client secret to the identity
              // provider. Config names the secret; this resolves it.
              secrets,
              settings,
              pipeline,
              registry,
              providers,
              approvals,
              grants,
              toolGrants,
              access,
              autoApprove,
              memory,
              memoryPass,
              jobs,
              notifier,
              audit,
              logs,
              logStore,
              mcp,
              reach,
              projectSkills,
              skillRoots: deps.skillRoots,
              reflection,
              skillHub: createSkillHub({ config, secrets, reflection, builtinSkillsDir }),
              ...(deps.mcpCatalog ? { mcpCatalog: deps.mcpCatalog } : {}),
              ...(deps.mcpLogins ? { mcpLogins: deps.mcpLogins } : {}),
              ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
              ...(config.cron.enabled
                ? { cron: { store: cron, scheduler, timezone: config.daemon.timezone, tests: hookTests, ...(proposals ? { proposals } : {}) } }
                : {}),
              ...(users ? { users } : {}),
              ...(setup ? { setup } : {}),
              ...(files ? { files } : {}),
              sessions,
              ...(notes ? { notes } : {}),
              ...(deps.missions ? { missions: deps.missions } : {}),
              ...(deps.externalAgents ? { externalAgents: deps.externalAgents } : {}),
              ...(deps.agentsSeen ? { agentsSeen: deps.agentsSeen } : {}),
              ...(deps.state ? { state: deps.state } : {}),
              turns,
              turnInspector: new TurnInspector(db),
              events,
              streams,
              mcpTokens,
              chatEvents,
              rooms,
              roomMessages,
              attachmentIndex,
              uploads,
              usage,
              ...(localGateway ? { local: localGateway } : {}),
              supervisor: () => supervisorInfo,
              // Shared with the update path, which ends the process for the same reason —
              // see `boot/restart.ts`.
              requestRestart,
              ...(pipeline.restart ? { restart: pipeline.restart } : {}),
            }),
        }
      : {}),
    // Independent of `controlToken`: a webhook authenticates with its own token and has nothing
    // to do with the dashboard session. Gated on the scheduler instead, because a webhook with
    // no job behind it is a 501 either way.
    ...(config.cron.enabled
      ? { mountHooks: (app) => mountHooks(app, { cron: { store: cron, scheduler }, tests: hookTests }) }
      : {}),
    // The bundled gateway's dashboard, as the LLM Gateway page — on or off, so turning it on needs no restart. Needs a
    // session to check, so it goes where the users store does.
    ...(deps.gateway?.carried && users
      ? { mountLlmGateway: (app) => mountLlmGateway(app, { gateway: () => deps.gateway?.current() ?? null, users }) }
      : {}),
    // Always mounted, and off until `[mcp_server] enabled` — checked per request, so turning it on
    // from the dashboard needs no restart.
    mountMcp: (app) => {
      mountMcp(app, {
        config,
        tokens: mcpTokens,
        version: VERSION,
        surface: createSurface({
          memory: deps.memory,
          tools: builtinTools,
          agents: registry,
        }),
      });
      // An external agent's CLI, during its turn: the agent's own tools, not a client's (`web/mcp/agent.ts`).
      if (deps.externalAgents) mountAgentMcp(app, { lent: deps.externalAgents.lent, version: VERSION });
    },
  });
  const server = deps.web?.server;

  ctx.status = "ready";

  // Printed after the server is listening, so the URL in it is one that already answers. Last, because
  // it is the only output on a first run that the operator has to act on, and anything logged after it
  // pushes it off the top of a small terminal.
  if (bootstrap?.generatedPassword && server) {
    process.stdout.write(
      firstRunBanner({
        username: bootstrap.username ?? "admin",
        password: bootstrap.generatedPassword,
        ...firstRunUrls(ctx.config.dashboard, server.port),
        ...(deps.gateway?.current() ? { gatewayUrl: deps.gateway.current()!.url } : {}),
      }),
    );
  }


  return { settings, server, streams };
}

/**
 * Where the first login is opened. Its public address when one is set; otherwise this machine, and when
 * it is bound to every interface, its LAN addresses too — found on a Pi installed with `--host 0.0.0.0`:
 * the banner said only `http://localhost:18254`, which no other device can open.
 */
function firstRunUrls(dashboard: { host: string; publicUrl: string }, port: number): { url: string; alsoAt?: string[] } {
  const overview = dashboardLink(dashboard, { kind: "overview" });
  if (overview) return { url: overview };
  const url = `http://localhost:${port}/dashboard/`;
  if (dashboard.host !== "0.0.0.0" && dashboard.host !== "::") return { url };
  const lan = localIPv4Addresses().map((address) => `http://${address}:${port}/dashboard/`);
  return lan.length ? { url, alsoAt: lan } : { url };
}

