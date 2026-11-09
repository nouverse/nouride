/**
 * What a minute's check finds about the missions — one timer for all of them, started at boot:
 *
 * - a running mission past its hours or its tokens, while a long job holds it — or while a coding CLI's turn does: that
 *   turn stopped;
 * - one gone quiet — no turn, no job, nothing for an hour: a nudge, then a person is told;
 * - one waiting for a person: named again once, after four hours; past a week at a limit, ended;
 * - parked approvals that expired with nobody answering: the mission is told, and goes on without them;
 * - a step finished since the last progress line, half an hour on: the next line.
 */

import { inOwnFolder, ownFolderOf } from "./worktree.ts";
import { createLogger } from "@nouride/shared";
import type { MissionsDeps } from "./deps.ts";
import type { Missions } from "./missions.ts";
import { limitReached, limitsNear, retryAfter, stepsDone } from "./decide.ts";
import { MISSION_GATEWAY_ID } from "./gateway.ts";
import { FOLLOW_UP_MS, KEEP_MS, KEEP_WHEN_DISK_LOW_MS, LIMIT_WAIT_MS, PROGRESS_EVERY_MS, STALL_AFTER_MS } from "./limits.ts";
import { buttonsFor } from "./actions.ts";
import { followUpNotice, progressNotice } from "./notices.ts";
import type { Mission } from "./types.ts";

const log = createLogger("missions.timers");

/** How often a running mission's limits are read for what its CLI says (`spent`): seconds of a CLI's work, not a minute's. */
const SPENT_CHECK_MS = 5_000;

/** How long a CLI turn that said done, ask or fail has to end before a limit stops it like any other. */
const CLAIM_GRACE_MS = 10 * 60_000;

/** How often ended missions' folders are looked at, and how far back: a box down a month has missed its sweeps. */
const SWEEP_EVERY_MS = 60 * 60_000;
const SWEEP_BACK_MS = 30 * 24 * 60 * 60_000;

export class MissionTimers {
  private sweptAt = 0;
  /** Folders this process has removed — the window is looked at again each hour. */
  private readonly removed = new Set<string>();
  /** When each running mission's limits were last read for what its CLI said (`spent`). */
  private readonly spentChecked = new Map<string, number>();

  constructor(
    private readonly missions: Missions,
    private readonly deps: MissionsDeps,
  ) {}

  /** Folders it remembers removing, and missions whose limits it read for what their CLI said — `Missions.tables`. */
  entries(): number {
    return this.removed.size + this.spentChecked.size;
  }

  tick(now: number): void {
    for (const mission of this.deps.store.open()) {
      if (mission.status === "running") this.running(mission, now);
      else if (mission.status === "waiting") this.waiting(mission, now);
    }
    this.missions.schedule();
    this.sweep(now);
  }

  /**
   * An ended mission's folder, a week on, removed — only the folder the daemon made for it under its agent's own: one a
   * person named (`workdir`) is theirs, and never touched. With the disk low, an hour on, oldest first; still never over
   * work nobody committed.
   */
  private sweep(now: number): void {
    if (now - this.sweptAt < SWEEP_EVERY_MS || !this.deps.remove) return;
    this.sweptAt = now;
    const freeMb = this.deps.diskLow?.() ?? null;
    const keep = freeMb === null ? KEEP_MS : KEEP_WHEN_DISK_LOW_MS;
    const window = this.deps.store.endedBetween(now - KEEP_MS - SWEEP_BACK_MS, now - keep);
    // One that has left the window is never looked at again: kept, its id was one more for every mission that ended.
    const inWindow = new Set(window.map((mission) => mission.id));
    for (const id of this.removed) if (!inWindow.has(id)) this.removed.delete(id);
    for (const mission of window) {
      const own = ownFolderOf(this.deps.agents.privateDir(mission.agentId), mission.id);
      if (this.removed.has(mission.id) || !inOwnFolder(mission.workdir, own)) continue;
      this.removed.add(mission.id);
      void this.deps.remove(mission, { keepUnsaved: true }).then(
        (unsaved) =>
          unsaved.length > 0
            ? log.warn("an ended mission's folder kept: work in it was never committed", { mission: mission.id, worktrees: unsaved })
            : freeMb !== null && (mission.endedAt ?? now) > now - KEEP_MS
              ? log.info("an ended mission's folder removed early: the disk is low", { mission: mission.id, free_mb: freeMb })
              : log.info("an ended mission's folder removed", { mission: mission.id }),
        (err: unknown) => log.warn("an ended mission's folder could not be removed", { mission: mission.id, error: String(err) }),
      );
    }
  }

  /**
   * Its coding CLI said what its context holds, inside its turn: its limits read now rather than at the minute's check —
   * at most every few seconds, the CLI saying it several times a model call.
   */
  spent(id: string, now: number): void {
    if (now - (this.spentChecked.get(id) ?? 0) < SPENT_CHECK_MS) return;
    this.spentChecked.set(id, now);
    const mission = this.deps.store.get(id);
    if (mission?.status === "running") this.stopAtLimit(mission, now);
  }

  /** A mission that ended: nothing kept for it. */
  forget(id: string): void {
    this.spentChecked.delete(id);
  }

