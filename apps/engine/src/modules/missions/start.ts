/**
 * What a new mission is, and what refuses one — apart from the service that runs it, since both are
 * decisions about the request alone.
 */

import { basename } from "@nouride/runtime";
import type { MissionsSection } from "@nouride/shared";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";
import { AGENT_MISSIONS_PER_DAY, CHECK_MAX, CHECKS_MAX, GOAL_MAX, REVIEW_MAX } from "./limits.ts";
import type { MissionsPort } from "./missions.store.ts";
import type { Mission } from "./types.ts";

/** How a mission was asked for. */
export interface StartRequest {
  agentId: string;
  goal: string;
  checks?: readonly string[];
  /** The reviewer's criteria in words, or false for none. */
  review?: string | false;
  accept?: boolean;
  workdir?: string;
  /** The worktree's branch instead of `mission/<id>` — checked with git before it gets here (`Missions.branchRefusal`). */
  branch?: string;
  /** The sender it runs as, on `gatewayId` — the chat it reports to. */
  startedBy: string;
  gatewayId: string;
  chatId: string;
  /** The agent that started it on that person's behalf. */
  byAgent?: string;
  /** Started on the agent's own initiative: it waits for the person's yes before anything runs. */
  proposed?: boolean;
  parentId?: string;
  untrusted?: boolean;
  /** The scheduled job or webhook this is a run of (0.8.0) — it ends at the reviewer, nobody accepts each run. */
  jobId?: string;
  /** The request body that started it, when a webhook did: data on its page, and the mission marked untrusted. */
  request?: string;
  /** A draft's brief (0.8.11): written to `BRIEF.md` in its folder (`drafts.ts`). */
  brief?: string;
  /** The person's own words that asked for it to run at once (0.8.11, `now`): quoted in its *started*. */
  said?: string;
  /** The chat conversation the work came from, and the turn there that started it: its task moves into the mission (`carry.ts`). */
  from?: { agentId: string; gatewayId: string; chatId: string; turnId?: string };
}

const DAY_MS = 24 * 60 * 60_000;
/** A webhook's body as a run's page carries it: the cap a scheduled turn's prompt holds one to (`MAX_TRIGGER_BODY_CHARS`). */
const REQUEST_MAX = 8000;

/**
 * What an agent is told when its goal or review criteria are not in English. Both are read by the mission's model turn
 * after turn and by the reviewer, whatever the person speaks — judged as working text (`workTextIsEnglish`), as plan
 * steps are, so `du -sh /var/lib under 50G` is a goal. What a person types with `/mission` or on the dashboard is theirs
 * and is not judged.
 */
const WRITE_MISSION_IN_ENGLISH =
  "A mission's goal and review criteria are written in English, whatever language the person speaks. Write them again in English. Names, titles and quoted terms may stay as they are. The report and any question to the person stay in their language.";

/**
 * "brief" as the thing named — "Full brief, read first:", "the brief at", "brief file" — not as a word about length: "a
 * brief summary of /home/rina/laporan.md" names the person's document, which is the work (0.8.8).
 */
const BRIEF_NOUN = /(?<!\b(?:it|be|keep|stay|and)\s+)\bbrief\b(?!\s+(?!(?:at|in|file|is|here|first|for|from|read)\b)[a-z])/i;

