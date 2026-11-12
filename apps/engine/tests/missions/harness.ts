/**
 * The missions service on a real, migrated database, with everything it reaches faked: what it says to the chat, the
 * turns it queues, the jobs it stops, the checks it runs, the approvals it has parked, and the clock.
 */

import { join } from "node:path";
import type { ApprovalStatus, MessageButton, MessageEnvelope } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import type { CheckResult } from "@/modules/missions/checks.ts";
import type { Review } from "@/modules/missions/checking.ts";
import type { MissionsDeps } from "@/modules/missions/deps.ts";
import { Missions } from "@/modules/missions/missions.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import type { MissionsInForce } from "@/modules/missions/slots.ts";
import type { SteerOutcome } from "@/modules/missions/tell.ts";
import type { Mission, Told } from "@/modules/missions/types.ts";
import { NotesStore, type PlanStep } from "@/modules/notes/store.ts";
import { tempDir } from "../helpers.ts";

/** Let what was started settle — a mission's first turn and its checks are queued from promises, not timers. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/**
 * The daemon's side of a route test, as far as whose a mission is goes (`web/control/whose.ts`): one person holding
 * the accounts these tests sign in as and the chat id this harness starts missions from, so what a test starts is
 * its account's own to read and change. A test about another person's mission says its own people.
 */
export const STARTERS_CTX = {
  config: { people: [{ key: "starter", name: "Starter", ids: ["web:usr_admin", "web:usr_operator", "web:usr_viewer", "web:usr_1", "web:usr_op", "telegram:8142"] }] },
};

export const SETTINGS: MissionsInForce = { perAgent: 1, maxRunning: 2, limitHours: 8, limitTurns: 50, limitTokens: 50_000_000 };

