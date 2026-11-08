/**
 * What one agent hands back to the agent that asked it — the return contract for delegated work.
 *
 * Here rather than beside the turn runner that fills it in, because the contract belongs to the tools
 * that carry it: `delegate` already owns `SubagentRequest`, and `pipeline/subagent.ts` imports it from
 * there. Pipeline imports tools everywhere in this engine and nothing imports the other way, so a
 * handoff type living in `pipeline/` would have been the one edge pointing back.
 *
 * `ask_agent` and `delegate` both used to hand back a bare string: whatever the worker's last message
 * happened to say. That is the whole result, and it is the wrong shape for two reasons.
 *
 * **It cannot be trusted about what happened.** A worker that hit a refused approval, ran out of tool
 * iterations, or died halfway still produces a final message, and that message reads like a report. The
 * coordinator then relays it to a person as though the work were done. Nothing in the string
 * distinguishes "I finished" from "I gave up", and the coordinator has no other source of truth.
 *
 * **It cannot be trusted about what it touched.** A worker that edited four files and mentioned two is
 * indistinguishable from one that edited two.
 *
 * So the envelope is **derived, not declared**. Everything a model could get wrong about itself comes
 * from what the harness watched it do: the status from how the turn actually ended, the file list from
 * the tool calls it actually made. The only field the worker authors is the summary — the one thing
 * only it knows.
 *
 * ## Why the numbers are in it
 *
 * The metrics line is not decoration. The failure it exists to make visible is a worker that grinds:
 * a specialist asked one question, answering with ninety-three small tool calls across thirty-two
 * model turns, filling its own context until the run aborts. From the coordinator's side that is
 * indistinguishable from a slow answer until it is too late. `5 tools · 3 steps · 17s` and
 * `93 tools · 32 steps · 420s` are different facts about whether to ask that agent again, and the
 * second one is worth seeing in the transcript.
 *
 * ## What is deliberately not in it
 *
 * `createdFiles` vs `modifiedState`, which the RFC that asked for this envelope split apart. Telling
 * them apart needs a stat before the write, and nothing here has one — so the distinction would be
 * invented, which is worse than one honest list (§4 of the contributing invariants).
 *
 * The summary is also **not truncated here**. A worker that writes four pages is a real problem, and
 * the fix for it already exists one level up: a tool result too large for the context is capped and
 * spilled to a file by the executor, which hands the coordinator a head, a tail and a path. Adding a
 * second, quieter cap in this file would drop text with no pointer to what was dropped.
 */

import { plural, type StopReason } from "@nouride/shared";
import { OUT_OF_ROUNDS, OUT_OF_TIME, SAME_ANSWER } from "@/modules/llm/executor/settle.ts";

/**
 * Tools whose calls mean "a file on disk is different now".
 *
 * Named rather than inferred from a flag, because there is no such flag and inventing one would put
 * the answer in twenty tool definitions instead of one list. `exec` is *not* here: a command can write
 * anything and we would be guessing at paths from a shell string.
 */
const FILE_WRITERS = new Set(["write", "edit", "multi_edit"]);

export type HandoffStatus =
  /** Ran to completion and produced an answer. */
  | "success"
  /** Stopped waiting for a person: an approval was refused, or expired unanswered. */
  | "requires_human"
  /** Ran out of room — the turn was aborted, or it hit a ceiling with work still to do. */
  | "incomplete"
  /** Did not run, or threw. */
  | "failed";

export interface SubAgentHandoff {
  /** The agent that did the work. Its own id, so the audit trail and the report agree. */
  agentId: string;
  status: HandoffStatus;
  /** The worker's own words. The only field it authors. */
  summary: string;
  /** Paths it wrote or edited, in the order first touched. Derived from its tool calls. */
  files: string[];
  /** Full outputs of its calls that were too large to keep inline, on disk. Derived, like `files`. */
  spills: string[];
  metrics: { toolCalls: number; steps: number; ms: number };
  /** Set when `failed`, or when a status needs a reason a person can act on. */
  reason?: string;
}

/** What `buildHandoff` needs from a finished turn. Structural, so a test can hand it a literal. */
export interface HandoffSource {
  agentId: string;
  startedAt: number;
  now?: number;
  /** Absent when the run never produced one — see `error`. */
  result?: {
    text: string;
    toolCalls: number;
    iterations: number;
    approvalsRefused: number;
    toolSteps: { name: string; ok: boolean; path?: string; spilledTo?: string }[];
    stopReason: StopReason;
    /** Why its last words were a wrap-up, when they were (`TurnResult.wrappedUp`). */
    wrappedUp?: string;
  };
  /** The run threw. Already shaped for a person by `toUserMessage` at the call site. */
  error?: string;
  /** The turn's signal fired — `/stop`, or the deadline. */
  aborted?: boolean;
}

