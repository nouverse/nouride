import type { ApprovalRequest } from "@nouride/shared";
import type { AckResponse, ApprovalResponse, ApprovalsResponse } from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, fail, say } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { knownAction } from "@/cli/usage.ts";
import { hasFlag } from "@/cli/args.ts";
import { adminOnly, adminOnlyChanges } from "@/modules/tools/approval-answerers.ts";

/** The answers. Each must reach a person when an agent gives it — `@nouride/policy`'s `own-cli.ts` copies this list. */
export const APPROVAL_ACTIONS = ["allow-once", "allow-always", "always", "deny"] as const;

export async function approvals(client: Client, args: string[]): Promise<void> {
  const [action, id] = args;
  knownAction("approvals", action, [...APPROVAL_ACTIONS, "list", "show"]);

  if (action === "show") {
    if (!id || id.startsWith("--")) fail("which approval?", "nouride approvals show <id> (the ids are in `nouride approvals --all`).");
    const { approval } = await client.get<ApprovalResponse>(`/approvals/${encodeURIComponent(id)}`);
    showOne(approval);
    return say(`    ${DIM}asked in ${approval.gateway} ${approval.chatId}${RESET}`);
  }

  if (action && (APPROVAL_ACTIONS as readonly string[]).includes(action)) {
    /**
     * Two rules for an agent, and none for a person.
     *
     * An agent's `nouride` tool sets `NOURIDE_AGENT_ID` (`tools/builtins/nouride-cli.ts`), so a call
     * without it was typed by somebody at a terminal. The hardline row in `@nouride/policy` already puts
     * an agent's answer in front of a person; these make that prompt mean what it says.
     *
     * - **Name the request.** With no id this answers whatever is first in the queue, and the person
     *   approving "nouride approvals allow-always" could not know which request that would be.
     * - **Not its own.** A request is put to a person. An agent answering one of its own — the
     *   `delegate` shape, one helper running `rm -rf` while another waits to approve it — is the gate
     *   answering itself, and a person who wanted it run can say so where it was asked.
     * - **Not an admin's (0.8.8).** A change to an agent's persona, or to People (0.8.9), is answered by an admin
     *   alone. Answered here by another agent, at `trusted` nobody saw it — and at any level the question a person was
     *   asked was about the `nouride` call, never the diff. One the list does not hold is looked up, so an unknown
     *   request fails closed.
     *
     * Read from the environment, so this is a second line rather than the boundary: anything that can
     * reach the control API with the token can skip the CLI. The boundary is the classifier.
     */
    const agent = process.env.NOURIDE_AGENT_ID;
    if (agent && !id) {
      fail(
        "an agent has to name the approval it answers",
        "`nouride approvals` lists what is waiting; answer one with `nouride approvals <allow-once|allow-always|deny> <id>`.",
      );
    }
    const pending = agent || !id ? ((await client.get<ApprovalsResponse>("/approvals")).pending ?? []) : [];
    const target = id ?? pending[0]?.id;
    if (!target) return say(`${DIM}nothing pending${RESET}`);
    const request = agent ? (pending.find((one) => one.id === target) ?? (await client.get<ApprovalResponse>(`/approvals/${encodeURIComponent(target)}`)).approval) : undefined;
    if (agent && request?.agentId === agent) {
      fail(
        "an agent cannot answer its own approval request",
        "It was put to a person: ask them to answer it in this chat (/approve) or in the dashboard.",
      );
    }
    if (agent && (!request || adminOnly(request))) {
      const changes = request ? adminOnlyChanges(request) : null;
      fail(
        "an agent cannot answer an approval only an admin answers",
        `${changes ? `It changes ${changes}: an` : "An"} admin answers it in its chat, or in the dashboard.`,
      );
    }
    // `always` is accepted as a shorthand, as `/approve always` is in a chat. Mapped here, so the daemon is sent the
    // word that says so.
    const decision = action === "always" ? "allow-always" : action;
    const result = await client.post<AckResponse>(`/approvals/${target}/${decision}`);
    return say(`${GREEN}✓${RESET} ${result.decision ?? decision} ${target}`);
  }

  const all = hasFlag(args, "--all");
  const { pending, settled = [] } = await client.get<ApprovalsResponse>(all ? "/approvals?all=1" : "/approvals");
  if (pending.length === 0 && settled.length === 0) return say(`${DIM}nothing pending${all ? ", and no answered approvals kept" : ""}${RESET}`);
  if (pending.length === 0) say(`${DIM}nothing pending${RESET}`);
  for (const request of pending) showOne(request);
  if (settled.length > 0) say();
  for (const request of settled) showOne(request, false);
  say();
  say(`${DIM}answer one: nouride approvals <allow-once|allow-always|deny> [id] · one in full: show <id>${all ? "" : " · answered ones: --all"}${RESET}`);
}

/** How much of an answered request's reason and parameters the list shows; `show <id>` has the whole. */
const LISTED_CHARS = 160;

function clipped(text: string, whole: boolean): string {
  const line = whole ? text : text.replace(/\s+/g, " ");
  return whole || line.length <= LISTED_CHARS ? line : `${line.slice(0, LISTED_CHARS - 1)}…`;
}

/**
 * One request: pending with how long it has waited, or how it ended and who said so. A pending one is shown whole — a
 * cut command is not one anybody can approve — and so is one asked for by `show`; an answered one in the list is cut
 * to a line each: on the live box one mission's command filled a screen, twice, per approval.
 */
function showOne(request: ApprovalRequest, whole = true): void {
  if (request.status === "pending") {
    const waited = Math.round((Date.now() - request.requestedAt) / 1000);
    say(`${YELLOW}●${RESET} ${BOLD}${request.tool}${RESET} ${DIM}${request.id} · ${request.agentId} · ${waited}s ago${RESET}`);
  } else {
    const how = request.decision ?? request.status;
    const mark = how === "deny" || request.status === "denied" ? `${RED}✗${RESET}` : request.status === "approved" ? `${GREEN}✓${RESET}` : `${DIM}–${RESET}`;
    const when = new Date(request.resolvedAt ?? request.requestedAt).toISOString().replace("T", " ").slice(0, 16);
    say(`${mark} ${BOLD}${request.tool}${RESET} ${DIM}${request.id} · ${request.agentId} · ${how}${request.resolvedBy ? ` by ${request.resolvedBy}` : ""} · ${when}${RESET}`);
  }
  if (request.reason) say(`    ${DIM}${clipped(request.reason, whole)}${RESET}`);
  say(`    ${DIM}${clipped(JSON.stringify(request.params), whole)}${RESET}`);
  if (request.status === "pending" && request.grantable === false) {
    say(`    ${DIM}allow-always is not available for this one${RESET}`);
  }
}

/**
 * Map a typed answer to a decision.
 *
 * Anything that is not clearly a yes is a no. An ambiguous keystroke must never become an
 * approval, and `a` when `allow-always` is not on offer falls back to a one-time yes rather than
 * being rejected — the operator meant yes.
 */
export function decisionFromAnswer(answer: string, grantable: boolean): string {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "a" || normalized === "always") {
    return grantable ? "allow-always" : "allow-once";
  }
  return normalized.startsWith("y") ? "allow-once" : "deny";
}
