/**
 * What a turn working in the background has, whichever kind it is — a helper `delegate` started there (0.7.15,
 * `background-helper.ts`), or another agent's turn an `ask_agent` moved there (0.7.19, `background-ask.ts`).
 *
 * Nobody is watching either of them, so the same three things hold: each step is a line of its job's log, a stop it
 * did not ask for is said as the stop it was, and a question it puts to a person says whose work it is.
 */

import type { ActivityKind } from "@/commons/activity.ts";
import type { ApprovalGate } from "@/modules/tools/approval.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { goalLine } from "@/modules/tools/builtins/delegate-brief.ts";

/** One step as a line of the job's log: what it called, what came back, what it waited on. Thinking is not a step. */
export function logLine(kind: ActivityKind, text: string): string | null {
  switch (kind) {
    case "thinking":
    case "reasoning":
      return null;
    case "tool":
      return `→ ${text}`;
    case "tool_done":
      return `  ${text}`;
    case "waiting":
      return `⏸ ${text}`;
    default:
      return `· ${text}`;
  }
}

/** A turn stopped before it could say anything: incomplete, with what stopped it — its clock, a restart, or a stop. */
export function stopped(agentId: string, startedAt: number, why: unknown): SubAgentHandoff {
  return {
    agentId,
    status: "incomplete",
    summary: "",
    files: [],
    spills: [],
    metrics: { toolCalls: 0, steps: 0, ms: Math.max(0, Date.now() - startedAt) },
    reason: why === "deadline" ? "it ran out of time before it finished" : why === "shutdown" ? "a restart stopped it before it finished" : "it was stopped before it finished",
  };
}

/** The model's words inside a question's quotes: one line, short, and unable to close them. */
export function quotable(words: string): string {
  return goalLine({ goal: words }, 80).replace(/"/g, "'");
}

/**
 * The approval gate, saying whose work a question is for — `who()`, when it has an answer, put in front of the reason,
 * which every surface shows and the row keeps. Read per question: an ask says it only once it is in the background.
 */
export function sayingWho(gate: ApprovalGate, who: () => string | null): ApprovalGate {
  return {
    get available() {
      return gate.available;
    },
    ...(gate.canAsk ? { canAsk: () => gate.canAsk!() } : {}),
    pending: (agentId) => gate.pending(agentId),
    expireAll: (agentId, chat) => gate.expireAll(agentId, chat),
    request: (ask) => {
      const said = who();
      return gate.request(said ? { ...ask, reason: ask.reason ? `${said}: ${ask.reason}` : said } : ask);
    },
  };
}
