/**
 * A mission: long work an agent finishes alone (0.8.0). One record and one conversation — the record says what the
 * work is, where it reports and where it stands; the conversation is where the agent does it, through the pipeline every
 * chat uses. The §-numbers in this module are the design's (MISSIONS); this file is its shape.
 */

import type { MissionSeen, MissionStatus, MissionWaitKind } from "@nouride/wire";

const FINAL: readonly MissionStatus[] = ["done", "failed", "stopped"];

export function isFinal(status: MissionStatus): boolean {
  return FINAL.includes(status);
}

export function seenAs(status: MissionStatus): MissionSeen {
  if (status === "waiting") return "needs_you";
  if (status === "done") return "done";
  if (status === "failed" || status === "stopped") return "ended";
  return "working";
}

/** A question the mission asked, and the answer once there is one. */
export interface Answered {
  /** As the person reads it, with its options listed under it (`options.ts` `withOptions`). */
  question: string;
  /** The answers the agent offered to pick from, a button each; none for a free answer. */
  options?: string[];
  answer?: string;
  at: number;
}

/**
 * Words a person told a mission while it worked (`tell`, 0.8.10): followed over the goal's details, never a new goal. Recorded before
 * they are delivered, so a restart between the two loses nothing; `read` is the turn they were handed to the model in.
 */
export interface Told {
  id: string;
  /** Who said them, as the other verbs write it — "<person> via <agent>" where an agent passed them on. */
  by: string;
  at: number;
  text: string;
  /** The agent that relayed them from its chat, when one did (`work` action tell). */
  via?: string;
  /** The turn, by its number, they were handed to the model in; absent while unread. */
  read?: number;
}

/** Who said it, as a page and a notice name them: "Sam", or "Sam via nouva". */
export function toldBy(one: Pick<Told, "by" | "via">): string {
  return one.via ? `${one.by} via ${one.via}` : one.by;
}

export interface MissionLimits {
  hours: number;
  turns: number;
  tokens: number;
}

export interface Mission {
  id: string;
  agentId: string;
  /** The sender who started it, on `gatewayId`: whose approval level and People entry apply. */
  startedBy: string;
  /** The agent that started it on that person's behalf, when an agent did. */
  byAgent: string | null;
  /** Where it reports: the chat it began in. */
  gatewayId: string;
  chatId: string;
  goal: string;
  checks: string[];
  /** The reviewer's criteria in words; null = the goal itself. */
  review: string | null;
  reviewOn: boolean;
  accept: boolean;
  status: MissionStatus;
  waitKind: MissionWaitKind | null;
  /** What it waits for, or why it ended. */
  reason: string | null;
  /** The whole account of the work `done` or `fail` handed back: sent to its chat as `report.md`, never cut (0.8.11). */
  report: string | null;
  /** Its result, two or three sentences from `done`: the chat's text when it ends (0.8.11). Null before then. */
  summary: string | null;
  /** Result files `done` named, inside its folder. */
  files: string[];
  /** The failed check's output, clipped — on the next turn's page. */
  lastCheck: string | null;
  answers: Answered[];
  /** What a person told it while it worked, oldest first (`tell.ts`). */
  told: Told[];
  workdir: string;
  /** The branch its worktree is made on, as named at start (0.8.7); null is `mission/<id>` (`worktree.ts` `branchOf`). */
  branch: string | null;
  parentId: string | null;
  untrusted: boolean;
  /** The scheduled job or webhook whose run this is (0.8.0): it ends at the reviewer, and reports to the job's chat. */
  jobId: string | null;
  /** The request body that started the run, when a webhook did — data on its page, never an instruction. */
  request: string | null;
  /** The reviewer passed it. What the done notice says, rather than that a review was asked for. */
  reviewed: boolean;
  limits: MissionLimits;
  turnsUsed: number;
  tokensUsed: number;
  /**
   * A coding CLI's turns, and how many of them reported no tokens: whether its tokens are known, a floor or unknown.
   * On the record, not in memory, so a restart says the same (`counts.ts`).
   */
  cliTurns: number;
  cliUnreported: number;
  /** Up to when its helpers' tokens are in `tokensUsed` — the last turn's end, or the reviewer's; null before the first. */
  helpersSince: number | null;
  resumes: number;
  waitedMs: number;
  waitingSince: number | null;
  warnedAt: number | null;
  followedUpAt: number | null;
  progressAt: number | null;
  progressDone: number;
  nudgedAt: number | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  endedAt: number | null;
}
