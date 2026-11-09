/**
 * Restarting the daemon on request — one path for every way of asking.
 *
 * The dashboard's button, `nouride restart`, `/restart` in a chat and an agent's `nouride restart --then`
 * all come here, so they wait the same way and come back the same way. `nouride update` already did both
 * (`self-update.ts`): it waits for the daemon to go idle before ending the process, and the turn that
 * reports back is written before anything happens and armed as the process ends.
 *
 * A restart did neither. It ended the process 50 ms after being asked, cutting a running turn and any
 * background job in half, and its wake-up was a cron row counted from the request rather than from the
 * restart. With no supervisor the restart was refused — and the wake-up, created before the refusal,
 * still fired ten seconds later into a daemon that had never gone down.
 */

import { createLogger } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import { describeJobs, restartWhenIdle, type RestartPacing, type WorkingJob } from "./self-update.ts";

const log = createLogger("daemon");

/** After the restart, when the follow-up fires: long enough for the gateways to be listening again. */
const FOLLOW_UP_SECONDS = 10;

/**
 * Where a follow-up waits until the process actually ends — `FALLBACK_SECONDS` in `self-update.ts`, for
 * the same reason. It has to exist before the restart, and a live row can fire: counted from the request,
 * a restart that waited for a long turn would be reported before it happened.
 */
const PARKED_SECONDS = 900;

/** Who hears about it once the daemon is back, and where. */
export type RestartFollowUp =
  /** `--then`: a turn for the agent that asked, which checks what it asked for and says so. */
  | { kind: "turn"; agentId: string; gatewayId: string; chatId: string; message: string; delaySeconds?: number }
  /** `/restart` in a chat: a line from the daemon. No model call, so it arrives when the model is the reason. */
  | { kind: "notice"; agentId: string; gatewayId: string; chatId: string; text: string };

export interface RestartRequest {
  /** Who asked, for the audit log: a dashboard user, a control token, or `<gateway>:<sender>`. */
  by: string;
  /** Restart now, whatever is running. */
  now?: boolean;
  /** Even though nothing will start the daemon again — a stop, said on purpose. */
  force?: boolean;
  followUp?: RestartFollowUp;
}

export type RestartOutcome =
  /** `waitingFor`: the background jobs it waits for, however long they take — `describeJobs`. */
  | { ok: true; supervisor: string; waiting: boolean; note: string; followUpSeconds?: number; waitingFor?: string }
  /**
   * `why` it was refused, for the dashboard's words at its route (0.8.20): nothing would start it again, or its follow-up
   * could not be scheduled. `error` and `note` stay the CLI's and the chat's.
   */
  | { ok: false; error: string; supervisor: string; note?: string; why: "no-restarter" | "follow-up" };

export interface DaemonRestartDeps {
  /** Ends the process for the supervisor to start again — `boot/restart.ts`. */
  requestRestart: (reason: string) => void;
  supervisor: () => { kind: string; restartsOnExit: boolean };
  /** Whether a turn, a queued message or a background job is in progress — `busyWith`. */
  busy: () => boolean;
  /** Background jobs at work, waited for however long they take — `workingJobs`. */
  jobs?: () => WorkingJob[];
  /** For follow-ups. Absent when the scheduler is off, and then a request that wants one is refused. */
  cron?: Pick<CronPort, "create" | "update">;
  audit?: Pick<AuditPort, "record">;
  pacing?: RestartPacing;
}

export class DaemonRestart {
  /** The restart already asked for: the follow-ups to arm as the process ends, and whether to stop waiting. */
  private pending: { followUps: { id: string; seconds: number }[]; now: boolean } | null = null;

  constructor(private readonly deps: DaemonRestartDeps) {}

