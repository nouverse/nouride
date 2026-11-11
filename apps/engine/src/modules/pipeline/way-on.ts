/**
 * A way on for work that stopped in a room.
 *
 * Two stops left a room with words and nothing to press. A chain between agents that reached its hop budget said
 * "say something if you want us to continue", and handed-over work that failed said its work was kept: in both the
 * person typed the request again. Now the line carries buttons where the connection has them, and says the same in
 * words where it does not:
 *
 * - **Continue**, under a chain stopped at its budget: the hand-over that was not delivered is, with the count begun
 *   again, which is what a person speaking in the room has always done to it.
 * - **Continue** and **Hand to**, under a turn an agent's hand-over began that ended early: the same agent takes it
 *   up, or another agent of the room is given what it was asked.
 *
 * Whoever may talk to the agent in that chat may press: the work was an agent's to hand over, so there is no one
 * person whose turn it was. Once: a line pressed is settled, and says who chose what.
 *
 * What a button needs is kept here, in memory and bounded. A restart forgets it, and a press then says so: the words
 * on the line still work.
 */

import { newId, type ButtonPress, type LoadedAgent, type MessageButton, type MessageEnvelope, type PressAnswer } from "@nouride/shared";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import type { TurnContext } from "./turn-context.ts";

const CHAIN = "chain:go:";
const HAND = "hand:to:";

/** Stopped chains and offered lines kept at once: past it the oldest goes, and its button says it waits no more. */
const KEPT = 100;
/** Other agents offered under one line, the first of the room's list: a row of buttons a phone still shows whole. */
export const HAND_TO_SHOWN = 3;
/** What a platform takes as a button's data (Telegram, the smallest). An agent whose id does not fit is not offered. */
const DATA_MAX = 64;

/** A hand-over a chain's budget stopped: what Continue delivers. */
interface StoppedChain {
  envelope: MessageEnvelope;
  /** The agent it was for, and the one that handed it over. */
  to: string;
  from: string;
  /** The line the room was told, which the settled one repeats. */
  notice: string;
}

/** What the buttons of this file need between the line and the press. */
export class WaysOn {
  private readonly chains = new Map<string, StoppedChain>();
  /** Turns whose line carried Continue and Hand to, so a press on one is known to be about handed-over work. */
  private readonly offered = new Set<string>();
  /** Turns a press settled: the other button of the line does nothing more. */
  private readonly settled = new Set<string>();

  /** Keep a stopped hand-over, and the button that delivers it. */
  keepChain(chain: StoppedChain): MessageButton {
    const key = newId("chn").slice(-12);
    this.chains.set(key, chain);
    trim(this.chains);
    return { label: "Continue", data: `${CHAIN}${key}`, style: "positive" };
  }

  takeChain(key: string): StoppedChain | undefined {
    const chain = this.chains.get(key);
    this.chains.delete(key);
    return chain;
  }

  chain(key: string): StoppedChain | undefined {
    return this.chains.get(key);
  }

  offer(turnId: string): void {
    this.offered.add(turnId);
    trim(this.offered);
  }

  /** Whether Continue and Hand to were put under this turn's line, and no press has settled it. */
  waits(turnId: string): boolean {
    return this.offered.has(turnId) && !this.settled.has(turnId);
  }

  settle(turnId: string): void {
    this.settled.add(turnId);
    trim(this.settled);
  }
}

