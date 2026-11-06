/**
 * Which request a bare `/approve` is answering, and what to say when there is nothing to answer.
 *
 * The hard part is not the lookup — it is that an answer often arrives *after* the thing it was
 * answering settled, and the reply has to say which of the three ways that happened.
 */

import { type ApprovalDecision, type ApprovalRequest } from "@nouride/shared";
import { adminOnly, adminOnlyChanges, adminOnlyNotice, mayAnswer as answerable } from "@/modules/tools/approval-answerers.ts";
import type { Answerer } from "@/modules/tools/approval.ts";
import type { HookContext, HookResult } from "./types.ts";
import { formatDuration } from "./format.ts";


/**
 * How far back `/approve` looks for the request it just missed.
 *
 * Long enough to cover a full turn plus the approval timeout — both default to five minutes — so an
 * answer that lost a race with either of them still finds the thing it was answering.
 */
const SETTLED_LOOKBACK_MS = 15 * 60_000;

/**
 * What to say when an answer arrives and there is nothing left to answer.
 *
 * "Nothing is waiting for approval." is true and useless. Live, it was the reply to a `/approve` the
 * operator had typed within thirty seconds of the prompt — the message spent three and a half minutes
 * stuck in a stalled Telegram poll, and by the time it landed the request had expired with its turn.
 * Two facts, both known to the daemon, neither of them in the reply: that there *had* been a request
 * here, and that it died rather than being answered by someone else.
 *
 * Without that, the operator reads a working gate as a broken one — which is exactly what happened.
 */
export function noPendingReply(ctx: HookContext): string {
  const settled = ctx.deps.approvals.recentlySettledForChat?.(
    ctx.gatewayId,
    ctx.chatId,
    Date.now() - SETTLED_LOOKBACK_MS,
  );
  const last = settled?.[0];
  if (!last) return "Nothing is waiting for approval.";

  const ago = formatDuration(Math.max(0, Math.round((Date.now() - (last.resolvedAt ?? 0)) / 1000)));
  if (last.status === "expired") {
    return (
      `Nothing is waiting now: the \`${last.tool}\` request expired ${ago} ago, before this ` +
      `reached me. Ask me to do it again and I will re-request it.`
    );
  }
  return (
    `Nothing is waiting now: the \`${last.tool}\` request was already ` +
    `${last.status}${last.resolvedBy ? ` by ${last.resolvedBy}` : ""} ${ago} ago.`
  );
}

/** Whether this sender may answer `request` from here (S8) — the rule a button press keeps too (`approval-answerers.ts`). */
function mayAnswer(ctx: HookContext, request: ApprovalRequest): boolean {
  return answerable({ chatType: ctx.envelope.chatType, senderId: ctx.senderId, isAdmin: () => ctx.deps.isAdmin?.(ctx.envelope) ?? false }, request);
}

/** Who answers from a chat: the id the gate records, and the name a settled prompt says (G11). */
function answerer(ctx: HookContext): Answerer {
  return { id: ctx.senderId, ...(ctx.envelope.senderName ? { name: ctx.envelope.senderName } : {}) };
}

/** Said of requests someone else asked for, in a room. */
function someoneElses(count: number): string {
  return `${count === 1 ? "was" : "were"} asked for by someone else here: only they, or an admin, can answer ${count === 1 ? "it" : "them"}`;
}

/**
 * Everything waiting for an answer **in this conversation**, whichever agent asked.
 *
 * Scoped to the chat, not to the agent that was addressed. Those are different scopes and using the
 * narrower one left the operator with no way out: an agent answers here through another agent's bot
 * when its own is not in the room, so the prompt appeared under Nouva's name while the request
 * belonged to Nexa — and `@Nouva /approve` then found nothing while Nexa, having no bot present,
 * could not be addressed at all.
 *
 * Still per conversation, which is the property that matters: a bare `/approve` cannot answer
 * something raised in a chat the person never saw.
 */
function pendingHere(ctx: HookContext): ApprovalRequest[] {
  const gate = ctx.deps.approvals;
  if (!gate.available) return [];

  const agentIds = ctx.deps.registry.enabled().map((agent) => agent.config.id);
  // The addressed agent first, so a single pending request of its own is the one a bare `/approve`
  // resolves — the common case keeps its old behaviour exactly.
  const ordered = [
    ctx.agent.config.id,
    ...agentIds.filter((id) => id !== ctx.agent.config.id),
  ];

  const seen = new Set<string>();
  const all: ApprovalRequest[] = [];
  for (const agentId of ordered) {
    const forAgent = gate.pendingForChat
      ? gate.pendingForChat(agentId, ctx.gatewayId, ctx.chatId)
      : gate.pending(agentId);
    for (const request of forAgent) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      all.push(request);
    }
  }
  return all;
}

