/**
 * An agent open to everyone, at the pipeline's doors: what holds for a sender let in only because it is open.
 *
 * Admission lets anyone in on an open agent's connection (`Admission.modeFor`), and says who among them has no
 * standing of their own (`Admission.strangerOf`). What that sender may then reach is said here, in one place, since
 * each rule is a way round the agent's fixed tools if it is missing.
 */

import { createLogger, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import { startOfLocalDay } from "@/commons/clock.ts";
import type { HookResult } from "@/modules/hooks/registry.ts";
import type { Admission } from "./admission.ts";
import type { PipelineDeps } from "./deps.ts";

const log = createLogger("pipeline.open-door");

/**
 * A stranger's message is the open agent's alone, before anything is routed: a name in their text, a reply, the
 * room's own answerer and the front desk are other agents' doors, and each would hand a stranger's words to an agent
 * that holds its pack's tools. In a group, only when the open agent is the one addressed: anyone may add its bot to a
 * group of their own. True when the message was a stranger's, answered or not: it is nobody else's.
 */
export async function heldToOpenAgent(
  admission: Pick<Admission, "strangerOf" | "addressedHere">,
  envelope: MessageEnvelope,
  answer: (agent: LoadedAgent) => Promise<void>,
): Promise<boolean> {
  const stranger = admission.strangerOf(envelope);
  if (!stranger) return false;
  if (admission.addressedHere(envelope)) await answer(stranger);
  else log.debug("a stranger's message that did not address the open agent", { chat_id: envelope.chatId, agent_id: stranger.config.id });
  return true;
}

/** What a stranger's `/start` hands the agent in place of the command: a chat app sends it when a bot's chat is opened. */
const STRANGER_OPENING = "(This person has just opened a chat with you. Greet them in a sentence or two, in your own words, and say what you can help with.)";
const STRANGER_HELP = "/new starts a new conversation with me, and /help shows this. For anything else, just write to me.";
const NOT_A_STRANGERS = "That command is not for this chat. /help shows what is.";

/**
 * A stranger has three commands: `/new`, which runs as anyone's does and clears only this chat's conversation;
 * `/start`, which is the opening of a chat and never the command that wakes an agent; and `/help`, which lists them.
 * Every other command is answered in one sentence and does nothing: `/sleep` from one stranger would close the bot
 * for all of them, `/model` would change what the owner pays for, and `/status` says what the install is.
 *
 * Null for the one whose own hook runs.
 */
export function strangerCommand(command: string): HookResult | null {
  if (command === "/new") return null;
  if (command === "/start") return { handled: false, prompt: STRANGER_OPENING };
  return { handled: true, reply: command === "/help" ? STRANGER_HELP : NOT_A_STRANGERS };
}

/** What a stranger is told of an agent put to sleep, in place of the sentence that names the command that wakes it. */
export const strangerAsleep = (displayName: string): string => `${displayName} is not answering at the moment.`;

/** What a stranger is told once, the day an agent's tokens are used, where its admin wrote no sentence of their own. */
const closedForToday = (displayName: string): string => `${displayName} has answered all it can for today. Please write again tomorrow.`;
/** What whoever writes to an open agent is told when there is nothing left for it to answer with today: its admin's sentence, or the daemon's. */
export const closedSentence = (agent: LoadedAgent): string => agent.config.open?.closedReply ?? closedForToday(agent.config.displayName);
const enoughForToday = (most: number): string => `That is all for today: I can take ${most} ${most === 1 ? "message" : "messages"} a day from each person. Please write again tomorrow.`;

/**
 * Whether a stranger's message may be answered, counted as it is asked: the agent's tokens for the day, then this
 * person's messages for the day (`OpenDoorStore`). Past either nothing is begun, and `say` is what they are told, once
 * a day. The first stranger turned away because the agent's day is used is also when its admin is told, once.
 *
 * Asked only for a stranger: a person let in by name is held to neither number, and what the agent uses for them
 * counts in its day as everything it uses does.
 */
function strangerMay(
  deps: Pick<PipelineDeps, "openDoor" | "usage" | "config" | "notifier">,
  agent: LoadedAgent,
  envelope: Pick<MessageEnvelope, "gatewayId" | "senderId" | "senderName" | "mergedIds" | "senderAlso">,
  now: number = Date.now(),
): { answer: true } | { answer: false; say: string | null } {
  const limits = agent.config.open;
  if (!deps.openDoor || !limits) {
    log.error("a stranger's message is not answered: this process keeps no count for an open agent", { agent_id: agent.config.id });
    return { answer: false, say: null };
  }
  const day = startOfLocalDay(now, deps.config.daemon.timezone);
  const used = deps.usage?.since(day, agent.config.id);
  const name = envelope.senderName ? { name: envelope.senderName } : {};
  // One person by one name, whichever of their addresses the platform put first: a WhatsApp sender is a phone address
  // in one chat and a hidden one in another, and counted by each they had twice the day's messages.
  const person = [envelope.senderId, ...(envelope.senderAlso ?? [])].sort()[0]!;
  const verdict = deps.openDoor.take({ agentId: agent.config.id, gatewayId: envelope.gatewayId, senderId: person, ...name, day, tokensToday: used ? used.inputTokens + used.outputTokens : 0, limits, messages: 1 + (envelope.mergedIds?.length ?? 0) });
  if (verdict.action === "answer") return { answer: true };
  if (verdict.action === "enough") return { answer: false, say: verdict.say ? enoughForToday(limits.maxDailyMessagesPerPerson) : null };
  if (verdict.first) {
    log.info("an open agent has used its tokens for the day, and is closed to strangers until the next", { agent_id: agent.config.id, max_daily_tokens: limits.maxDailyTokens });
    void deps.notifier?.alert(
      `open_agent_closed:${agent.config.id}`,
      `${agent.config.displayName} has used the ${limits.maxDailyTokens.toLocaleString("en-US")} tokens it may use in a day, and answers nobody from the public until tomorrow. ` +
        "Its daily limit is on its page in the dashboard, under Access.",
    );
  }
  return { answer: false, say: verdict.say ? closedSentence(agent) : null };
}

/** A stranger's message asked of the door, and they told what it says when it turns them away. True when it did. */
export async function turnedAway(
  deps: Parameters<typeof strangerMay>[0],
  agent: LoadedAgent,
  envelope: Pick<MessageEnvelope, "gatewayId" | "senderId" | "senderName" | "mergedIds" | "senderAlso">,
  say: (text: string) => Promise<unknown>,
): Promise<boolean> {
  const may = strangerMay(deps, agent, envelope);
  if (may.answer) return false;
  if (may.say) await say(may.say);
  return true;
}
