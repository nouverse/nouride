/**
 * What a restart owes the approvals the last process left pending, once the gateways can carry it (D8).
 *
 * The gate decided at boot which to keep (`SqliteApprovalGate.carryOver`): those young enough to be answered are put in
 * front of their chats again, said to be from before the restart; those that are not were expired, and their chats are
 * told so here — in words, because a question that silently stopped being answerable reads as one still waiting. Both
 * go on the conversation's timeline for the dashboard, and both were logged by the gate as it decided.
 *
 * Before the turns a restart takes up (`boot/durable.ts`): a turn cut off waiting on one of these makes the same call
 * again and waits on the question already in front of the person, instead of asking a second time.
 */

import { createLogger, type ApprovalRequest } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import { describeApprovalParams } from "@/modules/pipeline/messages.ts";

const log = createLogger("daemon");

/** What a chat is told about a question the restart could not keep. */
export function lapsedNotice(request: Pick<ApprovalRequest, "agentId" | "tool" | "params">): string {
  const what = describeApprovalParams(request);
  return (
    `⚠️ ${request.agentId} was waiting on your answer about \`${request.tool}\`${what ? ` (${what})` : ""} when the daemon ` +
    "restarted. It had waited too long to be kept, so it expired and nothing ran. Ask again if you still want it."
  );
}

export function askKeptApprovals(input: {
  approvals: { showKept(): number };
  kept: readonly ApprovalRequest[];
  lapsed: readonly ApprovalRequest[];
  notifier: Pick<Notifier, "toChat">;
  chatEvents?: Pick<ChatEventsPort, "record">;
  /** The connection an agent speaks on in a chat — where its approval prompt went, and where this goes. */
  voice: (agentId: string, gatewayId: string) => string;
}): void {
  const asked = input.approvals.showKept();
  if (asked > 0) log.info("asked the approvals kept across the restart again", { count: asked });
  for (const request of input.kept) {
    input.chatEvents?.record({
      gatewayId: request.gateway,
      chatId: request.chatId,
      audience: "ui",
      kind: "note",
      text: `The approval for ${request.tool} that ${request.agentId} asked before the restart is still open, and was asked again.`,
      agentId: request.agentId,
      details: { approval: request.id, kept: true },
    });
  }
  for (const request of input.lapsed) {
    const text = lapsedNotice(request);
    input.chatEvents?.record({ gatewayId: request.gateway, chatId: request.chatId, audience: "ui", kind: "note", text, agentId: request.agentId, details: { approval: request.id, kept: false } });
    void input.notifier
      .toChat({ gatewayId: input.voice(request.agentId, request.gateway), chatId: request.chatId }, text)
      .catch((err: unknown) => log.warn("could not say an approval was lost to the restart", { approval: request.id, error: String(err) }));
  }
}