/**
 * Approve every pending request that auto-approval covers, and report what is left.
 *
 * Called by `/approvals balanced`, so the operator does not have to follow up with `/approve all`. The
 * intent of "stop asking me" includes the requests already on screen. Seen live: three
 * credential-touching commands asked in a row, the operator switched the level instead of answering,
 * and the request on screen kept waiting until its turn gave up four minutes later.
 *
 * What the level never covers (`autoCoverable === false`) is left waiting and named, with its reason,
 * so the next action is obvious: those always need an explicit answer.
 */
export function drainCoveredPending(ctx: HookContext): { drained: number; notice: string[] } {
  const gate = ctx.deps.approvals;
  if (!gate.available) return { drained: 0, notice: [] };

  const pending = pendingHere(ctx);
  if (pending.length === 0) return { drained: 0, notice: [] };

  // Split on `autoCoverable`, not on `grantable`. They used to be the same field, and gave the same
  // answer only while auto-approval excluded every entry of the fixed list. Now that `balanced` asks only
  // `BALANCED_ASKS`, a `terraform destroy` is ungrantable and perfectly coverable — reading `grantable`
  // here would leave it sitting in the queue after the operator said "stop asking".
  // Only what this sender may answer: `/approvals balanced` in a room is a person's, not the room's (S8).
  const mine = pending.filter((request) => mayAnswer(ctx, request));
  const neverCovered = mine.filter((request) => request.autoCoverable === false);
  const coverable = mine.filter((request) => request.autoCoverable !== false);

  // Same reason as `answerAllApprovals`: answering one promotes the next, and a prompt for something
  // this loop is about to approve would arrive after the approval. The hardline ones are deliberately
  // left in the queue — they still need a human, so they still need to be asked.
  gate.stopShowing?.(coverable.map((request) => request.id));

  // Approve every coverable request now.
  const drained = coverable.filter(
    (request) => gate.resolve?.(request.id, "allow-once", answerer(ctx)),
  ).length;

  // Report only the hardline ones that still need a manual answer.
  const notice: string[] = [];
  if (neverCovered.length > 0) {
    const plural = neverCovered.length === 1 ? "request is" : "requests are";
    notice.push(
      "",
      `\u26a0\ufe0f ${neverCovered.length} ${plural} still waiting that this does **not** cover:`,
      ...neverCovered.map(
        (request) => `\u00b7 \`${request.tool}\`${request.reason ? `: ${request.reason}` : ""}`,
      ),
      "Answer with `/approve`: auto-approval never covers these, so nothing moves until you do.",
    );
  }

  return { drained, notice };
}

/**
 * Answer everything waiting in this conversation.
 *
 * Scoped to the chat for the same reason a bare `/approve` is: an unscoped sweep would let someone
 * approve requests they never saw, raised in a conversation they are not in.
 */
export async function answerAllApprovals(
  ctx: HookContext,
  decision: ApprovalDecision,
): Promise<HookResult> {
  const gate = ctx.deps.approvals;
  if (!gate.available) return { handled: true, reply: "There is no approval gate in this build." };

  // Every agent in this conversation, for the same reason `/approve` does — see `pendingHere`.
  const waiting = pendingHere(ctx);
  if (waiting.length === 0) return { handled: true, reply: noPendingReply(ctx) };
  // In a room, everything this sender may answer: what they asked for, or all of it for an admin (S8).
  const pending = waiting.filter((request) => mayAnswer(ctx, request));
  const others = waiting.length - pending.length;
  // A change to an agent's persona or to People is an admin's to answer, the sender's own request too: said as that, not
  // as someone else's — and what it changes, when they all change the same thing.
  const notMine = waiting.filter((request) => !mayAnswer(ctx, request));
  const changes = new Set(notMine.map((request) => adminOnlyChanges(request)));
  const what = changes.size === 1 ? [...changes][0] : null;
  const whose = (count: number) =>
    notMine.every((request) => adminOnly(request))
      ? `${count === 1 ? "is" : "are"} an admin's alone to answer${what ? `: ${count === 1 ? "it changes" : "they change"} ${what}` : ""}`
      : someoneElses(count);
  if (pending.length === 0) {
    return { handled: true, reply: `${others === 1 ? "The request waiting" : `The ${others} requests waiting`} ${whose(others)}.` };
  }

  // Before the first answer, not after. Each answer hands the floor to the next question in this
  // conversation — which here is the next one on this very list — and the prompt for it would land in
  // the chat a moment after it had already been approved. See `tools/approval-floor.ts`.
  gate.stopShowing?.(pending.map((request) => request.id));

  // Counted rather than assumed: one may expire between listing and answering, and reporting a
  // number that includes it would claim a tool ran that did not.
  const answered = pending.filter((request) => gate.resolve?.(request.id, decision, answerer(ctx)));
  const verb = decision === "deny" ? "Denied" : "Approved";
  const missed = pending.length - answered.length;

  return {
    handled: true,
    reply:
      `${verb} ${answered.length} request(s).` +
      (missed > 0 ? ` ${missed} had already expired.` : "") +
      (others > 0 ? ` ${others} more ${whose(others)}.` : ""),
  };
}

