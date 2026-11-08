/**
 * A delegate's own turn record (0.7.26): a helper `delegate` started in the background, or an agent `ask_agent` asked
 * once its turn moved there — written through the turn store a chat turn is, so `nouride turns show` and the dashboard
 * read it like one: its steps and tool calls, the nudges it read, the report it handed back.
 *
 * On 2026-10-20/21 whether a nudge reached a delegate could not be read. Its steps were lines of its job's log and
 * nothing else: the turn that started it had ended, so they could not be that turn's rows.
 *
 * What stays where it was: its model calls and its tool calls' audit rows are counted in the turn that asked (D2), and
 * its job's log still has every step — what is left of it when a restart cuts it off. The two point at each other: the
 * record's cause names the job and the turn that asked (`job`, `parent`); the log's first line names the record.
 *
 * In the chat's stream, under its conversation, so whoever may follow the chat sees it — and its start says whose it
 * is (`turn.via`, `turn.by`, stream 1.4). But not a turn of the conversation: the transcript, the live view, memory and
 * a restart's resume leave it out (`OWN` in `turns/turns.store.ts`).
 */

import type { TurnStatus } from "@nouride/wire";
import type { ActivityKind } from "@/commons/activity.ts";
import type { HelperOutcome, RunningHelper } from "@/modules/jobs/helper-jobs.ts";
import type { TurnResult } from "@/modules/llm/executor/types.ts";
import type { ContextLine } from "@/modules/llm/executor/context-line.ts";
import { TurnRecorder } from "@/modules/turns/recorder.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";

export interface DelegatedStart {
  via: "delegate" | "ask_agent";
  /** Whose turn it is: the parent's for a helper, which runs as it; the agent asked, for `ask_agent`. */
  by: string;
  job: RunningHelper;
  /** The turn whose call started it — where its model calls and audit rows are counted. */
  parent?: string;
  /** Its own conversation, a child of the asking one (`childSessionId`), never persisted as a session. */
  sessionId: string;
  gatewayId: string;
  chatId: string;
  senderId?: string;
  /** What it was given: a helper's brief, an ask's task. */
  prompt: string;
}

/** How its run ended, as its runner knows it. */
export interface DelegatedEnd {
  /** The executor's result, when the run got one. */
  result?: Pick<TurnResult, "toolCalls" | "iterations" | "usage">;
  model?: string;
  /** Stopped by a stop — `/stop`, `nouride jobs kill`, its clock — rather than ended by itself. */
  stopped?: boolean;
}

export interface DelegatedTurn {
  readonly id: string;
  step(kind: ActivityKind, text: string, detail?: Record<string, unknown>): void;
  /** What one of its model requests carried — its own turn's line, unmarked, as a chat turn's is. */
  context(line: ContextLine): void;
  finish(outcome: HelperOutcome, end?: DelegatedEnd): void;
}

/** Start one, and name it in the job's log. Undefined where nothing records turns, or the record could not be begun. */
export function beginDelegated(turns: TurnsPort | undefined, start: DelegatedStart): DelegatedTurn | undefined {
  const record = TurnRecorder.begin(turns, {
    sessionId: start.sessionId,
    agentId: start.by,
    gatewayId: start.gatewayId,
    chatId: start.chatId,
    ...(start.senderId ? { senderId: start.senderId } : {}),
    prompt: start.prompt,
    cause: { via: start.via, job: start.job.id, ...(start.parent ? { parent: start.parent } : {}) },
  });
  if (!record) return undefined;
  start.job.log(`· its turn is ${record.id}: \`nouride turns show ${record.id}\``);
  return {
    id: record.id,
    step: (kind, text, detail) => {
      // A call's audit row is the asking turn's, where `audit_log` keeps it (D2) — the step goes without it.
      const { audit: _audit, ...rest } = detail ?? {};
      record.step(kind, text, rest);
    },
    context: (line) => record.context(line),
    finish: (outcome, end = {}) => {
      const { report } = outcome;
      // How it handed back, said as its last step: `success` and its reason, or why it is short of one.
      record.step("note", `handed back ${report.status}${report.reason ? ` (${report.reason})` : ""}`);
      const status: Exclude<TurnStatus, "running"> = outcome.paused ? "interrupted" : report.status === "failed" ? "failed" : end.stopped ? "cancelled" : "done";
      record.finish({
        status,
        reply: report.summary,
        ...(status !== "done" && report.reason ? { error: report.reason } : {}),
        ...(end.model ? { model: end.model } : {}),
        toolCalls: end.result?.toolCalls ?? report.metrics.toolCalls,
        ...(end.result ? { iterations: end.result.iterations, inputTokens: end.result.usage.inputTokens, outputTokens: end.result.usage.outputTokens } : {}),
      });
    },
  };
}
