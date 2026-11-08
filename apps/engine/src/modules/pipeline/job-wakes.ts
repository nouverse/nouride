/**
 * Waking an agent about its own background job — when the job ends, and while it is quiet.
 *
 * Lifted out of the pipeline's composition root when there came to be two reasons to do it. Both are
 * the same event travelling the same road: into the job's chat as a message from the daemon, after the
 * agent's current turn there, with the log tail masked the way a tool result is. Two copies of that
 * road would drift; the first one already carries two bugs' worth of reasons it looks the way it does.
 *
 * The sender is the daemon, not a person, so it bypasses `admit` — the job was started by an
 * already-authorized turn, and making the runtime pair with itself would be nonsense. It still goes
 * through the queue, so per-chat ordering, the rate limit and dedup apply without a second code path.
 */

import type { KeyedQueue } from "@nouride/queue";
import { createLogger, newId, type MessageEnvelope } from "@nouride/shared";
import type { JobCompletion, JobRecord } from "@/modules/jobs/jobs.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import { jobFailureNotice, jobReportRequirement, jobWakeMessage } from "@/modules/jobs/wake-text.ts";
import { helperFailureNotice, helperReportRequirement, helperWakeMessage } from "@/modules/jobs/helper-wake-text.ts";
import { askFailureNotice, askReportRequirement, askWakeMessage } from "@/modules/jobs/ask-wake-text.ts";
import { maskSecrets } from "@nouride/secrets";
import type { TurnCause } from "@nouride/wire";
import { execHint } from "@/modules/tools/builtins/exec-hints.ts";
import type { Admission } from "./admission.ts";
import type { ChatTypes } from "./chat-types.ts";
import { SYSTEM_SENDER, type PipelineDeps } from "./deps.ts";
import type { TurnContext } from "./turn-context.ts";

const log = createLogger("pipeline");

export interface JobWakesDeps {
  deps: PipelineDeps;
  queue: KeyedQueue<MessageEnvelope>;
  admission: Admission;
  chatTypes: ChatTypes;
  turnContext: TurnContext;
  /** The pipeline's own set, so `idle()` and `drain()` wait for a wake still waiting on a turn. */
  pending: Set<Promise<void>>;
}

/** Why the daemon pushed this envelope, when it did — what its turn is headed with (`TurnCause`). */
export function wakeCause(envelope: MessageEnvelope): TurnCause | undefined {
  if (envelope.senderId !== SYSTEM_SENDER) return undefined;
  const raw = envelope.raw as { via?: unknown; job?: unknown; outcome?: unknown; helper?: unknown; asked?: unknown } | null | undefined;
  if (typeof raw?.via !== "string") return undefined;
  const outcome = OUTCOMES.find((known) => known === raw.outcome);
  return {
    via: raw.via,
    ...(typeof raw.job === "string" ? { job: raw.job } : {}),
    ...(outcome ? { outcome } : {}),
    ...(raw.helper === true ? { helper: true } : {}),
    ...(typeof raw.asked === "string" ? { asked: raw.asked } : {}),
  };
}

const OUTCOMES = ["finished", "failed", "stopped", "interrupted"] as const satisfies readonly NonNullable<TurnCause["outcome"]>[];

/** How a job ended, in the words its turn is headed by: a deadline's stop is a stop, whatever the row says. */
function outcomeOf(completion: JobCompletion): NonNullable<TurnCause["outcome"]> {
  if (completion.stop) return "stopped";
  return completion.job.status === "succeeded" ? "finished" : completion.job.status === "killed" ? "stopped" : completion.job.status === "interrupted" ? "interrupted" : "failed";
}

/** The job a queued envelope reports the end of, when it is that — what `jobs.woke_at` records. */
export function jobOfCompletionWake(envelope: MessageEnvelope): string | null {
  const raw = envelope.raw as { via?: unknown; job?: unknown } | null | undefined;
  return raw?.via === "job completion" && typeof raw.job === "string" ? raw.job : null;
}

export class JobWakes {
  constructor(private readonly o: JobWakesDeps) {}

  /** A job ended: its result, and a failure said by the daemon itself when the model might not. */
  completion(raw: JobCompletion): void {
    const { job } = raw;
    // Its text addresses the agent it wakes (`@name`) — the one that asked, for an asked agent's job: addressing the
    // job's own agent there ran it too, from the same message (0.7.17's live test of #10).
    const to = reportsTo(job, this.o.deps.turns);
    const completion = { ...raw, tail: this.mask(job, raw.tail), ...(to !== job.agentId ? { job: { ...job, agentId: to } } : {}) };
    this.enqueue(job, "job completion", outcomeOf(completion), () => this.said(completion));
  }

  /**
   * The wake-up's words, by what ended. Each counts one wake-up of the chain with no person in it (`noteJobWake`), once:
   * a command's exit code and log; a helper's handoff, in its own words (`helper-wake-text.ts`); and the answer an
   * asked agent sends back from the background, with what it answers (`ask-wake-text.ts`, 0.7.19).
   */
  private said(completion: JobCompletion): Pick<MessageEnvelope, "text" | "owedReport" | "announce"> {
    const { job } = completion;
    const chain = this.o.admission.noteJobWake(job.gatewayId, job.chatId);
    if (job.kind === "ask") {
      const text = askWakeMessage(completion, { chain, timeZone: this.o.deps.config.daemon.timezone, now: Date.now() });
      const notice = askFailureNotice(completion);
      return wake(this.mask(job, text), askReportRequirement(completion), notice ? this.mask(job, notice) : null);
    }
    if (job.kind === "helper") return wake(helperWakeMessage(completion, chain), helperReportRequirement(completion), helperFailureNotice(completion));
    // The same one line a failed foreground command gets (`exec-hints.ts`): an `npm i -g` or a
    // `pip install` that hit a wall in the background is exactly where the hint is needed.
    const hint = job.status === "killed" ? null : execHint(completion.tail ?? "", job.exitCode ?? null);
    return wake(`${jobWakeMessage(completion, chain)}${hint ? `\n\n${hint}` : ""}`, jobReportRequirement(completion), jobFailureNotice(completion));
  }