  /**
   * A running mission past a limit, between turns or inside a coding CLI's turn, stopped and waiting on it — true where it
   * was. The minute's check, and as a CLI says what its context holds (`spent`): one minute of Claude Code on the
   * live box spent 1M tokens, so a limit checked once a minute went a whole minute past it.
   */
  stopAtLimit(mission: Mission, now: number): boolean {
    const busy = this.missions.inFlight(mission);
    // Not a turn that has just said done, ask or fail: it is ending, and stopped, what it said is lost. One
    // that said it a while ago and works on is stopped like any other.
    const claimedAt = this.missions.claimedAt(mission.id);
    const ending = claimedAt !== null && now - claimedAt < CLAIM_GRACE_MS;
    const cliTurn = busy && this.deps.runsOnCli?.(mission.agentId) === true && !ending;
    if (busy && !cliTurn) return false;
    // With what is not counted yet (0.8.8): its helpers' tokens since the last count, and the CLI turn's own so far,
    // estimated — counted only at its end, a turn of hours went past its token limit unseen (msn_3d28e0).
    const unsettled = this.missions.unsettled(mission);
    const inForce = this.missions.inForce(mission);
    const reached = limitReached(mission, now, inForce, unsettled);
    if (!reached) return false;
    log.info(cliTurn ? "a coding CLI's mission turn stopped at a limit" : "a mission reached a limit between turns", { mission: mission.id, limit: reached, ...(unsettled.running > 0 ? { estimated: unsettled.running } : {}) });
    if (cliTurn) this.deps.stopTurn(mission);
    this.missions.limitHit(mission, reached, limitsNear(mission, now, inForce, unsettled));
    return true;
  }

  private running(mission: Mission, now: number): void {
    const busy = this.missions.inFlight(mission);
    // A job of its own, or a mission it handed out: quiet while it waits for one is not stalled.
    const jobs = this.missions.awaits(mission);
    /**
     * Past its hours while a job held it: the turn that would have noticed has not come. And past them inside a coding
     * CLI's turn (0.8.8): a CLI mission works in one or two long turns — msn_53b16d ran 1h03m in 2 — so a limit checked
     * between turns stopped nothing. Its turn is stopped, which asks the CLI to cancel (`session/cancel`), and the
     * mission waits on the limit; the turn's end, cut short, leaves it waiting. Its tokens too, by what the CLI said of
     * its context while it worked (`PromptSpend`): ACP says what a prompt spent only when it ends, and that is counted
     * at the turn's end, in place of the estimate.
     */
    if (this.stopAtLimit(mission, now)) return;
    this.progress(mission, now);
    if (busy || jobs) return;
    const quietSince = Math.max(mission.updatedAt, mission.nudgedAt ?? 0);
    if (now - quietSince < STALL_AFTER_MS) return;
    if (mission.nudgedAt === null) {
      log.info("a mission has gone quiet, so it was nudged", { mission: mission.id });
      mission.nudgedAt = now;
      this.deps.store.save(mission);
      this.missions.queueTurn(mission, "nothing has happened in this mission for an hour. Carry on with the next step; if it cannot move, ask or fail.");
      return;
    }
    this.missions.wait(mission, "stuck", "it went quiet: no turn, job or activity for two hours, a nudge included");
  }

  private waiting(mission: Mission, now: number): void {
    const since = mission.waitingSince ?? mission.updatedAt;
    // Paused for its model (0.8.7): tried again by itself when its time comes — no follow-up, nobody was asked.
    if (mission.waitKind === "retry") {
      if (now - since >= retryAfter(this.missions.retryAttempt(mission.id))) this.missions.retryNow(mission);
      return;
    }
    if (mission.waitKind === "limit" && now - since >= LIMIT_WAIT_MS) {
      this.missions.end(mission, "failed", `${mission.reason ?? "a limit"} was reached and nobody continued it in 7 days`);
      return;
    }
    // Parked approvals that expired unanswered: nothing is left to wait for, and the mission is told so. Not ones a person
    // answered — none parked read as all expired, and a check between a yes and the turn it queues said "refused".
    const answered = (this.deps.settled?.(mission, since) ?? []).some((status) => status === "approved" || status === "denied");
    if (mission.waitKind === "approval" && !answered && this.deps.parked(mission).length === 0) {
      mission.status = "running";
      mission.waitedMs += Math.max(0, now - since);
      mission.waitingSince = null;
      mission.waitKind = null;
      mission.reason = null;
      mission.updatedAt = now;
      this.deps.store.save(mission);
      this.deps.changed?.(mission);
      this.missions.queueTurn(mission, "the approvals it parked were not answered in time and are refused. Do what can be done without them, or fail with what is left.");
      return;
    }
    if (mission.followedUpAt === null && now - since >= FOLLOW_UP_MS) {
      mission.followedUpAt = now;
      this.deps.store.save(mission);
      // An accept's wait holds no reason of its own since its result left the notice for `report.md` (0.8.11).
      void this.deps.tell(mission, followUpNotice(mission, mission.reason || (mission.waitKind === "accept" ? "your accept of its result" : "an answer")), buttonsFor(mission));
    }
  }

  /** A progress line — from the checklist, by the daemon, so it costs no tokens and claims only what the list shows. */
  private progress(mission: Mission, now: number): void {
    const plan = this.deps.notes?.plan({ agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id });
    if (!plan || plan.steps.length === 0) return;
    const done = stepsDone(plan);
    if (done <= mission.progressDone) return;
    const last = mission.progressAt ?? mission.startedAt ?? now;
    if (now - last < PROGRESS_EVERY_MS) return;
    mission.progressAt = now;
    mission.progressDone = done;
    this.deps.store.save(mission);
    void (this.deps.progress ?? this.deps.tell)(mission, progressNotice(mission, plan));
  }
}
