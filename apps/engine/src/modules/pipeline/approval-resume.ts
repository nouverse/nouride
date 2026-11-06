/**
 * What an agent is told when a person answers an approval after the turn that asked stopped waiting.
 *
 * Moved out of `Pipeline.resumeAfterApproval`, which says why it exists and when it is sent; this is only
 * the message. A system event into the same conversation: an empty reply from one sends nothing, so an agent
 * with nothing to add stays quiet, and the queue keeps it behind whatever the conversation is doing.
 */

import { newId, type ApprovalDecision, type ApprovalRequest, type MessageEnvelope } from "@nouride/shared";
import { SYSTEM_SENDER } from "./deps.ts";
import { describeApprovalParams } from "./messages.ts";
import { SAY_NOTHING } from "@/commons/silence.ts";

export function approvalResumeEnvelope(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  by: string,
  platform: MessageEnvelope["gateway"],
  chatType: MessageEnvelope["chatType"],
): MessageEnvelope {
  const answer = decision === "deny" ? "refused" : "approved";
  const what = describeApprovalParams(request);
  return {
    id: newId("msg"),
    timestamp: Date.now(),
    gateway: platform,
    gatewayId: request.gateway,
    chatId: request.chatId,
    // Both for the same reasons as `wakeForJob`: the prompt's handover section depends on the chat
    // type, and in a room where unaddressed messages are ignored the only thing that routes this to
    // the agent that asked for the approval is naming it.
    chatType,
    senderId: SYSTEM_SENDER,
    senderName: "Nouride",
    mentions: [request.agentId],
    text:
      `[system] ${by} has just ${answer} the \`${request.tool}\` call you asked about and stopped ` +
      `waiting for${what ? `: ${what}` : "."}\n\n` +
      (decision === "deny"
        ? "They said no. Do not run it, do not look for another way to do the same thing, and do " +
          "not argue. If you had told them you were waiting on it, say in one line that you will " +
          `leave it. Otherwise ${SAY_NOTHING}.`
        : "Carry on from there if it is still worth doing: run it now, then say what came of it. " +
          `If you already finished the request another way, or the moment has passed, ${SAY_NOTHING}.`),
    raw: { via: "approval resumed", approval: request.id, decision },
  };
}
