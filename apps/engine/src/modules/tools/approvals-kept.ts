/**
 * An approval that outlives the moment it was asked in — a restart, or a turn that stopped waiting (D8).
 *
 * A restart answered every pending approval "deny": shutdown expired them all before the drain, and boot expired what
 * was left. The question a person was about to answer was gone, and the turn taken up after the restart asked it again,
 * or gave up. Now a request young enough to be answered is kept: its row stays pending, and the boot puts it in front of
 * the person again with the time it has left. What only the asking process knew about it (`KeptExtras`) is on its row
 * from the moment it is asked (076): it was handed over in a file at a clean shutdown alone, so a crash or a kill lost
 * who asked (in a room, only an admin could answer then) and what `always` writes.
 *
 * Two rules make a kept question worth keeping, and they hold for any question nobody is waiting on, restart or not:
 *
 * - **The same call waits on the same question.** A request for exactly a call still open in that conversation — the
 *   resumed turn making the call it was cut off in — waits on the open one rather than asking twice (`callKey`).
 * - **An answer nobody was waiting for is the answer to that call, once.** It still wakes the agent; and when the agent
 *   makes the call, it runs (or is refused) on that answer, instead of the person being asked again what they have just
 *   answered (`UnclaimedAnswers`).
 */

import { createLogger, type ApprovalRequest, type ExecGrantPayload, type ToolGrantPayload } from "@nouride/shared";
import { join, readTextFileSync, removePath } from "@nouride/runtime";
import type { ApprovalAsk, ApprovalOutcome, JobGrantPayload } from "./approval.ts";

const log = createLogger("tools.approval");

/** Kept only with this much of its window left: put in front of a person with less, it would expire as they read it. */
export const KEEP_AT_LEAST_MS = 30_000;

/** What only the process that asked knew about a request: on its row as JSON (076), read back across a restart. */
export interface KeptExtras {
  /** Who asked: in a room, they or an admin may answer (S8). */
  requestedBy?: string;
  /** The turn that asked — the one a restart takes up again. */
  turnId?: string;
  /** What `allow-always` writes: without it, an answer of "always" runs the call once. */
  grant?: ExecGrantPayload;
  toolGrant?: ToolGrantPayload;
  /** What *always for this job* writes on a job (0.8.0). */
  jobGrant?: JobGrantPayload;
}

/** A request's extras, from its ask: a grant only where `always` is offered, as the gate keeps them in memory. */
export function askedExtras(ask: ApprovalAsk): KeptExtras {
  return {
    requestedBy: ask.senderId,
    ...(ask.turnId ? { turnId: ask.turnId } : {}),
    ...(ask.grant && ask.grantable ? { grant: ask.grant } : {}),
    ...(ask.toolGrant && ask.grantable ? { toolGrant: ask.toolGrant } : {}),
    ...(ask.jobGrant && ask.grantable ? { jobGrant: ask.jobGrant } : {}),
  };
}

/**
 * `approvals-kept.json`, which 0.8.17 and before wrote at a clean shutdown with the extras of what was pending. Read
 * once, at the first start of 0.8.18, for rows asked before the upgrade (their extras are not on them), then removed;
 * nothing writes it any more. For 1.0.0 to delete, with `oldHandOver` in `approvals.store.ts`.
 */
export interface KeptFile {
  /** What it holds, by request id: nothing when there is no file or it cannot be read. */
  read(): Record<string, KeptExtras>;
  /** Gone, once what it held is on the rows. */
  remove(): void;
}

export function keptApprovalsFile(dataDir: string): KeptFile {
  const path = join(dataDir, "approvals-kept.json");
  return {
    read() {
      let text: string;
      try {
        text = readTextFileSync(path);
      } catch {
        return {};
      }
      try {
        const value: unknown = JSON.parse(text);
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, KeptExtras>) : {};
      } catch {
        log.warn("the approvals handed over by the last process could not be read, so they are kept without who asked");
        return {};
      }
    },
    remove() {
      removePath(path);
    },
  };
}

/** A call, as "the same question" means it: agent, conversation, tool, and arguments with their keys in order. */
export function callKey(call: { agentId: string; gatewayId: string; chatId: string; tool: string; params: unknown }): string {
  return JSON.stringify([call.agentId, call.gatewayId, call.chatId, call.tool, ordered(call.params)]);
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered((value as Record<string, unknown>)[key])]));
}

/**
 * Answers that arrived with nobody waiting, each taken by the next identical call — once, and only within the window an
 * approval is good for. An "allow-always" that wrote a grant is never taken: the grant runs that call from then on.
 */
export class UnclaimedAnswers {
  private readonly answers = new Map<string, { id: string; outcome: ApprovalOutcome; at: number; agentId: string; chat: string }>();

  constructor(private readonly windowMs: number, private readonly now: () => number) {}

  keep(call: string, request: Pick<ApprovalRequest, "id" | "agentId" | "gateway" | "chatId">, outcome: ApprovalOutcome): void {
    for (const [key, answer] of this.answers) if (this.now() - answer.at >= this.windowMs) this.answers.delete(key);
    this.answers.set(call, { id: request.id, outcome, at: this.now(), agentId: request.agentId, chat: `${request.gateway} ${request.chatId}` });
  }

  /** The answer to this call, taken: null when there is none, or it is older than the window. */
  take(call: string): { id: string; outcome: ApprovalOutcome } | null {
    const answer = this.answers.get(call);
    if (!answer) return null;
    this.answers.delete(call);
    return this.now() - answer.at < this.windowMs ? answer : null;
  }

  /** What `/reset` and a deleted conversation take with them — `SqliteApprovalGate.expireAll`. */
  drop(agentId?: string, chat?: { gatewayId: string; chatId: string }): void {
    for (const [key, answer] of this.answers) {
      if (agentId && answer.agentId !== agentId) continue;
      if (chat && answer.chat !== `${chat.gatewayId} ${chat.chatId}`) continue;
      this.answers.delete(key);
    }
  }
}
