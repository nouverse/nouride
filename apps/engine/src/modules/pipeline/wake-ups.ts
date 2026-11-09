/**
 * What the daemon itself puts into a chat's queue — the part of the pipeline the jobs, the external agents' CLIs, the
 * approval gate, a restart and the missions reach: a finished job and a quiet one, what a CLI said by itself, a late
 * answer to an approval, a turn a restart or its provider cut off, and a mission's turn.
 *
 * Each goes through the queue rather than starting a turn: the conversation may be busy, and a wake-up that jumped
 * the queue would interleave with a turn already running on the same history. The per-chat ordering, rate limit and
 * dedup all apply without a second code path.
 */

import { createLogger, type ApprovalDecision, type ApprovalRequest, type MessageEnvelope } from "@nouride/shared";
import type { JobCompletion, JobRecord } from "@/modules/jobs/jobs.store.ts";
import type { TurnRecord } from "@/modules/turns/turns.store.ts";
import { JobWakes, type JobWakesDeps } from "./job-wakes.ts";
import { cliStoppedEnvelope, ownWordsEnvelope } from "./own-words-wake.ts";
import { approvalResumeEnvelope } from "./approval-resume.ts";
import { restartResumeEnvelope, type Cut, type ResumeWhy } from "./restart-resume.ts";

const log = createLogger("pipeline");

/** A chat an external agent's CLI spoke in, or had a command running in. */
type CliChat = { agentId: string; gatewayId: string; chatId: string };

export class WakeUps {
  /** Wake-ups waiting for a turn to finish before they are pushed — the pipeline's `idle()` and `drain()` wait for them. */
  readonly pending = new Set<Promise<void>>();
  private readonly jobs: JobWakes;

  constructor(private readonly o: Omit<JobWakesDeps, "pending">) {
    this.jobs = new JobWakes({ ...o, pending: this.pending });
  }

  /**
   * A finished background job re-enters the pipeline as a message.
   *
   * The sender is the daemon, not a person, so it bypasses `admit` — the job was started by an
   * already-authorized turn, and making the runtime pair with itself would be nonsense.
   */
  wakeForJob(raw: JobCompletion): void {
    this.jobs.completion(raw);
  }

  /** A running job that has gone quiet — see `JobWatchdog` and `JobWakes.quiet`. */
  wakeForQuietJob(job: JobRecord, text: string): void {
    this.jobs.quiet(job, text);
  }

  /** A turn of a conversation that is not a chat's — a mission's (`modules/missions/`), into the same queue. */
  queueTurn(envelope: MessageEnvelope): boolean {
    return this.o.queue.push(envelope);
  }

  /** An external agent's CLI said something by itself, between turns: a turn in its chat reads it (`own-words-wake.ts`). */
  wakeForOwnWords(chat: CliChat, made = ownWordsEnvelope): void {
    const gateway = this.o.deps.gateways.get(chat.gatewayId);
    if (!gateway) return;
    const push = () => void this.o.queue.push(made(chat, gateway.platform, this.o.chatTypes.of(chat.gatewayId, chat.chatId) ?? "dm"));
    const wake = this.o.turnContext.waitUntilFree(chat.agentId, chat.chatId, chat.gatewayId).then(push);
    this.pending.add(wake);
    void wake.then(() => this.pending.delete(wake));
  }

  /** A command an external agent's CLI had left running, which the last process was stopped with: its chat is told. */
  wakeForCliStopped(chat: CliChat): void {
    this.wakeForOwnWords(chat, cliStoppedEnvelope);
  }

  /**
   * Put an agent back on a job after a human answered late.
   *
   * The turn that asked stopped waiting on purpose — it holds back a slice of its deadline so the
   * model can report and carry on instead of dying mid-call — but the question stayed open. When it
   * is finally answered there is no promise left to release, so the answer only means something if
   * somebody starts a new turn with it.
   *
   * Sent as a system event into the same conversation. That matters twice: an empty reply from a
   * system event sends nothing, so an agent with nothing to add stays quiet; and the queue keeps it
   * behind whatever that conversation is already doing rather than running two turns at once.
   *
   * The command is restated rather than replayed. Nothing here can resume a tool call from a turn
   * that has ended — the arguments, the working directory and the model's own plan are gone — so the
   * honest move is to hand the agent back the facts and let it decide.
   */
  resumeAfterApproval(request: ApprovalRequest, decision: ApprovalDecision, by: string): boolean {
    const gateway = this.o.deps.gateways.get(request.gateway);
    if (!gateway) {
      log.warn("cannot resume after a late approval: the gateway is gone", { approval: request.id, gateway_id: request.gateway });
      return false;
    }
    const chatType = this.o.chatTypes.of(request.gateway, request.chatId) ?? "dm";
    if (!this.o.queue.push(approvalResumeEnvelope(request, decision, by, gateway.platform, chatType))) {
      log.warn("a late approval could not be handed back to the agent", { approval: request.id });
      return false;
    }
    log.info("resuming after a late approval", { approval: request.id, decision, actor: by });
    return true;
  }

  /**
   * A turn a restart or its provider cut off, taken up again — `restart-resume.ts`, `provider-resume.ts`. `waiting`: the
   * approvals it was cut off waiting on, which the restart kept.
   */
  resumeTurn(turn: Pick<TurnRecord, "id" | "agentId" | "gatewayId" | "chatId" | "prompt">, why: ResumeWhy = "restart", waiting: readonly ApprovalRequest[] = [], cut?: Cut): boolean {
    const gateway = this.o.deps.gateways.get(turn.gatewayId);
    if (!gateway) return false;
    return this.o.queue.push(restartResumeEnvelope(turn, gateway.platform, this.o.chatTypes.of(turn.gatewayId, turn.chatId) ?? "dm", why, waiting, cut));
  }
}
