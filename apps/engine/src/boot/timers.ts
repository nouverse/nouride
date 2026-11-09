/**
 * Starting the timers: the daemon's background work — its snapshots, its sweeps, the night's pass, the morning lines —
 * each held on the context so shutdown stops it before the database closes (`DaemonContext.backgroundTimers`).
 *
 * Two starts, at their places in the boot (`index.ts`), because each takes its first look at once and what it looks at
 * decides where it can go. The snapshots come as soon as memory is open and before the turn machine's parts are built:
 * the first copy of a run is of what the boot found. The upkeep comes once what it sweeps, alerts through and asks
 * exists — the approval gate among them — and before the approvals a previous run left are carried over.
 */

import { join, type SqliteDb } from "@nouride/runtime";
import type { AgentRegistry } from "@nouride/persona";
import type { SecretStore } from "@nouride/secrets";
import type { Gateway, GlobalConfig } from "@nouride/shared";
import { BoxLoad } from "@/commons/box-load.ts";
import type { LogStore } from "@/commons/logs.store.ts";
import type { Notifier } from "@/commons/notify.ts";
import { RoomWait } from "@/commons/room-wait.ts";
import type { Memory } from "@/modules/memory/index.ts";
import { MemoryStateStore } from "@/modules/memory/memory-state.store.ts";
import type { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { SupervisorInfo } from "@/service/supervisor.ts";
import { LAUNCHD_LOG_FILE } from "@/service/unit.ts";
import {
  startAgentBackups,
  startConfigBackups,
  startDatabaseBackups,
  startDiskAlerts,
  startKnowledgeBackups,
  startLogFileRotation,
  startRetentionSweep,
  startVaultBackups,
} from "./maintenance.ts";
import { startKnowledgeLook } from "./memory.ts";
import { startMemoryPass } from "./memory-pass.ts";
import { startMorning } from "./morning-lines.ts";
import type { Stores } from "./stores.ts";

type Timer = ReturnType<typeof setInterval>;

/** The snapshots taken at boot and on their schedule, and the launchd log kept to one size. */
export function startSnapshots(input: {
  config: GlobalConfig;
  db: SqliteDb;
  logStore: Pick<LogStore, "rowsWritten">;
  configPath: string;
  secrets: Pick<SecretStore, "sealedCopyText">;
  supervisor: Pick<SupervisorInfo, "kind">;
}): Timer[] {
  const { config, db } = input;
  // Snapshotted at boot and daily, because the most likely moment to lose a pack is while
  // somebody is editing it.
  const backupTimer = startAgentBackups(config);

  /**
   * And the database, which until now was the one thing here with no copy at all.
   *
   * After the boot check has run on the live file — or a clean stop has vouched for it — so the first
   * snapshot of each run is one taken with the original known good. And the memory vault beside it: the database only
   * indexes it, so the vault is the half of memory that cannot be rebuilt.
   */
  const dbBackupTimers = [
    startDatabaseBackups(config, db, Date.now, () => db.totalChanges() - input.logStore.rowsWritten()),
    startVaultBackups(config),
    startKnowledgeBackups(config),
    ...startConfigBackups(config, input.configPath, () => input.secrets.sealedCopyText()),
  ];
  // launchd has no journal: its log is a file, kept to one size here.
  const logFileTimers = input.supervisor.kind === "launchd" ? [startLogFileRotation(join(process.cwd(), LAUNCHD_LOG_FILE))] : [];
  return [backupTimer, ...dbBackupTimers, ...logFileTimers];
}

/** What the upkeep sweeps and reads, of the stores. */
type UpkeepStores = Pick<
  Stores,
  | "db" | "attachments" | "attachmentIndex" | "usage" | "sessions" | "turns" | "chatEvents" | "roomMessages" | "jobs"
  | "spill" | "uploads" | "audit" | "logStore" | "cron" | "drafts" | "durable" | "notes" | "providers" | "state"
>;

/**
 * The retention sweep, the disk alerts, the box's load, the night's memory pass, the morning lines and the knowledge
 * folder's look. Hands back the load and the memory pass, which the turn machine and the control plane read.
 */
export function startUpkeep(
  stores: UpkeepStores,
  input: {
    config: GlobalConfig;
    registry: AgentRegistry;
    gateways: Map<string, Gateway>;
    memory: Memory;
    notifier: Notifier;
    approvals: SqliteApprovalGate;
    missions: Parameters<typeof startMorning>[0]["missions"] & Parameters<typeof startRetentionSweep>[0]["missions"];
    skillReview: Parameters<typeof startRetentionSweep>[0]["skillReview"];
    /** The knowledge base's wait for room, filled in here once the box's load is sampled (0.8.20). */
    knowledgeRoom: { wait?: () => Promise<unknown> };
    /** The pipeline, read when a morning line is sent: it is built after the timers. */
    pipeline: Parameters<typeof startMorning>[0]["pipeline"];
  },
): { timers: Timer[]; load: BoxLoad; memoryPass: ReturnType<typeof startMemoryPass> } {
  const { config, notifier, approvals, memory } = input;
  const { db, usage, turns, cron } = stores;
  // On the heartbeat, alerted rather than only logged: a full disk makes every other symptom
  // confusing, and it is entirely preventable with warning.
  const diskTimer = startDiskAlerts(config, notifier);

  /**
   * At boot and daily. Everything this daemon writes that only ever grows is swept here.
   *
   * After the approval gate rather than before it, which is why this moved: the first sweep runs
   * immediately, and it now prunes settled approvals too.
   */
  const retentionTimer = startRetentionSweep({
    config, attachments: stores.attachments, attachmentIndex: stores.attachmentIndex, usage, sessions: stores.sessions, turns,
    chatEvents: stores.chatEvents, roomMessages: stores.roomMessages, jobs: stores.jobs, spill: stores.spill, uploads: stores.uploads,
    audit: stores.audit, approvals, logs: stores.logStore, cron, drafts: stores.drafts, inbox: stores.durable.inbox, missions: input.missions,
    memoryChanges: new MemoryStateStore(db),
    notes: stores.notes,
    skillReview: input.skillReview,
  });
  // Whether the machine is busy, for the night's pass and background helpers to make room for it (0.8.0) — sampled from
  // here, so the first look has the minute before it.
  const load = new BoxLoad();
  const loadTimer = load.start();
  // Embedding new documents waits while the box is busy, as the night's pass does, for at most two hours a run.
  input.knowledgeRoom.wait = () => new RoomWait(load, { what: "embedding the knowledge base", ceilingMs: 2 * 3_600_000, now: Date.now }).wait();
  const memoryPass = startMemoryPass({ config, registry: input.registry, providers: stores.providers, usage, turns, memory, db, load });
  // Each person's morning line, at the time they set (0.8.0): what happened while they were away.
  const morningTimer = startMorning({ config: () => config, gateways: input.gateways, notifier, turns, cron, missions: input.missions, approvals: () => approvals, usage, pipeline: input.pipeline, state: stores.state });
  // The knowledge base's folder, looked at again on its own clock (`boot/memory.ts`).
  const knowledgeTimer = startKnowledgeLook(memory);
  return { timers: [retentionTimer, diskTimer, memoryPass.timer, morningTimer, knowledgeTimer, ...(loadTimer ? [loadTimer] : [])], load, memoryPass };
}