export function buildHandoff(source: HandoffSource): SubAgentHandoff {
  const ms = Math.max(0, (source.now ?? Date.now()) - source.startedAt);

  if (!source.result) {
    return {
      agentId: source.agentId,
      status: "failed",
      summary: "",
      files: [],
      spills: [],
      metrics: { toolCalls: 0, steps: 0, ms },
      reason: source.error ?? "the run produced no result",
    };
  }

  const { text, toolCalls, iterations, approvalsRefused, toolSteps, stopReason, wrappedUp } = source.result;

  // First touched wins the ordering, and a file edited three times appears once.
  const files: string[] = [];
  for (const step of toolSteps) {
    if (!step.path || !FILE_WRITERS.has(step.name)) continue;
    if (!files.includes(step.path)) files.push(step.path);
  }
  const spills = toolSteps.flatMap((step) => (step.spilledTo ? [step.spilledTo] : []));

  const { status, reason } = classify({
    aborted: source.aborted === true,
    approvalsRefused,
    stopReason,
    ...(wrappedUp ? { wrappedUp } : {}),
    error: source.error,
    hasText: text.trim().length > 0,
  });

  return {
    agentId: source.agentId,
    status,
    summary: text.trim(),
    files,
    spills,
    metrics: { toolCalls, steps: iterations, ms },
    ...(reason ? { reason } : {}),
  };
}

/**
 * How the turn ended, in the order that matters.
 *
 * Ordered by what the coordinator has to do about it, most actionable first. A run that both threw
 * *and* had an approval refused is reported as failed, because that is the thing to say — and a run
 * that produced no text is only "incomplete" once every worse explanation has been ruled out.
 */
function classify(input: {
  aborted: boolean;
  approvalsRefused: number;
  stopReason: StopReason;
  wrappedUp?: string;
  error?: string;
  hasText: boolean;
}): { status: HandoffStatus; reason?: string } {
  if (input.error) return { status: "failed", reason: input.error };
  if (input.stopReason === "error") {
    return { status: "failed", reason: "the model call failed partway through" };
  }
  if (input.approvalsRefused > 0) {
    return {
      status: "requires_human",
      reason:
        input.approvalsRefused === 1
          ? "one tool call was not approved, so part of this was not done"
          : `${input.approvalsRefused} tool calls were not approved, so part of this was not done`,
    };
  }
  if (input.aborted) return { status: "incomplete", reason: "the turn was stopped before it finished" };
  if (input.stopReason === "max_tokens") {
    return { status: "incomplete", reason: "it ran out of output space mid-answer" };
  }
  /**
   * Out of rounds, or out of clock, and wrapped up: the wrap-up call ends the loop with `stop`, so the stop reason
   * alone read as finished — a helper cut off at its limit handed back `success` with a summary saying it was not.
   */
  if (input.stopReason === "tool_calls" || input.wrappedUp === OUT_OF_ROUNDS) {
    return { status: "incomplete", reason: "it reached its tool-call limit with work still to do" };
  }
  if (input.wrappedUp === OUT_OF_TIME) {
    return { status: "incomplete", reason: "it ran out of time with work still to do" };
  }
  // Live (0.8.12): a helper that kept re-reading the same pictures was ended here and handed back `success`, with a
  // summary that opened "Not finished".
  if (input.wrappedUp === SAME_ANSWER) {
    return { status: "incomplete", reason: "it kept getting the same answer to the same call and stopped with work still to do" };
  }
  if (!input.hasText) {
    return { status: "incomplete", reason: "it finished without saying anything" };
  }
  return { status: "success" };
}

/**
 * The envelope as the coordinator reads it.
 *
 * Compact on purpose, and in this order: the status first, because it decides what the coordinator
 * says next; the summary second; the facts last. Paths, never contents — the coordinator can `read`
 * one if it needs to, and pasting four files into its context to save it a tool call is how a
 * conversation runs out of room.
 */
export function renderHandoff(handoff: SubAgentHandoff): string {
  const lines = [`[${handoff.agentId} · ${handoff.status}]`];

  if (handoff.summary) lines.push(handoff.summary);
  else lines.push("(no report)");

  if (handoff.reason) lines.push("", handoff.reason);

  if (handoff.files.length > 0) {
    lines.push("", `Files it changed: ${handoff.files.join(", ")}`);
  }
  if (handoff.spills.length > 0) {
    // Its summary read these excerpts; you did not. The whole output is here, not in its words.
    lines.push("", `Full output of its large tool results, open with \`read\` (offset/limit) or \`grep\`: ${handoff.spills.join(", ")}`);
  }

  const { toolCalls, steps, ms } = handoff.metrics;
  lines.push(
    "",
    `${toolCalls} ${plural(toolCalls, "tool call")} · ` +
      `${steps} ${plural(steps, "step")} · ${Math.round(ms / 1000)}s`,
  );

  return lines.join("\n");
}

/** Whether the coordinator should treat this as a tool error. */
export function isHandoffError(handoff: SubAgentHandoff): boolean {
  return handoff.status === "failed";
}
