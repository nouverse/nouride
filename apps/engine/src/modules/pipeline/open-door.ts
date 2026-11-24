/**
 * An agent open to everyone, at the pipeline's doors: what holds for a sender let in only because it is open.
 *
 * Admission lets anyone in on an open agent's connection (`Admission.modeFor`), and says who among them has no
 * standing of their own (`Admission.strangerOf`). What that sender may then reach is said here, in one place, since
 * each rule is a way round the agent's fixed tools if it is missing.
 */

import { createLogger, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
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
