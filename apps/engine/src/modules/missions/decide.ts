/**
 * The dispatcher's decisions, apart from what it does with them — pure, so each rule is one test (MISSIONS §7–8).
 */

import { dirname, fileExistsSync, join } from "@nouride/runtime";
import type { MissionWaitKind } from "@nouride/wire";
import { plural } from "@nouride/shared";
import type { KeptPlan } from "@/modules/notes/store.ts";
import { IDLE_TURNS, RETRY_AFTER_MS, RETRY_ATTEMPTS, WARN_AT } from "./limits.ts";
import { hoursLimit, millions, workedMs } from "./page.ts";
import type { MissionsInForce } from "./slots.ts";
import { isFinal, type Mission } from "./types.ts";

/**
 * Where a mission's repository is: the nearest folder above its workdir holding `.git`, or the workdir itself. A
 * mission's worktree holds a `.git` of its own, so it is a repository apart, and two of them never share one (§8).
 */
export function repositoryOf(workdir: string, exists: (path: string) => boolean = fileExistsSync): string {
  let dir = workdir;
  for (;;) {
    if (exists(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return workdir;
    dir = up;
  }
}

/**
 * The repository a folder's work belongs to (0.8.7): `repositoryOf`, followed out of a linked worktree to the repository
 * it was made from — a mission's worktree is a repository apart for the one-mission rule, and the same repository for
 * the person asking "is another mission already in this repo?". `readGit` reads a worktree's `.git` file; null for a
 * folder, where `.git` is the repository itself.
 */
export function sourceRepositoryOf(workdir: string, readGit: (path: string) => string | null, exists: (path: string) => boolean = fileExistsSync): string {
  const repo = repositoryOf(workdir, exists);
  const pointer = readGit(join(repo, ".git"))?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  const main = pointer?.match(/^(.*)\/\.git\/worktrees\/[^/]+$/)?.[1];
  return main ?? repo;
}

/** The same agent's other open missions in this one's repository — not its parent, nor one it handed out (0.8.7). */
export function openInSameRepository(mission: Mission, open: readonly Mission[], sourceOf: (workdir: string) => string): Mission[] {
  const me = mission.byAgent ?? mission.agentId;
  const own = (one: Mission) => one.agentId === me || one.byAgent === me;
  const repo = sourceOf(mission.workdir);
  return open.filter((one) => one.id !== mission.id && one.id !== mission.parentId && one.parentId !== mission.id && own(one) && sourceOf(one.workdir) === repo);
}

/** Whether one folder is the other or inside it — two missions there would write each other's files. */
function overlaps(a: string, b: string): boolean {
  const inside = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer.replace(/\/+$/, "")}/`);
  return inside(a, b) || inside(b, a);
}

/**
 * Why a queued mission cannot start yet, said as the queue notice says it — or null when it may, against the missions
 * open. Slots count missions with a turn or a job: one waiting for a person holds none. One repository, one mission at
 * a time (§8): its folder's repository against every one started and not ended — one waiting for a person still has
 * its work there, and counted with the slots, a second was started over it.
 */
export function blockedBy(
  mission: Mission,
  open: readonly Mission[],
  settings: Pick<MissionsInForce, "perAgent" | "maxRunning" | "slotsOf">,
  repoOf: (workdir: string) => string = repositoryOf,
): string | null {
  const busy = open.filter((other) => other.status === "running" || other.status === "checking");
  // An agent's own slot is its turns' (0.8.11): one being checked runs its checks and a reviewer, a helper, not the agent,
  // and held the slot — a fourth mission waited out msn_b97876's review on 2026-10-31. The box's count still has it.
  const mine = busy.filter((other) => other.agentId === mission.agentId && other.status === "running");
  // Its own number where its pack names one (0.8.11), the daemon's otherwise.
  const slots = settings.slotsOf?.(mission.agentId) ?? settings.perAgent;
  if (mine.length >= slots) {
    return `${mission.agentId} already runs ${mine.map((other) => other.id.slice(0, 10)).join(", ")} (per_agent ${slots})`;
  }
  if (busy.length >= settings.maxRunning) {
    return `the box already runs ${busy.map((other) => other.id.slice(0, 10)).join(", ")} (max_running ${settings.maxRunning})`;
  }
  const repo = repoOf(mission.workdir);
  const same = open.find((other) => other.startedAt !== null && !isFinal(other.status) && overlaps(repoOf(other.workdir), repo));
  if (same) return `${same.id.slice(0, 10)} is working in the same folder (${repo})`;
  return null;
}

/**
 * Which limits hold (0.8.7). A coding CLI's mission is held to time and tokens only: one of its turns is a whole prompt
 * the CLI may work on for tens of minutes, and counting those against fifty model turns measured nothing.
 */
export interface LimitsInForce {
  turns: boolean;
}

const ALL_LIMITS: LimitsInForce = { turns: true };

export type MissionLimit = keyof Mission["limits"];

/**
 * What a mission has spent that is not in its count yet (0.8.8, `counts.ts` `unsettled`): its helpers' tokens since the
 * last count, and its coding CLI's turn running now — an estimate until the turn ends and the CLI says what it spent.
 */
export interface Unsettled {
  helpers: number;
  running: number;
}

const SETTLED: Unsettled = { helpers: 0, running: 0 };

/** Each limit a mission has reached, of those in force: more than one can be at once. */
function limitsReached(mission: Mission, now: number, inForce: LimitsInForce = ALL_LIMITS, unsettled: Unsettled = SETTLED): MissionLimit[] {
  const reached: MissionLimit[] = [];
  if (inForce.turns && mission.turnsUsed >= mission.limits.turns) reached.push("turns");
  if (mission.tokensUsed + unsettled.helpers + unsettled.running >= mission.limits.tokens) reached.push("tokens");
  if (workedMs(mission, now) >= mission.limits.hours * 3_600_000) reached.push("hours");
  return reached;
}

/**
 * Each limit in force at 80% of itself or more — those it reached among them (0.8.8): what going on raises. Only the one
 * reached rose, and one at 99% beside it stopped the mission again a minute later (a review of 44ec0bc3); all three rose
 * before, and a token limit took msn_3d28e0's 100 turns, one used, to 101.
 */
export function limitsNear(mission: Mission, now: number, inForce: LimitsInForce = ALL_LIMITS, unsettled: Unsettled = SETTLED): MissionLimit[] {
  const near: MissionLimit[] = [];
  if (inForce.turns && mission.turnsUsed >= mission.limits.turns * WARN_AT) near.push("turns");
  if (mission.tokensUsed + unsettled.helpers + unsettled.running >= mission.limits.tokens * WARN_AT) near.push("tokens");
  if (workedMs(mission, now) >= mission.limits.hours * 3_600_000 * WARN_AT) near.push("hours");
  return near;
}

/**
 * The limit a mission has reached, in the words its notice uses — the first, where more than one is — or null. Reached
 * with a running CLI turn's estimate in it, the words say so: what the CLI spent is known only at the turn's end.
 */
export function limitReached(mission: Mission, now: number, inForce: LimitsInForce = ALL_LIMITS, unsettled: Unsettled = SETTLED): string | null {
  const reached = limitsReached(mission, now, inForce, unsettled)[0];
  if (reached === "turns") return `its turn limit (${mission.limits.turns} turns)`;
  if (reached === "tokens") {
    const so = unsettled.running > 0 ? `; about ${millions(mission.tokensUsed + unsettled.helpers + unsettled.running)} so far, by what its CLI said while it worked` : "";
    return `its token limit (${millions(mission.limits.tokens)} tokens${so})`;
  }
  if (reached === "hours") return `its time limit (${hoursLimit(mission.limits.hours)} of work)`;
  return null;
}

/**
 * What going on gives each limit it raises, in words (`person.ts` `continueMission`): its setting again, counted from
 * where it stands — "100M more tokens". The notice said "the same limits again", and a person read it as all three.
 */
export function continueGives(reached: readonly MissionLimit[], settings: { limitTurns: number; limitTokens: number; limitHours: number }): string {
  const more = reached.map((limit) =>
    limit === "turns" ? `${settings.limitTurns} more ${plural(settings.limitTurns, "turn")}` : limit === "tokens" ? `${millions(settings.limitTokens)} more tokens` : `${hoursLimit(settings.limitHours)} more of work`,
  );
  return more.join(" and ");
}

/** The limit past 80% that the chat has not been told about, or null. Told once per mission. */
export function nearLimit(mission: Mission, now: number, inForce: LimitsInForce = ALL_LIMITS): string | null {
  if (mission.warnedAt !== null) return null;
  if (inForce.turns && mission.turnsUsed >= mission.limits.turns * WARN_AT) return `its ${mission.limits.turns} turns`;
  if (mission.tokensUsed >= mission.limits.tokens * WARN_AT) return `its ${millions(mission.limits.tokens)} tokens`;
  if (workedMs(mission, now) >= mission.limits.hours * 3_600_000 * WARN_AT) return `its ${hoursLimit(mission.limits.hours)} of work`;
  return null;
}

/** A checklist's state in a form that changes when any step does — what "moved a step" compares. */
export function planSignature(plan: KeptPlan | undefined): string {
  return plan ? JSON.stringify(plan.steps.map((step) => [step.text, step.state, step.note ?? ""])) : "";
}

export function stepsDone(plan: KeptPlan | undefined): number {
  return plan ? plan.steps.filter((step) => step.state === "done" || step.state === "skipped").length : 0;
}

/**
 * Whether a message into a waiting mission's conversation is what it waits for (its `via`): an approval answered, for a
 * wait on its approvals — or one of its jobs ending, which either wait may have been for. Not a job's still-going note,
 * nor a turn a restart or a provider takes up, nor an approval answered while it waits on its question: each resumed it
 * without what it waited for, and the person's `/mission answer` was then refused.
 */
export function answersWait(wait: MissionWaitKind | null, via: unknown): boolean {
  if (via === "job completion") return wait === "approval" || wait === "input";
  return via === "approval resumed" && wait === "approval";
}

/** What a mission does once a turn that claimed nothing has ended (§7): go on, wait for a job, or need a person. */
export type Next =
  | { kind: "continue"; why: string }
  | { kind: "job" }
  | { kind: "retry"; attempt: number; reason: string }
  | { kind: "wait"; on: "approval" | "stuck"; reason: string };

/** How long a paused mission waits before its `attempt`-th try again (`RETRY_AFTER_MS`, its last repeated). */
export function retryAfter(attempt: number): number {
  return RETRY_AFTER_MS[Math.min(Math.max(attempt, 1), RETRY_AFTER_MS.length) - 1]!;
}

export function afterTurn(input: {
  /** Turns in a row that called no tool and moved no step, this one counted. */
  idle: number;
  /** Turns in a row that failed, this one counted. */
  failures: number;
  error?: string;
  /** Approvals it has parked and nobody has answered. */
  parked: number;
  /** This turn called no tool and moved no step. */
  stood: boolean;
  /** This turn finished a step of its checklist — done or skipped, not only a note changed. */
  finished: boolean;
  /** One of its jobs is still running, or a mission it handed out is still open — its end wakes the mission. */
  jobRunning: boolean;
}): Next {
  // Its model could not answer: paused, tried again by itself, further apart each time (`RETRY_AFTER_MS`); a person
  // decides only after a day of it.
  if (input.failures > RETRY_ATTEMPTS) return { kind: "wait", on: "stuck", reason: `its model could not answer for ${RETRY_ATTEMPTS} tries over about a day (the last: ${input.error ?? "no answer"})` };
  if (input.failures > 0) return { kind: "retry", attempt: input.failures, reason: input.error ?? "no answer" };
  /**
   * With a call parked, a turn that finished no step waits for the person, whatever else it called: on the live box
   * each such turn read its approvals, found them pending, wrote "still pending" into a step's note and ended — and,
   * reading being a call that worked, the mission went on, a turn a minute.
   */
  if (input.parked > 0 && !input.finished) return { kind: "wait", on: "approval", reason: "the approvals it parked" };
  if (input.idle >= IDLE_TURNS) return { kind: "wait", on: "stuck", reason: `${IDLE_TURNS} turns in a row called no tool and moved no step` };
  if (input.jobRunning) return { kind: "job" };
  return { kind: "continue", why: "continue with the next step." };
}