function trim(kept: Map<string, unknown> | Set<string>): void {
  while (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
}

/** Hand to, for each other agent of the room that can be offered: its name on the button, its id in the data. */
export function handToButtons(turnId: string, others: readonly { id: string; name: string }[]): MessageButton[] {
  return others
    .map((other) => ({ label: `Hand to ${other.name}`, data: `${HAND}${turnId}:${other.id}` }))
    .filter((button) => new TextEncoder().encode(button.data).length <= DATA_MAX)
    .slice(0, HAND_TO_SHOWN);
}

/** What the agent picked is given: whose work it was, and what that agent had been asked. */
export function handedOnText(from: string, prompt: string): string {
  return `${from} could not finish this, and it is handed to you. What ${from} was asked:\n\n${prompt}`;
}

/** The line once a press settled it: what it said, and who chose what. */
const settledLine = (line: string, chose: string) => `${line}\n\n${chose}`;

/**
 * A press on Continue under a stopped chain, or on Hand to under handed-over work that ended early. Continue under
 * that work is the same press a long outage's question takes (`resume-ask.ts`).
 */
export function wayOnPresses(deps: {
  ctx: Pick<TurnContext, "waysOn" | "returned" | "handed" | "requeue">;
  turns: Pick<TurnsPort, "get">;
  /** The agent by its id, when it can still take work. */
  agent: (id: string) => LoadedAgent | undefined;
  /** Whether whoever pressed may talk to this agent in this chat. */
  mayAsk: (press: ButtonPress, agent: LoadedAgent) => boolean;
  /** The connection an agent answers through on this platform, and the platform's name. */
  ownGateway: (agentId: string, gatewayId: string) => string;
  platform: (gatewayId: string) => MessageEnvelope["gateway"] | undefined;
  now?: () => number;
}): { owns(data: string): boolean; press(press: ButtonPress): Promise<PressAnswer> } {
  const gone: PressAnswer = { notice: "That is not waiting any more. Tag the agent again if it is still wanted." };
  const notYours: PressAnswer = { notice: "Only someone who may talk to that agent here can say that." };
  const now = () => (deps.now ?? Date.now)();

  const continueChain = (press: ButtonPress): PressAnswer => {
    const key = press.data.slice(CHAIN.length);
    const chain = deps.ctx.waysOn.chain(key);
    const to = chain ? deps.agent(chain.to) : undefined;
    if (!chain || !to || chain.envelope.chatId !== press.chatId) return gone;
    if (!deps.mayAsk(press, to)) return notYours;
    deps.ctx.waysOn.takeChain(key);
    // An agent's hand-over still, its chain begun again: the first exchange of a new count.
    deps.ctx.handed.set(chain.envelope, { from: chain.from, hops: 1, since: now() });
    deps.ctx.returned.set(chain.envelope, chain.to);
    deps.ctx.requeue?.(chain.envelope);
    return { notice: "Carrying on.", settled: settledLine(chain.notice, `Continued by ${press.senderName}.`) };
  };

  const handTo = (press: ButtonPress): PressAnswer => {
    const [turnId = "", toId = ""] = press.data.slice(HAND.length).split(":");
    const turn = deps.turns.get(turnId);
    const to = deps.agent(toId);
    if (!turn || !to || turn.chatId !== press.chatId || !deps.ctx.waysOn.waits(turn.id)) return gone;
    if (!deps.mayAsk(press, to)) return notYours;
    const gatewayId = deps.ownGateway(to.config.id, press.gatewayId);
    const platform = deps.platform(gatewayId);
    if (!platform) return gone;
    deps.ctx.waysOn.settle(turn.id);
    // The person who pressed asks it: their word is what hands the work on, so the turn is theirs to steer and approve.
    const handed: MessageEnvelope = {
      id: `handed:${turn.id}`,
      gateway: platform,
      gatewayId,
      chatId: turn.chatId,
      chatType: press.chatType,
      senderId: press.senderId,
      senderName: press.senderName,
      text: handedOnText(turn.agentId, turn.prompt),
      timestamp: now(),
      raw: null,
    };
    deps.ctx.returned.set(handed, to.config.id);
    deps.ctx.requeue?.(handed);
    const name = to.config.displayName || to.config.id;
    return { notice: `Handed to ${name}.`, settled: settledLine(turn.reply, `Handed to ${name} by ${press.senderName}.`) };
  };

  return {
    owns: (data) => data.startsWith(CHAIN) || data.startsWith(HAND),
    press: async (press) => (press.data.startsWith(CHAIN) ? continueChain(press) : handTo(press)),
  };
}
