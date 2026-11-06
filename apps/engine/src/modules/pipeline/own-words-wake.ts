/**
 * The turns the daemon starts for an external agent's CLI (0.8.6), pushed into the chat's queue as a job's end is, once
 * the agent is free there, so neither runs beside a turn on the same history:
 *
 * - for what the CLI said by itself, between turns (`external-agents/own-words.ts`): its runner reads that rather than
 *   prompting the CLI, and the words here are only the transcript's line;
 * - at a start, for a command the CLI had left running that the last process was stopped with: prompted, as a job
 *   killed by a restart wakes its agent (`ExternalAgents.interrupted`).
 */

import { newId, type ChatType, type GatewayName, type MessageEnvelope } from "@nouride/shared";
import { SYSTEM_SENDER } from "./deps.ts";

/** Its cause's `via`: what `turn.ts` hands the runner `ownWords` for, and what the transcript's heading says. */
export const OWN_WORDS = "cli own words";

/** Its cause's `via`, and the transcript's heading for it. */
const CLI_STOPPED = "cli stopped";

type Chat = { agentId: string; gatewayId: string; chatId: string };

export function ownWordsEnvelope(chat: Chat, gateway: GatewayName, chatType: ChatType): MessageEnvelope {
  return cliEnvelope(chat, gateway, chatType, OWN_WORDS, "[The agent's coding CLI went on by itself, between turns: what it said follows.]");
}

export function cliStoppedEnvelope(chat: Chat, gateway: GatewayName, chatType: ChatType): MessageEnvelope {
  return cliEnvelope(
    chat,
    gateway,
    chatType,
    CLI_STOPPED,
    "[Nouride restarted, and stopped you with it: a command you had left running in the background may have been cut " +
      "off before it finished. Check whether it finished. If it did not, tell the person which command it was and that it " +
      "did not finish; run it again only if they want it.]",
  );
}

function cliEnvelope(chat: Chat, gateway: GatewayName, chatType: ChatType, via: string, text: string): MessageEnvelope {
  return {
    id: newId("msg"),
    timestamp: Date.now(),
    gateway,
    gatewayId: chat.gatewayId,
    chatId: chat.chatId,
    chatType,
    senderId: SYSTEM_SENDER,
    senderName: "Nouride",
    mentions: [chat.agentId],
    text,
    raw: { via },
  };
}
