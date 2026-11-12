/**
 * Missions (`routes/missions.ts`, `routes/mission-settings.ts`): long work an agent finishes alone, its record, and the
 * limits it runs under.
 */

import type { ApprovalRequest } from "./approvals.ts";
import type { NotesPlan, NotesTask } from "./notes.ts";

/** Seven for the page, the CLI and the event stream; people see four (`seenAs`). */
export type MissionStatus = "queued" | "running" | "waiting" | "checking" | "done" | "failed" | "stopped";

/**
 * Why a waiting mission waits: approvals parked and nothing else left to do, a question it asked, a loop it cannot get
 * out of, a call a restart cut off whose outcome is unknown, a limit reached, or checks that passed and a person who
 * accepts — each needing a person — or (0.8.7) its model could not answer, and it tries again by itself (`retry`).
 */
export type MissionWaitKind = "approval" | "input" | "stuck" | "unknown_outcome" | "limit" | "accept" | "retry";

/** What a person sees: working, needs you, done, ended. */
export type MissionSeen = "working" | "needs_you" | "done" | "ended";

/** A question the mission asked, and the answer once there is one. */
export interface MissionAnswered {
  question: string;
  answer?: string;
  at: number;
}

/** What a person told it while it worked (0.8.10), and the turn it read it in — absent while unread. */
export interface MissionTold {
  id: string;
  by: string;
  at: number;
  text: string;
  /** The agent that passed it on from its chat, when one did. */
  via?: string;
  read?: number;
}

/** Whether a mission's tokens are known: all reported, none — a CLI that reports none — or some, a floor (0.8.7). */
export type MissionTokens = "known" | "unknown" | "partial";

/** A mission as the daemon's routes answer it: the record, what a person sees it as, and the time it has worked. */
export interface MissionView {
  id: string;
  agentId: string;
  /** Who started it, on `gatewayId` — whose approval level applies. */
  startedBy: string;
  /** The agent that started it on that person's behalf, when an agent did. */
  byAgent: string | null;
  /** The person it is for, by People: what an admin's Everyone sets it apart under. Absent for nobody's. */
  person?: { key: string; name: string };
  /**
   * Whether whoever asked may change it: whoever started it, or an admin. One that only reports to a chat of theirs
   * is theirs to read. Absent from a daemon older than the field, where everyone changed everything.
   */
  changeable?: boolean;
  /** Where it reports: the chat it began in. */
  gatewayId: string;
  chatId: string;
  goal: string;
  checks: string[];
  /** The reviewer's criteria; null is the goal itself. */
  review: string | null;
  reviewOn: boolean;
  /** A person accepts the result before it is done. */
  accept: boolean;
  status: MissionStatus;
  waitKind: MissionWaitKind | null;
  /** What it waits for, or why it ended. */
  reason: string | null;
  report: string | null;
  /** Result files `done` named, inside its folder. */
  files: string[];
  /** The failed check's output, clipped. */
  lastCheck: string | null;
  answers: MissionAnswered[];
  told: MissionTold[];
  workdir: string;
  /** The branch its worktree was named at start; null is `mission/<id>`. */
  branch: string | null;
  limits: { hours: number; turns: number; tokens: number };
  turnsUsed: number;
  tokensUsed: number;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  endedAt: number | null;
  seen: MissionSeen;
  /** Time it has worked, waits on a person left out — what the hours limit measures. */
  workedMs: number;
  /**
   * Which limits hold and whether its tokens are known (0.8.8): a coding CLI's mission is held to no turn limit, and its
   * tokens are unknown where the CLI reports none — a floor where it reported for some turns only.
   */
  shown: { turns: boolean; tokens: MissionTokens };
  /** The scheduled job or webhook whose run this is (0.8.0): it ends at the reviewer. Absent from a daemon before it. */
  jobId?: string | null;
  /** The request body that started the run, when a webhook did. */
  request?: string | null;
  /** The reviewer passed it. */
  reviewed?: boolean;
  /** On the list only: how far along its checklist is, null before it wrote one. */
  checklist?: { done: number; total: number; active: string | null } | null;
}

/** One mission, as its page reads it. */
export interface MissionDetail {
  mission: MissionView;
  /** Its conversation's session: its turns, its live steps, its notes. */
  sessionId: string;
  plan: NotesPlan | null;
  notes: NotesTask[];
  /** Calls it parked for a person, answerable for a day. */
  parked: ApprovalRequest[];
  /** The steps its turns took, as each turn's line counts them: a call, or a wait on a person (0.8.0). */
  steps?: number;
  /** The name of the job it is a run of, while that job exists. */
  jobName?: string;
  /** The reviewer at work (0.8.10): which pass, of how many, since when — absent when none is. */
  reviewing?: Reviewing;
  /** Its `BRIEF.md` as written in its folder (0.8.11): what the work is, what to read, what done means. */
  brief?: string | null;
  /** Where that brief is: its own folder's `BRIEF.md`, or a file its goal names, in its agent's folder (0.8.11). */
  briefPath?: string | null;
}

/** A draft's change from the dashboard (0.8.11): what is sent changes, what is not stays. `workdir: null` is its own folder. */
export interface MissionEdit {
  goal?: string;
  checks?: string[];
  review?: string;
  noReview?: boolean;
  accept?: boolean;
  workdir?: string | null;
  branch?: string | null;
  limits?: { hours?: number; turns?: number; tokens?: number };
  brief?: string;
}

/** The reviewer at work on a mission: minutes a pass, where "Running its checks" alone read as stuck. */
export interface Reviewing {
  pass: number;
  of: number;
  since: number;
}

export interface MissionStart {
  agent: string;
  goal: string;
  checks?: string[];
  review?: string;
  /** No reviewer at all: checks, and a person when there are none. */
  noReview?: boolean;
  accept?: boolean;
  workdir?: string;
}

/** What a person says to a mission. */
export type MissionVerb = "stop" | "continue" | "accept" | "answer" | "tell";

/** The five `[missions]` settings by name. */
export interface MissionLimits {
  perAgent: number;
  maxRunning: number;
  limitHours: number;
  limitTurns: number;
  limitTokens: number;
}

/**
 * `[missions]`: the values in force, each one's default, and the bounds each keeps — the schema's, so the form and the
 * loader agree. The slots on the box follow the machine while unset (`auto`), held to what the agents that are on could
 * run: their default and their most are worked out from both.
 */
export interface MissionSettings extends MissionLimits {
  auto: boolean;
  defaults: MissionLimits;
  bounds: Record<keyof MissionLimits, { min: number; max?: number; integer: boolean }>;
  editable: boolean;
}

/** `null` takes a key out of the file — back to its default. */
export type MissionSettingsPatch = Partial<Record<keyof MissionLimits, number | null>>;