  /**
   * A job still running with nothing new in its log (`JobWatchdog`): the agent says it is still going.
   *
   * Not counted by `noteJobWake`. That count bounds how many *results* one chat is told about in a row;
   * a notice is not a result, and counting it would let a long quiet build use up the budget its own
   * completion needs.
   */
  quiet(job: JobRecord, text: string): void {
    this.enqueue(job, "job quiet", undefined, () => ({ text: this.mask(job, text) }));
  }

  /**
   * The log tail goes into a prompt, so it is masked like a tool result. So does an asked agent's answer (0.7.19) — of
   * the asked agent's credentials and the daemon's own too, as the tool result it was before an ask could move would
   * have been.
   */
  private mask(job: JobRecord, text: string): string {
    const env = job.ask
      ? { ...this.o.deps.childEnv?.(job.agentId), ...this.o.deps.childEnv?.(job.ask.agent), ...this.o.deps.ownSecrets?.() }
      : this.o.deps.childEnv?.(job.agentId);
    return env ? maskSecrets(text, env) : text;
  }

  /**
   * Into the job's chat once the agent is free there.
   *
   * A background job is started by a turn, and that turn is still wrapping up when the job completes
   * — often in under a second, always before the turn has released its key. In a DM this is harmless:
   * the queue's `maxConcurrentPerKey` is 1, so the wake-up envelope waits behind the running turn and
   * is processed once it finishes.
   *
   * In a room the concurrency limit is relaxed (several agents run at once, by design), so the queue
   * lets the wake-up handler start immediately. The `isBusy` guard in `admit()` then sees the agent
   * still working and drops the envelope — silently, permanently. Every background job started from a
   * Discord channel hit this: the log showed `background job finished` followed by `that agent is
   * already working in this chat`, and the agent never reported the result.
   *
   * Waiting here — before the push, not inside the queue — means the envelope enters the queue only
   * after `activeTurns` no longer contains this agent, so `isBusy` passes regardless of chat type.
   * Resolves immediately when the agent is already free (a long-running job that outlasted its turn).
   */
  private enqueue(
    job: JobRecord,
    via: string,
    outcome: TurnCause["outcome"],
    body: () => Pick<MessageEnvelope, "text" | "owedReport" | "announce">,
  ): void {
    const gateway = this.o.deps.gateways.get(job.gatewayId);
    if (!gateway) {
      log.warn("a job needs its agent but its gateway is gone", { job: job.id, gateway_id: job.gatewayId, via });
      return;
    }
    // Who is woken: the job's agent — or, for a job an agent started while another asked it something, the one that
    // asked (`reportsTo`). The text says whose job it was.
    const to = reportsTo(job, this.o.deps.turns);
    const push = () => {
      const made = body();
      this.o.queue.push({
        id: newId("msg"),
        timestamp: Date.now(),
        gateway: gateway.platform,
        gatewayId: job.gatewayId,
        chatId: job.chatId,
        chatType: this.o.chatTypes.of(job.gatewayId, job.chatId) ?? "dm",
        senderId: SYSTEM_SENDER,
        senderName: "Nouride",
        mentions: [to],
        ...made,
        ...(to !== job.agentId ? { text: `${askedJobNote(job.agentId)}\n\n${made.text}` } : {}),
        raw: { via, job: job.id, ...(outcome ? { outcome } : {}), ...(job.kind === "helper" ? { helper: true } : {}), ...(job.ask ? { asked: job.ask.agent } : {}) },
      });
    };
    const wake = this.o.turnContext.waitUntilFree(to, job.chatId, job.gatewayId).then(push);
    this.o.pending.add(wake);
    void wake.then(() => this.o.pending.delete(wake));
  }
}

/** A wake-up's text, with what its reply owes and the line the daemon posts first — each only when there is one. */
function wake(text: string, owedReport: string | null, announce: string | null): Pick<MessageEnvelope, "text" | "owedReport" | "announce"> {
  return { text, ...(owedReport ? { owedReport } : {}), ...(announce ? { announce } : {}) };
}

/**
 * The agent a job's end goes to (0.7.17, nouride-releases#10).
 *
 * Its own agent, except for a job started by an agent another one asked through `ask_agent`. That agent runs inside the
 * asking agent's turn, in its chat, and answers it rather than the person — so waking it there gave it a turn of its
 * own in a conversation that is not its: a session on the asking agent's bot, a reply through it, 43 in one day on
 * one install. The turn the job was started in belongs to the agent that asked, and that agent is told instead, and
 * reports it in its own words. A job with no turn, or one whose turn is gone, wakes its own agent as before.
 */
function reportsTo(job: Pick<JobRecord, "agentId" | "turnId">, turns: Pick<TurnsPort, "get"> | undefined): string {
  if (!job.turnId || !turns) return job.agentId;
  return turns.get(job.turnId)?.agentId ?? job.agentId;
}

/** What the agent that asked is told about a job that is not its own. */
function askedJobNote(by: string): string {
  return [
    `[This job was started by ${by}, which you asked with ask_agent. ${by} is not in this conversation: you are, so`,
    `report its result to the person yourself. To stop or follow it, ask ${by}.]`,
  ].join(" ");
}