/** An absolute path in a goal, up to a space, a quote or a closing bracket. */
const PATH_IN_GOAL = /(?<=^|[\s("'`])\/[^\s"'`)]+/g;

/**
 * The brief files a goal points at (0.8.8): an absolute path whose file name says brief (BRIEF and its kin), or that the words
 * just before it call one ("Full brief, read first: /…"). A long goal points at a file since 0.8.7, and nothing read it:
 * the goal was checked for English and the brief it named was not. Only a brief: a goal may name a person's document in
 * their language to work on — "translate /docs/panduan.md" — and that file is the work, not the instruction.
 */
export function briefFilesOf(goal: string): string[] {
  const found = new Set<string>();
  let after = 0;
  for (const match of goal.matchAll(PATH_IN_GOAL)) {
    const path = match[0].replace(/[.,;:!?]+$/, "");
    // The words before it in its own clause: from the last path or sentence's end, at most 40 characters back.
    const clause = goal.slice(Math.max(after, match.index - 40), match.index).split(/[.;!?\n]\s/).at(-1) ?? "";
    if (/(?:^|[^a-z])brief/i.test(basename(path)) || BRIEF_NOUN.test(clause)) found.add(path);
    after = match.index + match[0].length;
  }
  return [...found];
}

/** A brief is a page or two — read every turn, and written whole where it is given in a call (0.8.11). */
const BRIEF_MAX = 20_000;

/**
 * Why a draft's brief cannot be kept as it is, or null (0.8.11, `drafts.ts`): read every turn and by the reviewer, so an
 * agent's is held to English as its goal is, and bounded. A person's is theirs.
 */
export function briefRefusal(text: string, byAgent: boolean): string | null {
  if (text.length > BRIEF_MAX) return `Keep the brief under ${BRIEF_MAX} characters.`;
  if (byAgent && !workTextIsEnglish(text)) return writeWorkInEnglish("The brief");
  return null;
}

/** Why this request cannot be a mission, in words the caller passes on — or null. */
export function startRefusal(
  request: StartRequest,
  deps: {
    exists: (agentId: string) => boolean;
    store: Pick<MissionsPort, "get" | "startedByAgentSince">;
    now: number;
    /** Why a check would not run unattended, as the gate says — `MissionsDeps.checkRefusal`. */
    checkRefusal?: (request: Pick<StartRequest, "agentId" | "workdir">, command: string) => string | null;
    /** A brief file's text, or null where it cannot be read — `MissionsDeps.readBrief`. */
    readBrief?: (path: string) => string | null;
  },
): string | null {
  if (!deps.exists(request.agentId)) return `There is no agent called ${request.agentId}.`;
  const goal = request.goal.trim();
  if (!goal) return "A mission needs a goal: what should be true when it is done.";
  if (goal.length > GOAL_MAX) return `Keep the goal under ${GOAL_MAX} characters: write the detail to a brief file first (in English, and whole, as the goal is) and name its absolute path in the goal.`;
  const checks = request.checks ?? [];
  if (checks.length > CHECKS_MAX) return `A mission takes at most ${CHECKS_MAX} check commands.`;
  if (checks.some((check) => typeof check !== "string" || check.length > CHECK_MAX)) return `Each check is one command, under ${CHECK_MAX} characters.`;
  // A check that would ask a person never runs (`checks.ts`), and a mission cannot change its own: refused now, while
  // whoever wrote it is here to write another, not after the work is done.
  for (const check of checks) {
    const why = check.trim() ? deps.checkRefusal?.(request, check.trim()) : null;
    if (why) return `The check \`${check.trim()}\` would not run: ${why}. Checks run with nobody to ask and none of your credentials, so each must only read what is here: a file, a local branch, tests in the worktree.`;
  }
  if (typeof request.review === "string" && request.review.length > REVIEW_MAX) return `Keep the review criteria under ${REVIEW_MAX} characters.`;
  if (request.byAgent && (!workTextIsEnglish(goal) || (typeof request.review === "string" && !workTextIsEnglish(request.review)))) {
    return WRITE_MISSION_IN_ENGLISH;
  }
  const brief = request.brief === undefined ? null : briefRefusal(request.brief, Boolean(request.byAgent));
  if (brief) return brief;
  if (request.workdir !== undefined && !request.workdir.startsWith("/")) return "`workdir` is an absolute path to a folder the agent can reach.";
  // A worktree is made only for a folder given in a repository: the mission's own folder is never one.
  if (request.branch !== undefined && request.workdir === undefined) return "`branch` names the worktree's branch, so it needs a `workdir` in a git repository.";
  // An agent starting work is counted; a person starting it is not.
  if (request.byAgent && deps.store.startedByAgentSince(request.byAgent, deps.now - DAY_MS) >= AGENT_MISSIONS_PER_DAY) {
    return `${request.byAgent} has started ${AGENT_MISSIONS_PER_DAY} missions in the last day, the most an agent may. A person can still start one with /mission.`;
  }
  // The brief a goal points at is read as the goal is, turn after turn and by the reviewer: judged the same way — after
  // the day's count, so a file is read for no start that would be refused anyway. One the daemon cannot read is left to
  // the mission, which says so when it opens it.
  for (const path of request.byAgent && deps.readBrief ? briefFilesOf(goal) : []) {
    const text = deps.readBrief!(path);
    if (text !== null && !workTextIsEnglish(text)) return writeWorkInEnglish(`The brief file ${path}, which the goal points at,`);
  }
  if (request.parentId) {
    const parent = deps.store.get(request.parentId);
    if (!parent) return "The mission this one would belong to is gone.";
    if (parent.parentId) return "A mission started inside another one starts none of its own: one level only.";
  }
  return null;
}

/** The row a request becomes: queued — or, proposed, waiting for the person's yes. Its limits are the settings now. */
export function newMission(
  request: StartRequest,
  at: { id: string; settings: MissionsSection; privateDir: string; now: number },
): Mission {
  const { id, settings, now } = at;
  const proposed = request.proposed === true;
  return {
    id,
    agentId: request.agentId,
    startedBy: request.startedBy,
    byAgent: request.byAgent ?? null,
    gatewayId: request.gatewayId,
    chatId: request.chatId,
    goal: request.goal.trim(),
    checks: (request.checks ?? []).map((check) => check.trim()).filter(Boolean),
    review: typeof request.review === "string" && request.review.trim() ? request.review.trim() : null,
    reviewOn: request.review !== false,
    accept: request.accept === true,
    status: proposed ? "waiting" : "queued",
    waitKind: proposed ? "accept" : null,
    reason: proposed ? `proposed by ${request.byAgent ?? request.agentId}, not started` : null,
    report: null,
    summary: null,
    files: [],
    lastCheck: null,
    answers: [],
    told: [],
    workdir: request.workdir ?? `${at.privateDir.replace(/\/+$/, "")}/missions/${id}`,
    branch: request.branch ?? null,
    parentId: request.parentId ?? null,
    untrusted: request.untrusted === true || Boolean(request.request?.trim()),
    jobId: request.jobId ?? null,
    request: request.request?.trim() ? request.request.slice(0, REQUEST_MAX) : null,
    reviewed: false,
    limits: { hours: settings.limitHours, turns: settings.limitTurns, tokens: settings.limitTokens },
    turnsUsed: 0,
    tokensUsed: 0,
    cliTurns: 0,
    cliUnreported: 0,
    helpersSince: null,
    resumes: 0,
    waitedMs: 0,
    waitingSince: proposed ? now : null,
    warnedAt: null,
    followedUpAt: null,
    progressAt: null,
    progressDone: 0,
    nudgedAt: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    endedAt: null,
  };
}
