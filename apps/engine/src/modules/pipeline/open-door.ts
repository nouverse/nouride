/**
 * An agent open to everyone, at the pipeline's doors: what holds for a sender let in only because it is open.
 *
 * Admission lets anyone in on an open agent's connection (`Admission.modeFor`), and says who among them has no
 * standing of their own (`Admission.strangerOf`). What that sender may then reach is said here, in one place, since
 * each rule is a way round the agent's fixed tools if it is missing.
 */

import { createLogger, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import type { HookResult } from "@/modules/hooks/registry.ts";
import type { Admission } from "./admission.ts";

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