  /** Whether a restart has been asked for and the process has not ended yet. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /**
   * Ask for one. Answers at once; the process ends once nothing is running — a turn for ten minutes at most, a
   * background job however long it takes — or, with `now`, on the next tick, which still lets the answer to
   * whoever asked leave first. An approval waiting for a person does not hold it: it is kept and asked again.
   *
   * A second request joins the first rather than starting another wait: its follow-up is armed with the
   * first one's, and its `now` ends the wait for both.
   */
  request(request: RestartRequest): RestartOutcome {
    const supervisor = this.deps.supervisor();
    // "Restart" that means "stop forever" is the worst kind of wrong: the operator expects a blip, walks
    // away, and the agent is gone until they notice. `force` is for the case where they meant exactly that.
    if (!supervisor.restartsOnExit && !request.force) {
      return {
        ok: false,
        error: "nothing would restart this daemon",
        why: "no-restarter",
        supervisor: supervisor.kind,
        note:
          supervisor.kind === "docker"
            ? "inside a container: use `docker restart <container>` so the platform's restart policy applies"
            : "install a service with `nouride service install`, or pass --force to stop it anyway",
      };
    }
    if (request.followUp && !this.deps.cron) {
      return { ok: false, error: "the scheduler is off, so nobody could be told when it is back", why: "follow-up", supervisor: supervisor.kind };
    }

    let followUp: { id: string; seconds: number } | undefined;
    try {
      followUp = request.followUp ? this.park(request.followUp) : undefined;
    } catch (err) {
      // Before anything has happened: a restart with no way back is worse than one that did not happen.
      return { ok: false, error: `could not schedule the follow-up: ${err instanceof Error ? err.message : String(err)}`, why: "follow-up", supervisor: supervisor.kind };
    }

    this.deps.audit?.record({
      action: "daemon_restart",
      actor: request.by,
      ...(request.followUp ? { agentId: request.followUp.agentId, gatewayId: request.followUp.gatewayId, chatId: request.followUp.chatId } : {}),
      details: { now: request.now === true, ...(request.force ? { force: true } : {}), ...(request.followUp ? { follow_up: request.followUp.kind } : {}) },
    });

    const joined = this.pending !== null;
    const pending = this.pending ?? this.start();
    if (followUp) pending.followUps.push(followUp);
    if (request.now) pending.now = true;

    const waiting = !pending.now && this.deps.busy();
    const jobs = pending.now ? [] : (this.deps.jobs?.() ?? []);
    const waitingFor = jobs.length > 0 ? describeJobs(jobs) : undefined;
    const back = supervisor.restartsOnExit ? `${supervisor.kind} is expected to start it again` : "nothing will start it again";
    const restarting = joined ? "a restart is already waiting" : "restarting";
    return {
      ok: true,
      supervisor: supervisor.kind,
      waiting,
      note: waitingFor
        ? `${restarting} once ${waitingFor} ${jobs.length === 1 ? "finishes" : "finish"}, however long that takes (ask again with now to stop ${jobs.length === 1 ? "it" : "them"}); ${back}`
        : waiting
          ? `${restarting} as soon as nothing is running, within ten minutes; ${back}`
          : `restarting now: ${back}`,
      ...(followUp ? { followUpSeconds: followUp.seconds } : {}),
      ...(waitingFor ? { waitingFor } : {}),
    };
  }

  private start(): NonNullable<DaemonRestart["pending"]> {
    const pending: NonNullable<DaemonRestart["pending"]> = { followUps: [], now: false };
    this.pending = pending;
    restartWhenIdle({
      busy: () => !pending.now && this.deps.busy(),
      jobs: () => (pending.now ? [] : (this.deps.jobs?.() ?? [])),
      restart: () => {
        this.arm(pending.followUps);
        this.deps.requestRestart("asked for");
      },
      ...this.deps.pacing,
    });
    return pending;
  }

  /** Written now and parked, so it exists whatever happens next; moved to its real time in `arm`. */
  private park(followUp: RestartFollowUp): { id: string; seconds: number } {
    const seconds = followUp.kind === "turn" ? (followUp.delaySeconds ?? FOLLOW_UP_SECONDS) : FOLLOW_UP_SECONDS;
    const job = this.deps.cron!.create({
      agentId: followUp.agentId,
      name: followUp.kind === "turn" ? "wake-up: restarting the daemon" : "restarted: tell the chat that asked",
      enabled: true,
      trigger: { kind: "at", at: Date.now() + PARKED_SECONDS * 1000 },
      payload: followUp.kind === "turn" ? { kind: "agentTurn", message: turnMessage(followUp.message) } : { kind: "systemEvent", text: followUp.text },
      target: { gatewayId: followUp.gatewayId, chatId: followUp.chatId },
      delivery: { mode: "announce" },
      // The conversation's own history, so a follow-up turn reads as a continuation of the one that asked.
      session: "chat",
      keepAfterRun: false,
      createdBy: "restart",
    });
    log.info("restart follow-up parked", { job: job.id, kind: followUp.kind });
    return { id: job.id, seconds };
  }

  /** As the process ends: each follow-up counted from now, which is when "after the restart" starts. */
  private arm(followUps: { id: string; seconds: number }[]): void {
    for (const { id, seconds } of followUps) {
      try {
        this.deps.cron?.update(id, { trigger: { kind: "at", at: Date.now() + seconds * 1000 } }, "restart");
      } catch (err) {
        // Still parked, so it fires late rather than never.
        log.warn("could not arm a restart follow-up, so it fires at its parked time instead", { job: id, error: String(err) });
      }
    }
  }
}

/** What the agent reads when it comes back — `followUpMessage` in `self-update.ts`, for a restart. */
function turnMessage(asked: string): string {
  return (
    `${asked}\n\n` +
    `(You scheduled this before restarting the daemon, and it has restarted since: this is a fresh turn. ` +
    `Check rather than assume, and say plainly if you cannot: a scheduled turn has no human behind it, so any ` +
    `tool that needs approval will be refused here.)`
  );
}
