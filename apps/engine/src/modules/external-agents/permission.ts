/**
 * A coding CLI's permission request, asked as a Nouride approval (0.8.1, EXTERNAL_AGENTS §5.1).
 *
 * The CLI asks for its own tools — its shell, its edits — through ACP; the person answers it where they answer every
 * approval, the same buttons on Telegram and Discord, the same audit, parked in a mission. The answer goes back as the
 * option the CLI offered for it. Nouride writes no grant: *Always* is offered only where the CLI has an always of its
 * own, and the CLI keeps that rule itself.
 *
 * The tool's name and arguments are the CLI's, stable from one ask to the next, so an answer that arrives after a
 * parked question — nobody waiting — is kept, and the CLI's repeat of that call is allowed once (`approvals-kept.ts`).
 */

import type { PermissionOption, PermissionOutcome, RequestPermissionParams } from "@nouride/acp";
import type { GatewayName } from "@nouride/shared";
import type { ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { insideDelete, type DeleteScope } from "./inside-delete.ts";

export interface AskedIn {
  agentId: string;
  chatId: string;
  gateway: GatewayName;
  gatewayId: string;
  senderId: string;
  turnId?: string;
  signal?: AbortSignal;
  /** How long to wait for the person; 0 parks the question (a mission's turn) and `answerableMs` keeps it open. */
  waitMs?: number;
  answerableMs?: number;
}

/** The tool's name as the gate keeps it: the CLI's, prefixed, so it never matches a Nouride tool's rules or grants. */
function permissionTool(cli: string, request: RequestPermissionParams): string {
  return `${cli}:${request.toolCall.name?.trim() || request.toolCall.kind || "tool"}`;
}

export async function askPermission(input: {
  cli: string;
  cliName: string;
  request: RequestPermissionParams;
  asked: AskedIn;
  approvals: ApprovalGate;
  /** The `waiting` step, once the gate has a request to name. */
  waiting: (approvalId: string, tool: string) => void | Promise<void>;
  /** A mission's turn: its own folder, where a delete is allowed without a person (`inside-delete.ts`). */
  deleteScope?: DeleteScope;
  /** Told of a delete allowed that way — what ran without a person is said where the turn's steps are. */
  allowedAlone?: (tool: string, command: string, targets: readonly string[]) => void;
}): Promise<PermissionOutcome> {
  const { request, asked } = input;
  const tool = permissionTool(input.cli, request);
  if (input.deleteScope) {
    const verdict = insideDelete({ kind: request.toolCall.kind ?? null, rawInput: request.toolCall.rawInput }, input.deleteScope);
    const once = request.options.find((option) => option.kind === "allow_once");
    if (verdict.inside && once) {
      input.allowedAlone?.(tool, verdict.command, verdict.targets);
      return { outcome: "selected", optionId: once.optionId };
    }
  }
  const title = request.toolCall.title?.trim() || tool;
  const raw = request.toolCall.rawInput;
  const params = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { title };
  const offersAlways = request.options.some((option) => option.kind === "allow_always");
  const outcome = await input.approvals.request({
    agentId: asked.agentId,
    chatId: asked.chatId,
    gateway: asked.gateway,
    gatewayId: asked.gatewayId,
    senderId: asked.senderId,
    ...(asked.turnId ? { turnId: asked.turnId } : {}),
    tool,
    params,
    grantable: offersAlways,
    // A CLI's question is its preset's to ask: no approval level answers it for the person.
    autoCoverable: false,
    reason: reasonFor(input.cliName, title, params),
    ...(asked.signal ? { signal: asked.signal } : {}),
    ...(asked.waitMs !== undefined ? { waitMs: asked.waitMs } : {}),
    ...(asked.answerableMs !== undefined ? { answerableMs: asked.answerableMs } : {}),
    asking: (approvalId) => input.waiting(approvalId, tool),
  });
  // A question its turn was stopped under is `cancelled`, as ACP asks of a cancelled prompt — not a person's no.
  if (asked.signal?.aborted) return { outcome: "cancelled" };
  return chosen(outcome, request.options);
}

/** The option the CLI offered for the person's answer; a refusal it offers none for is `cancelled`. */
export function chosen(outcome: ApprovalOutcome, options: readonly PermissionOption[]): PermissionOutcome {
  const pick = (...kinds: PermissionOption["kind"][]): PermissionOutcome => {
    for (const kind of kinds) {
      const option = options.find((candidate) => candidate.kind === kind);
      if (option) return { outcome: "selected", optionId: option.optionId };
    }
    return { outcome: "cancelled" };
  };
  if (outcome.status === "approved") return outcome.decision === "allow-always" ? pick("allow_always", "allow_once") : pick("allow_once", "allow_always");
  // Denied, parked, expired, or nobody to ask: not this time. Never `reject_always` — a person's no is for this call.
  return pick("reject_once");
}

/**
 * Why the question is asked, in the prompt's "Why I am asking" line. A CLI's title is often its command itself, which
 * the prompt already shows in a code block: said twice, the command read as two different things (0.8.7). Then the
 * line says only who asks.
 */
export function reasonFor(cliName: string, title: string, params: Record<string, unknown>): string {
  const command = params.command;
  const line = typeof command === "string" ? command.trim() : Array.isArray(command) ? command.map(String).join(" ").trim() : "";
  const said = title.replace(/^`+|`+$/g, "").trim();
  if (line && (said === line || line.includes(said) || said.includes(line))) return `${cliName} asks to run the command above`;
  return `${cliName} asks to ${title}`;
}