export async function missionsHarness(options: { settings?: Partial<MissionsInForce>; agents?: string[]; jobAllowed?: (jobId: string) => readonly string[]; prepare?: (mission: Mission) => Promise<string | void>; branchRefusal?: (request: { agentId: string; workdir: string; branch: string }) => Promise<string | null>; sourceRepository?: (workdir: string) => string; runsOnCli?: (agentId: string) => boolean; freeToDelete?: (agentId: string) => boolean; readBrief?: (path: string) => string | null; goalBriefOf?: (mission: Mission) => string | null; stopTurn?: (mission: Mission) => void; helperTokens?: (missionId: string, since: number) => number; runningTokens?: (missionId: string) => number; personSaid?: (mission: Mission) => string | null; turnStartedAt?: (turnId: string) => number | null; checkRefusal?: (request: { agentId: string; workdir?: string }, command: string) => string | null; steerTurn?: (mission: Mission, told: Told) => SteerOutcome; pageOf?: (mission: Mission) => string | null; diskLow?: () => number | null; unsavedIn?: (mission: Mission) => string[] } = {}) {
  const db = await openAndMigrate(join(tempDir("missions"), "nouride.db"));
  const store = new MissionStore(db);
  const told: { mission: string; text: string; buttons?: MessageButton[] }[] = [];
  const queued: MessageEnvelope[] = [];
  const killed: string[] = [];
  /** The missions whose CLI session was let go. */
  const letGo: string[] = [];
  const stopped: string[] = [];
  const removed: string[] = [];
  /** The removals that asked to keep a folder holding work nobody committed. */
  const keepingUnsaved: string[] = [];
  const delivered: string[] = [];
  let unsent: string[] = [];
  /** Each `report.md` sent, by mission, and what it held (0.8.11). */
  const reports: { mission: string; report: string }[] = [];
  let reportRefused: string | null = null;
  /** What reached the chat, in order: a notice, a `report.md`, the files. */
  const sent: string[] = [];
  const remembered: string[] = [];
  /** Each draft's `BRIEF.md`, by mission (0.8.11): what `draftFolder` wrote; the folders it made. */
  const briefs = new Map<string, string>();
  const folders: string[] = [];
  const notes = new NotesStore(join(tempDir("mission-notes"), "notes"));
  const parked = new Map<string, { id: string; what: string }[]>();
  /** How a mission's approvals settled once no longer parked. */
  const settled = new Map<string, ApprovalStatus[]>();
  const jobs = new Map<string, { id: string; gatewayId: string; chatId: string }[]>();
  const asleep = new Set<string>();
  const agents = new Set(options.agents ?? ["nova", "nox"]);
  let checks: (mission: Mission) => Promise<CheckResult> = async () => ({ passed: true, failed: null });
  let review: ((mission: Mission, earlier?: string) => Promise<Review>) | undefined;
  let now = 1_000_000;
  const settings = { ...SETTINGS, ...options.settings };

  const deps: MissionsDeps = {
    ...(options.jobAllowed ? { jobAllowed: options.jobAllowed } : {}),
    store,
    settings: () => settings,
    agents: { exists: (id) => agents.has(id), asleep: (id) => asleep.has(id), privateDir: (id) => `/work/private/${id}` },
    notes,
    jobs: { running: (agentId) => jobs.get(agentId) ?? [], kill: (id) => (killed.push(id), true) },
    parked: (mission) => parked.get(mission.id) ?? [],
    settled: (mission) => settled.get(mission.id) ?? [],
    withdraw: (mission) => void parked.delete(mission.id),
    letGoCli: (mission) => void letGo.push(mission.id),
    tell: async (mission, text, buttons) => void (told.push({ mission: mission.id, text, ...(buttons ? { buttons } : {}) }), sent.push("notice")),
    queueTurn: (envelope) => (queued.push(envelope), true),
    stopTurn: (mission) => {
      stopped.push(mission.id);
      options.stopTurn?.(mission);
    },
    branchRefusal: options.branchRefusal ?? (async () => null),
    ...(options.sourceRepository ? { sourceRepository: options.sourceRepository } : {}),
    ...(options.runsOnCli ? { runsOnCli: options.runsOnCli } : {}),
    ...(options.freeToDelete ? { freeToDelete: options.freeToDelete } : {}),
    readBrief: options.readBrief ?? ((path: string) => [...briefs.entries()].find(([id]) => path.includes(`/missions/${id}/`))?.[1] ?? null),
    draftFolder: async (mission: Mission, brief?: string) => {
      folders.push(mission.id);
      if (brief !== undefined) briefs.set(mission.id, brief);
      return briefs.has(mission.id);
    },
    briefOf: (mission: Mission) => (briefs.has(mission.id) ? `/work/private/${mission.agentId}/missions/${mission.id}/BRIEF.md` : null),
    ...(options.goalBriefOf ? { goalBriefOf: options.goalBriefOf } : {}),
    ...(options.checkRefusal ? { checkRefusal: options.checkRefusal } : {}),
    ...(options.helperTokens ? { helperTokens: (mission: Mission, since: number) => options.helperTokens!(mission.id, since) } : {}),
    ...(options.runningTokens ? { runningTokens: (mission: Mission) => options.runningTokens!(mission.id) } : {}),
    ...(options.personSaid ? { personSaid: options.personSaid } : {}),
    ...(options.turnStartedAt ? { turnStartedAt: options.turnStartedAt } : {}),
    ...(options.steerTurn ? { steerTurn: options.steerTurn } : {}),
    ...(options.pageOf ? { pageOf: options.pageOf } : {}),
    ...(options.diskLow ? { diskLow: options.diskLow } : {}),
    prepare: options.prepare ?? (async () => {}),
    check: (mission) => checks(mission),
    review: (mission, earlier) => (review ? review(mission, earlier) : Promise.resolve({ pass: true, findings: "", tokens: 0 })),
    remember: async (mission) => void remembered.push(mission.id),
    remove: async (mission, how) => {
      if (how?.keepUnsaved) keepingUnsaved.push(mission.id);
      // As the daemon's: with work nobody committed and `keepUnsaved`, it is named and nothing is removed.
      const unsaved = how?.keepUnsaved ? (options.unsavedIn?.(mission) ?? []) : [];
      if (unsaved.length === 0) removed.push(mission.id);
      return unsaved;
    },
    deliver: async (mission) => (delivered.push(...mission.files), sent.push("files"), unsent),
    sendReport: async (mission) => (reports.push({ mission: mission.id, report: mission.report ?? "" }), sent.push("report.md"), reportRefused),
    now: () => now,
  };
  let missions = new Missions(deps);

  return {
    db,
    store,
    /** The service — a new one after `restart`. */
    get missions() {
      return missions;
    },
    /** The daemon started again over the same database: a new service, nothing the last one held in memory. */
    restart: () => void (missions = new Missions(deps)),
    told,
    queued,
    killed,
    letGo,
    stopped,
    removed,
    keepingUnsaved,
    delivered,
    setUnsent: (names: string[]) => void (unsent = names),
    reports,
    setReportRefused: (why: string | null) => void (reportRefused = why),
    sent,
    remembered,
    briefs,
    folders,
    notes,
    parked,
    settled,
    jobs,
    asleep,
    settings,
    setChecks: (fn: (mission: Mission) => Promise<CheckResult>) => void (checks = fn),
    setReview: (fn: (mission: Mission, earlier?: string) => Promise<Review>) => void (review = fn),
    tick: (ms: number) => void (now += ms),
    now: () => now,
    /** A checklist for a mission, as `plan` would keep it. */
    async plan(missionId: string, steps: PlanStep[], agentId = "nova"): Promise<void> {
      await notes.keepPlan({ agentId, gatewayId: "web:mission", chatId: missionId }, "Mission", steps);
    },
    /** Start one in a DM, as a person would from a chat — and let its first turn be queued. */
    async start(goal = "write the report", extra: Partial<Parameters<Missions["start"]>[0]> = {}): Promise<Mission> {
      const result = missions.start({ agentId: "nova", goal, startedBy: "8142", gatewayId: "telegram:nova", chatId: "8142", ...extra });
      if ("refused" in result) throw new Error(result.refused);
      await drain();
      return result.mission;
    },
    /** Run the turn its last queued message would start, and end it as given. */
    turn(mission: Mission, outcome: Partial<{ toolCalls: number; worked: number; tokens: number; tokensUnknown: boolean; failed: boolean; error: string; interrupted: boolean; readOutside: boolean }> = {}, during?: () => void) {
      const envelope = [...queued].reverse().find((one) => one.chatId === mission.id) ?? ({ gatewayId: "web:mission", chatId: mission.id, text: "continue.", senderId: "nouride:system", raw: { via: "mission" } } as MessageEnvelope);
      const shape = missions.shapeFor(mission.agentId, envelope);
      if (!shape) return null;
      // What the agent says through `mission` comes while its turn runs.
      during?.();
      shape.ended({ toolCalls: outcome.toolCalls ?? outcome.worked ?? 1, worked: outcome.worked ?? 1, tokens: outcome.tokens ?? 1000, failed: outcome.failed ?? false, interrupted: outcome.interrupted ?? false, readOutside: outcome.readOutside ?? false, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.tokensUnknown ? { tokensUnknown: true } : {}) });
      return shape;
    },
    /** A turn in which the agent writes its checklist — kept on disk, so awaited before the turn ends. */
    async turnPlanning(mission: Mission, steps: PlanStep[], outcome: { worked: number }) {
      const envelope = [...queued].reverse().find((one) => one.chatId === mission.id) ?? ({ gatewayId: "web:mission", chatId: mission.id, text: "continue.", senderId: "nouride:system", raw: { via: "mission" } } as MessageEnvelope);
      const shape = missions.shapeFor(mission.agentId, envelope);
      if (!shape) return null;
      await notes.keepPlan({ agentId: mission.agentId, gatewayId: "web:mission", chatId: mission.id }, "Mission", steps);
      shape.ended({ toolCalls: outcome.worked, worked: outcome.worked, tokens: 1000, failed: false, interrupted: false, readOutside: false });
      return shape;
    },
    /** Let what a turn queued settle — checks run in the background. */
    async settle(): Promise<void> {
      await drain();
    },
  };
}
