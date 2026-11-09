/**
 * The missions, put together (0.8.0, `modules/missions/`): the store, the connection their conversations run on, the
 * `mission` tool, and what they reach of the rest — the queue their turns go into, `exec` for their checks, the chat
 * each reports to. Built before the pipeline, which shapes their turns through it, and joined to the pipeline and the
 * tools once both exist (`connect`), the way the job store is.
 */

import { basename, fileExistsSync, freeDiskBytes, join, readPlainTextFile, readTextFileSync, realPathStrict, runCommand, statFile, writeFileAsAgent, type SqliteDb } from "@nouride/runtime";
import { contained, createLogger, newId, type GlobalConfig, type Job, type LoadedAgent, type MessageEnvelope, type Tool, type ToolContext } from "@nouride/shared";
import { privateWorkspace, sharedWorkspace, type AgentRegistry } from "@nouride/persona";
import { sessionIdFor } from "@nouride/shared";
import { DISK_WARN_MB } from "./maintenance.ts";
import type { Notifier } from "@/commons/notify.ts";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import { checkRefusal, runChecks } from "@/modules/missions/checks.ts";
import { MISSION_GATEWAY_ID, MissionGateway } from "@/modules/missions/gateway.ts";
import { Missions } from "@/modules/missions/missions.ts";
import { startJobRun } from "@/modules/missions/job-runs.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { similarKind, similarLabel, SimilarAllowed } from "@/modules/missions/similar.ts";
import { OptionPresses } from "@/modules/missions/options.ts";
import { ActionPresses } from "@/modules/missions/actions.ts";
import { ProgressLines } from "@/modules/missions/progress-line.ts";
import { shortId } from "@/modules/missions/page.ts";
import { isFinal, toldBy } from "@/modules/missions/types.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { inForceFor } from "@/modules/missions/slots.ts";
import type { Mission } from "@/modules/missions/types.ts";
import type { NotesPort } from "@/modules/notes/store.ts";
import type { CutCall } from "@/modules/turns/cut-calls.ts";
import { describeApprovalParams } from "@/modules/pipeline/messages.ts";
import { personFor } from "@/modules/pipeline/known-rooms.ts";
import type { Memory } from "@/modules/memory/index.ts";
import type { ApprovalGate } from "@/modules/tools/approval.ts";
import type { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { Pipeline } from "@/modules/pipeline/index.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import type { SubagentRequest, SubagentResult } from "@/modules/tools/builtins/delegate.ts";
import { reviewBrief, reviewOf } from "@/modules/missions/review.ts";
import { repositoryOf, sourceRepositoryOf } from "@/modules/missions/decide.ts";
import { branchRefusal, helperWorktreeFor, inOwnFolder, makeWorktree, ownFolderOf, removeExtraWorktrees, removeOwnFolder, trackedIn, worktreeBranch, type AsAgent } from "@/modules/missions/worktree.ts";
import { sendTextFile, type SendFileOptions } from "@/modules/tools/builtins/attach.ts";
import { besidesTheReport } from "@/modules/missions/results.ts";
import type { LinkFor } from "@/modules/web/links.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import { BRIEF_FILE, goalBrief } from "@/modules/missions/drafts.ts";
import { buildEnv, ownHomeEnv } from "@/modules/tools/builtins/exec.ts";

const log = createLogger("boot.missions");

/** One minute between the missions' checks: a stall is an hour, a follow-up four. */
const TICK_MS = 60_000;
/** A review's own clock: long enough to open the results and sample them, short of a turn. */
const REVIEW_MS = 10 * 60_000;
/** Result files sent with a done notice; the rest are named. */
const FILES_SENT = 5;

/**
 * A command as a mission's agent — its own user where agents have one — for its folder and its worktree, with its own
 * HOME as its other commands get it. With the daemon's, which its user cannot read, git never read the `safe.directory`
 * seeded in its own: a repository it does not own was "dubious", and the mission worked without a worktree.
 */
export function agentCommand(workspaceDir: string, agentId: string): AsAgent {
  return async (argv) => {
    const env = { ...buildEnv({}), ...ownHomeEnv(privateWorkspace(workspaceDir, agentId)) };
    const out = await runCommand(argv, { cwd: "/", env, timeoutMs: 120_000, maxOutputBytes: 16 * 1024 * 1024, agent: agentId });
    return { ok: out.exitCode === 0, out: out.exitCode === 0 ? out.stdout : out.stderr || out.stdout };
  };
}

/**
 * How much of a brief file is read for its English check: a brief is a page or two, not a dataset. Kept small because
 * the check runs on the daemon's event loop, and its quote matching slows with what it is given (0.8.8).
 */
const BRIEF_READ_MAX = 64 * 1024;

/**
 * A brief file a goal points at, as the daemon reads it — null where it is not a plain file of at most the cap, or
 * cannot be read. Through `readPlainTextFile`: a path an agent names, read on the daemon's own event loop, and a FIFO or
 * `/dev/zero` there stopped every agent and gateway (0.8.8).
 */
export function readBrief(path: string): string | null {
  try {
    return readPlainTextFile(path, BRIEF_READ_MAX);
  } catch {
    return null;
  }
}

/** A worktree's `.git` file, read — null for a repository's `.git` folder, or one the daemon cannot read. */
function gitFile(path: string): string | null {
  const stat = statFile(path);
  if (!stat || stat.isDirectory) return null;
  try {
    return readTextFileSync(path);
  } catch {
    return null;
  }
}

/** What the missions reach once the pipeline and the tools exist. */
interface MissionsLate {
  queueTurn: (envelope: MessageEnvelope) => boolean;
  /** The connection an agent speaks on in a chat — the notices go out under its own name. */
  voice: (agentId: string, gatewayId: string) => string;
  cancelTurn: (agentId: string, chatId: string) => void;
  /** Words into an agent's turn at work in a chat, and how they reach it (`Pipeline.steerInto`, `steerReach`). */
  steerInto: (agentId: string, chatId: string, gatewayId: string, envelope: MessageEnvelope) => "taken" | "full" | "ending" | "none";
  steerReach: (agentId: string) => "next_step" | "into_cli" | "after_prompt";
  /** An admin by People — who besides a mission's starter may tell it something through an agent. */
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
  /** `exec`, for the checks and the folder — the agents' own command path. */
  exec: () => Tool | undefined;
  /** The built tools — `send_file` puts a done mission's results in its chat. */
  tools: Map<string, Tool>;
  /** What `send_file` sends through — a mission's `report.md` goes the same way (0.8.11). */
  sendAttachment: SendFileOptions["send"];
  /** A helper turn — the reviewer runs as one, with only the tools that read. */
  helper: (request: SubagentRequest) => Promise<SubagentResult>;
  /** Tokens a conversation spent since a moment — what the reviewer cost the mission. */
  spent: (sessionId: string, since: number) => number;
  /** Tokens its helpers spent since a moment (0.8.7). */
  helpers: (sessionId: string, since: number) => number;
}

export function buildMissions(params: {
  db: SqliteDb;
  config: () => GlobalConfig;
  registry: Pick<AgentRegistry, "get" | "enabled" | "isPaused" | "onWoke">;
  notes: NotesPort;
  jobs: JobsPort;
  approvals: () => Pick<ApprovalGate, "pending" | "expireAll"> & Pick<SqliteApprovalGate, "recentlySettledForChat" | "settled" | "get">;
  notifier: Pick<Notifier, "toChat" | "ask" | "edit">;
  chatEvents: Pick<ChatEventsPort, "record">;
  /** Where an ended mission is remembered — one episode, from its report. */
  memory?: Pick<Memory, "saveConversation">;
  /** What a person allowed a job's runs to send without asking again (`Job.allowed`). */
  jobAllowed?: (jobId: string) => readonly string[];
  /** Whether the agents' commands have room for a coding CLI's session — a worktree's work needs as much. */
  roomForCli?: () => boolean;
  /** A conversation's coding-CLI session let go (`ExternalAgents.forgetSession`). */
  forgetCliSession?: (agentId: string, gatewayId: string, chatId: string) => void;
  /** Whether nothing asks before an agent deletes (`ExternalAgents.freeToDelete`). */
  freeToDelete?: (agent: LoadedAgent | undefined) => boolean;
  /** What an agent's CLI turn running in a conversation has spent so far, estimated (`ExternalAgents.spentNow`). */
  cliSpentNow?: (agentId: string, gatewayId: string, chatId: string) => number;
  /** What a person last wrote in a chat (`TurnStore.lastSaid`). */
  lastSaid?: (gatewayId: string, chatId: string, senderId: string) => string | null;
  /** When a turn started (`TurnStore.get`). */
  turnStartedAt?: (turnId: string) => number | null;
  /** An agent's credentials, which a `report.md` holding one is refused for, as `send_file` refuses a file (0.8.11). */
  childEnv?: (agentId: string) => Record<string, string>;
  /** Dashboard links for a chat (`web/links.ts`, 0.8.11): a mission's page in its notices and its tools' answers. */
  linkFor?: LinkFor;
  /** Where a mission started on a person's words is recorded, with the words (0.8.11, `now` and `work` start). */
  audit?: Pick<AuditPort, "record">;
}) {
  const store = new MissionStore(params.db);
  /** What *Approve similar from this mission* allowed, per open mission (0.8.7, `missions/similar.ts`). */
  const similar = new SimilarAllowed();
  /** Each open mission's progress message, rewritten in place where its chat can edit (0.8.7). */
  const progressed = new ProgressLines({
    send: async (to, text) => (await params.notifier.ask(to, () => text, []))?.ids.at(-1),
    edit: (to, messageId, text) => params.notifier.edit(to, messageId, text),
  });
  /** The chat a mission reports to, on the connection its agent speaks on there. */
  const reportsTo = (mission: Mission) => ({ gatewayId: late ? late.voice(mission.agentId, mission.gatewayId) : mission.gatewayId, chatId: mission.chatId });
  /** What a mission said, as the dashboard's conversation shows it. */
  const noted = (mission: Mission, text: string): void => {
    params.chatEvents.record({ gatewayId: mission.gatewayId, chatId: mission.chatId, audience: "ui", kind: "note", text, agentId: mission.agentId, details: { mission: mission.id } });
  };
  const gateway = new MissionGateway();
  let late: MissionsLate | undefined;

  const asTheAgent = (agentId: string): AsAgent => agentCommand(params.config().daemon.workspaceDir, agentId);

  /**
   * What a command of the mission's agent runs with: its folders, its user, nobody waiting on it. A mission not yet
   * started has no id or folder of its own: its checks are judged at the start against the folder they will run in.
   */
  const commandContext = (mission: Pick<Mission, "id" | "agentId" | "startedBy" | "workdir">): ToolContext | null => {
    const agent = params.registry.get(mission.agentId);
    if (!agent) return null;
    const root = params.config().daemon.workspaceDir;
    const own = privateWorkspace(root, mission.agentId);
    const shared = sharedWorkspace(root);
    return {
      agentId: mission.agentId,
      sessionId: sessionIdFor({ agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }),
      chatId: mission.id,
      gateway: "web",
      gatewayId: MISSION_GATEWAY_ID,
      senderId: mission.startedBy,
      chatType: "dm",
      workspaceDir: shared,
      agentDir: agent.dir,
      workspaceRoots: [shared, own, agent.dir, ...agent.config.workspaceRoots, mission.workdir],
      ownFolders: [shared, own, ...agent.config.workspaceRoots],
      privateDir: own,
      signal: new AbortController().signal,
    };
  };

  const missions = new Missions({
    store,
    ...(params.jobAllowed ? { jobAllowed: params.jobAllowed } : {}),
    // The agents that are on, counted at each decision: unset, the slots on the box follow them (`missions/slots.ts`).
    // Each agent's own `per_agent` is its pack's, read as the pack is now — a save from its page reloads it (0.8.11).
    settings: () => inForceFor(params.config().missions, params.registry),
    agents: {
      exists: (agentId) => params.registry.get(agentId)?.config.enabled === true,
      asleep: (agentId) => params.registry.isPaused(agentId),
      privateDir: (agentId) => privateWorkspace(params.config().daemon.workspaceDir, agentId),
    },
    notes: params.notes,
    jobs: { running: (agentId) => params.jobs.running(agentId), kill: (id, why) => params.jobs.kill(id, why) },
    parked: (mission) =>
      params
        .approvals()
        .pending(mission.agentId)
        // `gateway` holds the connection's id, typed as its platform (`approvals.store.ts`).
        .filter((request) => String(request.gateway) === MISSION_GATEWAY_ID && request.chatId === mission.id)
        .map((request) => ({ id: request.id, what: `${request.tool}${describeApprovalParams(request) ? `: ${describeApprovalParams(request)}` : ""}` })),
    settled: (mission, since) => params.approvals().recentlySettledForChat(MISSION_GATEWAY_ID, mission.id, since).map((request) => request.status),
    withdraw: (mission) => {
      params.approvals().expireAll(mission.agentId, { gatewayId: MISSION_GATEWAY_ID, chatId: mission.id });
      similar.forget(mission.id);
      progressed.forget(mission.id);
    },
    letGoCli: (mission) => params.forgetCliSession?.(mission.agentId, MISSION_GATEWAY_ID, mission.id),
    tell: async (mission, text, buttons) => {
      const to = reportsTo(mission);
      // With buttons — a question's options, or what can be done about a wait — where the chat carries them, saying so;
      // plain where it does not, the commands in the text standing in for them.
      if (buttons && buttons.length > 0) await params.notifier.ask(to, (carried) => (carried ? `${text}\nOr tap a button below.` : text), buttons);
      else await params.notifier.toChat(to, text);
      // Where the chat is the dashboard's, nothing waits on what is sent: the conversation's events are what it shows.
      noted(mission, text);
    },
    progress: async (mission, text) => {
      await progressed.say(mission.id, reportsTo(mission), text);
      noted(mission, text);
    },
    queueTurn: (envelope) => late?.queueTurn(envelope) ?? false,
    stopTurn: (mission) => late?.cancelTurn(mission.agentId, mission.id),
    // A person's `tell` (0.8.10): put in front of the mission's turn at work as a steer is, never a chat message —
    // the daemon's sender, the person's name, and the mark the turn's read and its end know it by (`steering.ts` `isTell`).
    steerTurn: (mission, told) => {
      if (!late) return { taken: false, why: "none" };
      const envelope: MessageEnvelope = {
        id: newId("msg"),
        timestamp: told.at,
        gateway: "web",
        gatewayId: MISSION_GATEWAY_ID,
        chatId: mission.id,
        chatType: "dm",
        senderId: SYSTEM_SENDER,
        senderName: toldBy(told),
        mentions: [mission.agentId],
        text: told.text,
        raw: { via: "tell", mission: mission.id, tell: told.id },
      };
      const outcome = late.steerInto(mission.agentId, mission.id, MISSION_GATEWAY_ID, envelope);
      return outcome === "taken" ? { taken: true, when: late.steerReach(mission.agentId) } : { taken: false, why: outcome };
    },
    branchRefusal: async ({ agentId, workdir, branch }) => {
      const repo = repositoryOf(workdir);
      if (!fileExistsSync(join(repo, ".git"))) return `\`branch\` names a worktree's branch, and ${workdir} is not in a git repository.`;
      return await branchRefusal(repo, branch, asTheAgent(agentId));
    },
    prepare: async (mission) => {
      if (!params.registry.get(mission.agentId)) return;
      const run = asTheAgent(mission.agentId);
      const own = ownFolderOf(privateWorkspace(params.config().daemon.workspaceDir, mission.agentId), mission.id);
      const made = await run(["mkdir", "-p", own]);
      if (!made.ok) throw new Error(made.out);
      // In a repository, and where the machine can hold it, a worktree of its own; else the folder it was given.
      const moved = await makeWorktree({
        mission,
        own,
        repoOf: repositoryOf,
        isRepo: (dir) => fileExistsSync(join(dir, ".git")),
        roomForCli: () => params.roomForCli?.() ?? false,
        freeBytes: freeDiskBytes,
        run,
        told: (why) => log.info("a mission works in its folder, not a worktree of its own", { mission: mission.id, why }),
      });
      if (moved) return moved;
      if (mission.workdir !== own) {
        const there = await run(["mkdir", "-p", mission.workdir]);
        if (!there.ok) throw new Error(there.out);
      }
    },
    remember: async (mission) => {
      if (!params.memory) return;
      const person = personFor(params.config().people, mission.gatewayId, mission.startedBy)?.key ?? `${mission.gatewayId}:${mission.startedBy}`;
      const outcome = `Mission ${mission.status}${mission.reason ? ` (${mission.reason})` : ""}.${mission.report ? ` ${mission.report}` : ""}`;
      const saved = await params.memory.saveConversation({
        person,
        agentId: mission.agentId,
        label: "mission",
        session: mission.id,
        turns: [{ role: "user", text: `Mission: ${mission.goal}` }, { role: "assistant", text: outcome.slice(0, 6_000) }],
      });
      if ("refused" in saved) throw new Error(saved.refused);
    },
    remove: async (mission, how) => {
      // Only the folder the daemon made for it — `newMission`'s default, or its worktree — under its agent's own; for a
      // draft that never started, the folder its brief was written to, whatever folder it would have worked in.
      const own = ownFolderOf(privateWorkspace(params.config().daemon.workspaceDir, mission.agentId), mission.id);
      if ((!inOwnFolder(mission.workdir, own) && mission.startedAt !== null) || !params.registry.get(mission.agentId)) return [];
      return await removeOwnFolder(own, asTheAgent(mission.agentId), how);
    },
    // Where missions work — the workspace's disk — against the daemon's own disk warning, a starting value.
    diskLow: () => {
      const free = freeDiskBytes(params.config().daemon.workspaceDir);
      const freeMb = free === null ? null : Math.round(free / (1024 * 1024));
      return freeMb !== null && freeMb < DISK_WARN_MB ? freeMb : null;
    },
    sourceRepository: (workdir) => sourceRepositoryOf(workdir, gitFile),
    readBrief,
    // A coding CLI's turns: an agent whose pack names one (`ExternalAgents.runnerFor`).
    runsOnCli: (agentId) => params.registry.get(agentId)?.config.external !== undefined,
    freeToDelete: (agentId) => params.freeToDelete?.(params.registry.get(agentId)) === true,
    runningTokens: (mission) => params.cliSpentNow?.(mission.agentId, MISSION_GATEWAY_ID, mission.id) ?? 0,
    personSaid: (mission) => params.lastSaid?.(mission.gatewayId, mission.chatId, mission.startedBy) ?? null,
    turnStartedAt: (turnId) => params.turnStartedAt?.(turnId) ?? null,
    helperTokens: (mission, since) => late?.helpers(sessionIdFor({ agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }), since) ?? 0,
    tidy: async (mission) => {
      if (!params.registry.get(mission.agentId)) return { removed: [], kept: [] };
      const own = ownFolderOf(privateWorkspace(params.config().daemon.workspaceDir, mission.agentId), mission.id);
      return await removeExtraWorktrees(own, asTheAgent(mission.agentId));
    },
    review: async (mission, earlier) => {
      const ctx = commandContext(mission);
      if (!late || !ctx) throw new Error("this daemon cannot run a reviewer for that agent");
      const since = Date.now();
      const handoff = await late.helper({ brief: reviewBrief(mission, earlier), ctx: { ...ctx, deadlineAt: since + REVIEW_MS }, tier: "high", readOnly: true });
      if (handoff.status === "failed") throw new Error(handoff.reason ?? "the reviewer failed");
      return reviewOf(handoff, late.spent(ctx.sessionId, since));
    },
    deliver: async (mission) => {
      const sendFile = late?.tools.get("send_file");
      const ctx = commandContext(mission);
      if (!late || !sendFile || !ctx) return mission.files.map((file) => basename(file));
      const at = { ...ctx, gatewayId: late.voice(mission.agentId, mission.gatewayId), chatId: mission.chatId };
      // In a worktree of its own, what git tracks is the work on its branch, which the notice names (0.8.11).
      const tracked = worktreeBranch(mission) ? await trackedIn(mission.workdir, mission.files, asTheAgent(mission.agentId)) : new Set<string>();
      if (!tracked) log.warn("git could not say which of a mission's files it tracks, so all of them are sent", { mission: mission.id });
      const files = besidesTheReport(mission.files.filter((file) => !tracked?.has(file)));
      const unsent: string[] = [];
      for (const file of files.slice(0, FILES_SENT)) {
        const sent = await sendFile.execute({ path: file }, at);
        if (sent.isError) unsent.push(basename(file));
      }
      return [...unsent, ...files.slice(FILES_SENT).map((file) => basename(file))];
    },
    // A draft's folder, made as its agent, and its brief written there (0.8.11, `missions/drafts.ts`). Its worktree waits
    // for the start: `prepare`'s `mkdir -p` takes the folder as it finds it, and the worktree goes inside it.
    draftFolder: async (mission, brief) => {
      if (!params.registry.get(mission.agentId)) return false;
      const own = ownFolderOf(privateWorkspace(params.config().daemon.workspaceDir, mission.agentId), mission.id);
      const made = await asTheAgent(mission.agentId)(["mkdir", "-p", own]);
      if (!made.ok) throw new Error(made.out.trim() || `${own} could not be made`);
      if (brief !== undefined) await writeFileAsAgent(mission.agentId, join(own, BRIEF_FILE), brief.endsWith("\n") ? brief : `${brief}\n`);
      return fileExistsSync(join(own, BRIEF_FILE));
    },
    briefOf: (mission) => {
      const path = join(ownFolderOf(privateWorkspace(params.config().daemon.workspaceDir, mission.agentId), mission.id), BRIEF_FILE);
      return fileExistsSync(path) ? path : null;
    },
    goalBriefOf: (mission) => goalBrief(mission.goal, privateWorkspace(params.config().daemon.workspaceDir, mission.agentId), realPathStrict),
    // Its starter is who a DM's link is for: the person it reports to (0.8.11).
    pageOf: (mission) => params.linkFor?.({ gatewayId: mission.gatewayId, chatId: mission.chatId, senderId: mission.startedBy }, { kind: "mission", id: mission.id }) ?? null,
    sendReport: async (mission) => {
      const ctx = commandContext(mission);
      if (!late || !ctx || !mission.report) return "this daemon cannot send files for that agent.";
      const at = { ...ctx, gatewayId: late.voice(mission.agentId, mission.gatewayId), chatId: mission.chatId };
      const maxBytes = params.config().attachments.maxSizeMb * 1024 * 1024;
      return await sendTextFile({ send: late.sendAttachment, maxBytes, ...(params.childEnv ? { childEnv: params.childEnv } : {}) }, at, "report.md", mission.report);
    },
    checkRefusal: (request, command) => {
      const exec = late?.exec();
      const workdir = request.workdir ?? join(privateWorkspace(params.config().daemon.workspaceDir, request.agentId), "missions");
      const ctx = exec ? commandContext({ id: "", agentId: request.agentId, startedBy: "", workdir }) : null;
      return exec && ctx ? checkRefusal(command, exec, ctx, workdir) : null;
    },
    check: async (mission) => {
      const exec = late?.exec();
      const ctx = commandContext(mission);
      if (!exec || !ctx) return { passed: false, failed: { command: mission.checks[0] ?? "", output: "This daemon cannot run commands for that agent." } };
      return await runChecks(mission.checks, exec, ctx, mission.workdir);
    },
  });

  params.registry.onWoke((agentId) => missions.woke(agentId));

  /**
   * A worktree for a helper of the mission this turn is (`delegate` `isolated`) — only where the mission
   * works in one of its own; refused, saying so, anywhere else.
   */
  const isolateHelper = async (ctx: ToolContext): Promise<{ path: string; branch: string } | { refused: string }> => {
    const mission = ctx.gatewayId === MISSION_GATEWAY_ID ? (store.get(ctx.chatId) ?? null) : null;
    const agentId = mission?.agentId ?? ctx.agentId;
    return await helperWorktreeFor({
      mission,
      own: (id) => ownFolderOf(privateWorkspace(params.config().daemon.workspaceDir, agentId), id),
      exists: fileExistsSync,
      run: asTheAgent(agentId),
    });
  };

  return {
    missions,
    /**
     * A conversation's running CLI turn spent more (`ExternalAgents.onSpent`): a mission's, and its limits are read now.
     * Contained: it is called from inside the CLI's update stream, which a throw here would end.
     */
    cliSpent: contained(log, "a mission's limits could not be read for what its CLI spent", (gatewayId: string, chatId: string) => {
      if (gatewayId === MISSION_GATEWAY_ID) missions.spent(chatId);
    }),
    /** A worktree for a writing helper of a mission in one (`delegate` `isolated`). */
    isolateHelper,
    /** The table itself, for what reads across missions — the morning lines (0.8.0). */
    store,
    gateway,
    tools: {
      ...createMissionTools(missions, { ...(params.linkFor ? { linkFor: params.linkFor } : {}), ...(params.audit ? { audit: params.audit } : {}) }),
      // An agent's own missions, jobs and approvals, answered from the daemon's tables (0.8.7).
      work: createWorkTool({
        missions,
        plan: (mission) => params.notes.plan({ agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }),
        jobs: params.jobs,
        approvals: { pending: (agentId) => params.approvals().pending(agentId), settled: (options) => params.approvals().settled(options), get: (id) => params.approvals().get(id) },
        // Who a `tell` it passes on is from (0.8.10): their People name — their id where People does not know them.
        speaker: (who) => ({ name: personFor(params.config().people, who.gatewayId, who.senderId)?.name, admin: late?.isAdmin(who) === true }),
        ...(params.linkFor ? { linkFor: params.linkFor } : {}),
        ...(params.audit ? { audit: params.audit } : {}),
      }),
    },
    /** A `mission` job's run (0.8.0): the scheduler's `startMission`. */
    runJob: (job: Job, body: string | undefined) => startJobRun({ missions, store }, job, body),
    /** Presses on a mission's buttons (0.8.7): a question's options (`missions/options.ts`), Accept/Continue/Stop (`actions.ts`). */
    presses: (pipeline: Pick<Pipeline, "isAdmin">) => {
      const isAdmin = (who: { gatewayId: string; senderId: string }) => pipeline.isAdmin(who);
      return [new OptionPresses({ missions, isAdmin }), new ActionPresses({ missions, isAdmin })];
    },
    /** The mission whose turn asked, as its prompt names it (0.8.7). */
    missionOf: (request: { gateway: string; chatId: string }) => {
      const mission = request.gateway === MISSION_GATEWAY_ID ? store.get(request.chatId) : null;
      return mission ? { id: shortId(mission.id), goal: mission.goal } : null;
    },
    /** *Approve similar from this mission*: the kind a request is, and the yes that allows it there (0.8.7). */
    similar: {
      kindOf: (request: { gateway: string; tool: string; params: Record<string, unknown> }) => {
        const kind = request.gateway === MISSION_GATEWAY_ID ? similarKind(request.tool, request.params) : null;
        return kind ? similarLabel(kind) : null;
      },
      allow: (request: { gateway: string; chatId: string; tool: string; params: Record<string, unknown> }) => {
        const kind = request.gateway === MISSION_GATEWAY_ID ? similarKind(request.tool, request.params) : null;
        const mission = kind ? store.get(request.chatId) : null;
        if (kind && mission && !isFinal(mission.status)) similar.allow(mission.id, kind);
      },
    },
    /** Whether a mission's call is covered by such a yes — who gave it, for the gate (`allowedBefore`). */
    allowedBefore: (ask: { gatewayId: string; chatId: string; tool: string; params: Record<string, unknown> }) =>
      ask.gatewayId === MISSION_GATEWAY_ID && similar.allows(ask.chatId, ask.tool, ask.params) ? "approve similar from this mission" : null,
    /** The approval prompts of a mission's turn go to the chat it reports to (`ApprovalPromptsDeps.askedIn`). */
    askedIn: (request: { gateway: string; chatId: string }) => {
      if (request.gateway !== MISSION_GATEWAY_ID) return null;
      const mission = store.get(request.chatId);
      return mission ? { gatewayId: mission.gatewayId, chatId: mission.chatId } : null;
    },
    /** The pipeline and the tools, once both exist — what a mission's turns, checks and reviewer go through. */
    connect(pipeline: Pipeline, tools: Map<string, Tool>, usage: Pick<UsagePort, "forSession" | "helperTokens">): void {
      late = {
        queueTurn: (envelope) => pipeline.queueTurn(envelope),
        voice: (agentId, gatewayId) => pipeline.voiceGatewayId(agentId, gatewayId),
        cancelTurn: (agentId, chatId) => void pipeline.cancelTurnFor(agentId, chatId),
        steerInto: (agentId, chatId, gatewayId, envelope) => pipeline.steerInto(agentId, chatId, gatewayId, envelope),
        steerReach: (agentId) => pipeline.steerReach(agentId),
        isAdmin: (who) => pipeline.isAdmin(who),
        exec: () => tools.get("exec"),
        tools,
        sendAttachment: (ctx, attachment) => pipeline.sendAttachment(ctx, attachment),
        helper: pipeline.subagentRunner(),
        spent: (sessionId, since) => ((spent) => spent.inputTokens + spent.outputTokens)(usage.forSession(sessionId, since)),
        helpers: (sessionId, since) => usage.helperTokens(sessionId, since),
      };
      // A `tell` its turn read is marked read on the mission (0.8.10).
      pipeline.onToldRead((id, tellIds) => missions.toldRead(id, tellIds));
    },
    /**
     * After the gateways are up and the restart's own debts are paid: running missions go on — each reading the call it
     * was cut off in, from the turns the restart closed — and the timer starts.
     */
    begin(recovered: readonly { chatId: string; gatewayId: string; cut: readonly CutCall[] }[]): ReturnType<typeof setInterval> {
      missions.afterRestart(new Map(recovered.filter((turn) => turn.gatewayId === MISSION_GATEWAY_ID).map((turn) => [turn.chatId, turn.cut])));
      log.info("missions resumed", { open: store.open().length });
      return setInterval(contained(log, "a mission timer tick failed", () => missions.tick()), TICK_MS);
    },
  };
}