/**
 * What a bare `/approve` means.
 *
 * One pending request is unambiguous and always was. Several is the new case, and it is not
 * ambiguous either: prompts are posted one at a time, so only one of them has ever been on screen —
 * see `tools/approval-floor.ts`. Answering that one is answering the thing they just read.
 *
 * Falls through to naming an id when the gate cannot say which is displayed, or when the displayed
 * one is not in this conversation's pending list — a race with an answer from the CLI. Guessing
 * there would approve something the person never saw, which is the whole failure this scope exists
 * to prevent.
 */
function bareTarget(ctx: HookContext, pending: ApprovalRequest[]): string | undefined {
  if (pending.length === 1) return pending[0]!.id;
  const shown = ctx.deps.approvals.displayedForChat?.(ctx.gatewayId, ctx.chatId);
  return shown && pending.some((request) => request.id === shown) ? shown : undefined;
}

/**
 * Shared by `/approve` and `/deny`.
 *
 * A bare command answers the most recent pending request for this agent, because that is what
 * someone watching the chat means — they just saw one prompt. An explicit id is required only
 * when several are outstanding, and passing the wrong one is better refused than guessed.
 */
export async function answerApproval(
  ctx: HookContext,
  decision: ApprovalDecision,
  explicitId?: string,
): Promise<HookResult> {
  const gate = ctx.deps.approvals;
  if (!gate.available) {
    return { handled: true, reply: "There is no approval gate in this build." };
  }

  // Scoped to this conversation, across every agent in it. The unscoped list let a bare `/approve` in
  // one chat answer a request raised in another — an operator approving something they never saw.
  // Scoping it to the *addressed agent* went too far the other way; see `pendingHere`.
  const pending = pendingHere(ctx);
  if (pending.length === 0) return { handled: true, reply: noPendingReply(ctx) };

  const id = explicitId ?? bareTarget(ctx, pending);
  if (!id) {
    return {
      handled: true,
      reply: [
        `${pending.length} requests are waiting. Name one:`,
        // The agent, because two of these can be the same tool asked for by different agents working
        // at the same time, and then the tool name alone identifies nothing.
        ...pending.map((request) => `- \`${request.id}\` ${request.agentId}: ${request.tool}`),
      ].join("\n"),
    };
  }

  // An id from another conversation is not this one's to answer, however it was learned.
  const request = pending.find((candidate) => candidate.id === id);
  if (!request) return { handled: true, reply: `\`${id}\` is not waiting for an answer here.` };
  if (!mayAnswer(ctx, request)) return { handled: true, reply: adminOnlyNotice(request) ?? `\`${id}\` ${someoneElses(1)}.` };
  const resolved = gate.resolve?.(id, decision, answerer(ctx));
  if (!resolved) {
    // Already answered or expired. Saying "done" would imply a tool ran that did not.
    return { handled: true, reply: `\`${id}\` is not waiting for an answer any more.` };
  }
  if (decision === "deny") return { handled: true, reply: `Denied \`${id}\`.` };

  // The downgrade is reported rather than swallowed. Someone who typed `always` and got a
  // one-time approval has to know, or they will be surprised at the next prompt and conclude the
  // feature is broken.
  if (decision === "allow-always" && request.grantable === false) {
    return {
      handled: true,
      reply:
        `Approved \`${id}\`, but only this once. That command is in a class that never gets a ` +
        `standing permission (an elevation, a recursive delete, system control, or an infrastructure mutation).`,
    };
  }
  return {
    handled: true,
    reply:
      decision === "allow-always"
        ? `Approved \`${id}\`, and I will not ask again for that exact command. \`/grants\` to review.`
        : `Approved \`${id}\`.`,
  };
}
